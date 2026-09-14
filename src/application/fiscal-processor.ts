import { randomUUID } from 'node:crypto';
import type { InvoiceIssuedPayload, InvoiceVoidedPayload } from '../domain/types.js';
import { documentTypeOf } from '../domain/types.js';
import { FiscalValidationError } from '../domain/errors.js';
import { validateInvoiceForSri } from '../domain/invoice-validation.js';
import { buildAccessKey, numericCodeFor } from '../domain/access-key.js';
import { buildInvoiceXml } from '../domain/invoice-xml-builder.js';
import { buildCreditNoteXml } from '../domain/credit-note-xml-builder.js';
import { ecuadorToday } from '../domain/ecuador-time.js';
import { describeMessages, isAlreadyReceived, SriUnavailableError } from '../infrastructure/http/sri-client.js';
import type {
  FiscalEvent,
  FiscalInvoiceRecord,
  FiscalProcessorDeps,
  SigningCertificate,
} from './ports.js';

/**
 * Cuándo se vuelve a mirar una factura. Antes era "cada 2 minutos, las 10
 * primeras que salgan", sin orden: con más de 10 facturas en espera, algunas no
 * se consultaban nunca, y las que sí, se consultaban igual de seguido a la hora
 * que al minuto.
 */
export const RETRY_POLICY = {
  /** Primera consulta de autorización tras una recepción correcta. */
  firstAuthorizationCheckMs: 15_000,
  baseDelayMs: 60_000,
  maxDelayMs: 60 * 60_000,
  /** Consultas de autorización antes de pedir ayuda (~26 h con el tope de 1 h). */
  maxAuthorizationChecks: 30,
  /** Intentos de envío ante fallos de red o del SRI antes de pedir ayuda. */
  maxDeliveryAttempts: 10,
  /** Un `pending` más viejo que esto es un proceso que murió a mitad de envío. */
  stalePendingMs: 10 * 60_000,
};

export function backoffDelayMs(attempt: number): number {
  return Math.min(RETRY_POLICY.maxDelayMs, RETRY_POLICY.baseDelayMs * 2 ** Math.max(0, attempt));
}

/** Estados en los que el comprobante ya está en manos del SRI o terminado. */
const SETTLED = new Set(['sent', 'authorized', 'rejected']);

export class FiscalInvoiceProcessor {
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly log: Pick<Console, 'log' | 'warn' | 'error'>;

  constructor(private readonly deps: FiscalProcessorDeps) {
    this.now = deps.now ?? (() => new Date());
    this.newId = deps.newId ?? randomUUID;
    this.log = deps.log ?? console;
  }

  /**
   * Emite ante el SRI una factura de billing. Es idempotente: si ya se envió o
   * terminó, no hace nada; si quedó en error o a medias, reutiliza el mismo
   * registro y la misma clave de acceso.
   *
   * `manual` es un reintento pedido por una persona: reinicia la cuenta de
   * intentos automáticos.
   */
  async processIssued(payload: InvoiceIssuedPayload, options: { manual?: boolean } = {}): Promise<FiscalInvoiceRecord | null> {
    if (payload.countryCode !== 'EC') {
      // Por diseño: el exchange es compartido y este servicio solo emite para Ecuador.
      this.log.log(`[fiscal-ecuador] Factura ${payload.number} de ${payload.countryCode}: no es de Ecuador, se ignora`);
      return null;
    }

    let record = await this.deps.store.findByBillingInvoiceId(payload.invoiceId);
    if (record?.billing_voided_at) {
      this.log.log(`[fiscal-ecuador] Factura ${payload.number} anulada en billing: no se envía al SRI`);
      return record;
    }
    if (record && SETTLED.has(record.status)) {
      this.log.log(`[fiscal-ecuador] Factura ${payload.number} ya procesada (status=${record.status})`);
      return record;
    }

    record ??= this.newRecord(payload);
    record.original_payload = payload;
    if (options.manual) record.retry_count = 0;

    try {
      return await this.emit(record, payload);
    } catch (err) {
      return this.fail(record, err);
    }
  }

  private async emit(record: FiscalInvoiceRecord, payload: InvoiceIssuedPayload): Promise<FiscalInvoiceRecord> {
    const { deps } = this;

    validateInvoiceForSri(payload);
    const issuer = payload.issuerSnapshot!;
    if (!issuer.establishmentCode || !issuer.emissionPointCode) {
      throw new FiscalValidationError('La factura no trae el código de establecimiento o de punto de emisión');
    }

    const issueDate = payload.issueDate ? new Date(payload.issueDate) : this.now();
    if (Number.isNaN(issueDate.getTime())) {
      throw new FiscalValidationError(`Fecha de emisión inválida: "${payload.issueDate}"`);
    }

    const docType = documentTypeOf(payload);

    record.access_key = buildAccessKey({
      issueDate,
      documentTypeCode: docType,
      issuerRuc: issuer.taxId,
      environment: deps.environment,
      establishmentCode: issuer.establishmentCode,
      emissionPointCode: issuer.emissionPointCode,
      sequentialNumber: payload.sequentialNumber,
      numericCode: numericCodeFor(payload.invoiceId),
    });

    const duplicate = await deps.store.findOtherWithNumber(payload.organizationId, payload.number, docType, payload.invoiceId);
    if (duplicate) {
      throw new FiscalValidationError(
        `El número ${payload.number} ya pertenece a otro comprobante del mismo tipo (${duplicate.billing_invoice_id}): el secuencial se reutilizó`,
      );
    }

    // Una nota de crédito necesita la factura que modifica: sin ella no hay a qué
    // acreditar los valores. El original pudo haber llegado por un evento anterior;
    // fiscal es quien tiene su clave de acceso.
    let modified: { documentType: string; number: string; issueDate: string } | undefined;
    if (docType === '04') {
      this.validateCreditNoteRefs(payload);
      const original = await deps.store.findByBillingInvoiceId(payload.relatedInvoiceId!);
      if (!original) {
        throw new FiscalValidationError('La factura que modifica esta nota de crédito no tiene comprobante fiscal en este sistema');
      }
      if (!original.access_key) {
        throw new FiscalValidationError('La factura que modifica esta nota de crédito aún no tiene clave de acceso: todavía no se envió al SRI');
      }
      const originalIssueDate = payload.relatedIssueDate ?? (original.original_payload?.issueDate as string | undefined) ?? null;
      if (!originalIssueDate) {
        throw new FiscalValidationError('La nota de crédito no indica la fecha de emisión del comprobante que modifica');
      }
      modified = {
        documentType: original.document_type ?? '01',
        // El esquema del SRI pide el NÚMERO del comprobante modificado (ddd-ddd-ddddddddd), no su clave de acceso.
        number: original.number,
        issueDate: originalIssueDate,
      };
    }

    const certificate = await this.pickCertificate(payload.organizationId);
    const p12 = await deps.documents.download(certificate.p12FileId);
    if (p12.length === 0) throw new Error('El archivo del certificado está vacío');

    let password: string;
    try {
      password = deps.decryptPassword(certificate.passwordEncrypted);
    } catch {
      throw new FiscalValidationError('No se pudo descifrar la contraseña del certificado: vuelve a subirlo');
    }

    // El código del tipo de identificación viene en la foto del cliente. El id
    // es del catálogo de customer-service y no coincide con el de tax-service:
    // buscarlo ahí solo sirve para facturas anteriores que no traen el código.
    const customer = payload.customerSnapshot;
    const [taxCodeById, identificationTypeCode, issuerProfile] = await Promise.all([
      deps.catalogs.taxCodesById('EC'),
      customer?.identificationTypeCode
        ? Promise.resolve(customer.identificationTypeCode)
        : customer?.identificationTypeId
          ? deps.catalogs.identificationTypeCode('EC', customer.identificationTypeId)
          : Promise.resolve(undefined),
      deps.catalogs.issuerProfile(payload.organizationId),
    ]);

    const unsignedXml = docType === '04'
      ? buildCreditNoteXml({
          payload,
          accessKey: record.access_key,
          environment: deps.environment,
          issueDate,
          establishmentCode: issuer.establishmentCode,
          emissionPointCode: issuer.emissionPointCode,
          sequentialNumber: payload.sequentialNumber,
          taxCodeById,
          identificationTypeCode,
          issuerProfile,
          modified: modified!,
        })
      : buildInvoiceXml({
          payload,
          accessKey: record.access_key,
          environment: deps.environment,
          issueDate,
          establishmentCode: issuer.establishmentCode,
          emissionPointCode: issuer.emissionPointCode,
          sequentialNumber: payload.sequentialNumber,
          taxCodeById,
          identificationTypeCode,
          issuerProfile,
        });

    let signedXml: string;
    try {
      signedXml = deps.signer.sign(unsignedXml, p12, password).signedXml;
    } catch (err) {
      // Un .p12 que no firma no se arregla reintentando.
      throw new FiscalValidationError(`Error de firma: ${(err as Error).message}`);
    }

    try {
      record.signed_xml_file_id = await deps.documents.upload({
        resourceType: 'fiscal_invoice',
        organizationId: payload.organizationId,
        resourceId: payload.invoiceId,
        category: 'comprobante-firmado',
        originalName: `${docType === '04' ? 'nota-credito' : 'factura'}-${payload.number}-firmado.xml`,
        mimeType: 'application/xml',
        buffer: Buffer.from(signedXml, 'utf-8'),
      });
    } catch (err) {
      // No bloquea: el comprobante legal es el autorizado, que se guarda después.
      this.log.warn(`[fiscal-ecuador] No se pudo guardar el XML firmado de ${payload.number}: ${(err as Error).message}`);
    }

    record.status = 'pending';
    record.last_error = null;
    record.next_check_at = null;
    record.updated_at = this.now();
    await deps.store.save(record);

    const reception = await deps.sri.send(signedXml);
    record.sri_response = reception;
    record.updated_at = this.now();

    if (reception.estado === 'RECIBIDA' || isAlreadyReceived(reception)) {
      record.status = 'sent';
      record.retry_count = 0;
      record.next_check_at = new Date(this.now().getTime() + RETRY_POLICY.firstAuthorizationCheckMs);
      const message = reception.estado === 'RECIBIDA'
        ? 'Enviada al SRI, esperando autorización'
        : 'El SRI ya tenía este comprobante; se consulta su autorización';
      await deps.store.save(record, { type: 'sent', message, requiresAttention: false });

      const gap = await this.sequenceGapNote(payload.organizationId, payload.number, docType);
      if (gap) {
        this.log.warn(`[fiscal-ecuador] ${gap}`);
        // Solo auditoría: los huecos se dan de una en una y no requieren a nadie
        // (el siguiente número ya está en uso). El aviso queda en el registro de
        // eventos para investigar si se repiten.
        await deps.store.save(record, { type: 'sequence_gap', message: gap, requiresAttention: false });
      }

      return record;
    }

    record.status = 'rejected';
    record.next_check_at = null;
    record.last_error = describeMessages(reception.mensajes, 'Devuelta por el SRI sin mensaje');
    await deps.store.save(record, { type: 'rejected', message: record.last_error, requiresAttention: true });
    return record;
  }

  private async fail(record: FiscalInvoiceRecord, err: unknown): Promise<FiscalInvoiceRecord> {
    const message = err instanceof Error ? err.message : String(err);
    const permanent = err instanceof FiscalValidationError;
    const now = this.now();

    record.status = 'error';
    record.updated_at = now;

    let event: FiscalEvent;
    if (permanent) {
      record.last_error = message;
      record.next_check_at = null;
      event = { type: 'error', message, requiresAttention: true };
    } else {
      record.retry_count += 1;
      if (record.retry_count >= RETRY_POLICY.maxDeliveryAttempts) {
        record.last_error = `${message} (se dejó de reintentar tras ${record.retry_count} intentos)`;
        record.next_check_at = null;
        event = { type: 'error', message: record.last_error, requiresAttention: true };
      } else {
        record.last_error = message;
        record.next_check_at = new Date(now.getTime() + backoffDelayMs(record.retry_count - 1));
        event = { type: 'error', message: `${message}; se reintentará automáticamente`, requiresAttention: false };
      }
    }

    this.log.error(`[fiscal-ecuador] Factura ${record.number} en error: ${record.last_error}`);
    await this.deps.store.save(record, event);
    return record;
  }

  /**
   * El certificado con el que firmar hoy. Antes se tomaba el último subido sin
   * mirar fechas: un .p12 vencido firmaba igual y el SRI rechazaba por firma.
   */
  private async pickCertificate(organizationId: string): Promise<SigningCertificate> {
    const today = ecuadorToday(this.now());
    const active = await this.deps.certificates.listActive(organizationId);

    const expired = active.filter((c) => c.validUntil < today);
    if (expired.length) await this.deps.certificates.markExpired(expired.map((c) => c.id));

    const usable = active.filter((c) => c.validFrom <= today && c.validUntil >= today);
    if (usable.length) return usable[0];

    if (expired.length) {
      throw new FiscalValidationError(`El certificado de firma venció el ${expired[0].validUntil}: sube uno vigente`);
    }
    if (active.length) {
      throw new FiscalValidationError(`El certificado de firma no es válido hasta el ${active[0].validFrom}`);
    }
    throw new FiscalValidationError('Sin certificado de firma activo: sube el archivo .p12 de la firma electrónica');
  }

  /**
   * ¿El secuencial del mismo establecimiento/punto y tipo de documento saltó sin
   * explicación? Los números salen de billing, uno por cada emisión: si este es
   * más de uno que el anterior y algún número intermedio no tiene comprobante
   * alguno (ni siquiera anulado o fallido), algo pasó — un evento perdido, un
   * secuencial quemado a mano. Las series de facturas (01) y de notas de crédito
   * (04) comparten el formato de número pero son cuentas distintas en billing;
   * comparar solo dentro del tipo evita falsos huecos. Solo se avisa; el número
   * ya está consumido. Ver ports.ts.
   */
  private async sequenceGapNote(organizationId: string, number: string, documentType: string): Promise<string | null> {
    const prev = await this.deps.store.findLatestBefore(organizationId, number, documentType);
    if (!prev) return null;

    const seqOf = (n: string): number => {
      const m = /^(\d{3})-(\d{3})-(\d{9})$/.exec(n);
      return m ? Number(m[3]) : Number.NaN;
    };
    const from = seqOf(prev.number);
    const to = seqOf(number);
    if (!Number.isFinite(from) || !Number.isFinite(to) || to - from <= 1) return null;

    const inBetween = await this.deps.store.findBetween(organizationId, prev.number, number, documentType);
    const missing = to - from - 1 - inBetween.length;
    if (missing <= 0) return null;

    return `Secuencial ${prev.number} → ${number}: se saltaron ${missing} número(s) de la serie sin comprobante que lo explique`;
  }

  /** La referencia al comprobante que una nota de crédito modifica y su motivo. */
  private validateCreditNoteRefs(payload: InvoiceIssuedPayload): void {
    if (!payload.relatedInvoiceId) {
      throw new FiscalValidationError('La nota de crédito no indica la factura que modifica (relatedInvoiceId)');
    }
    if (!payload.creditNoteReason?.trim()) {
      throw new FiscalValidationError('El motivo de la nota de crédito no puede estar vacío');
    }
  }

  /** Consulta la autorización de una factura ya recibida por el SRI. */
  async checkAuthorization(record: FiscalInvoiceRecord): Promise<FiscalInvoiceRecord> {
    const { deps } = this;
    if (!record.access_key) {
      return this.fail(record, new FiscalValidationError('Factura enviada sin clave de acceso registrada'));
    }

    let outcome: { state: 'AUTORIZADO' | 'NO AUTORIZADO' | 'EN PROCESAMIENTO'; note?: string };
    let auth: Awaited<ReturnType<typeof deps.sri.query>> | undefined;
    try {
      auth = await deps.sri.query(record.access_key);
      outcome = { state: auth.estado };
    } catch (err) {
      if (!(err instanceof SriUnavailableError)) throw err;
      outcome = { state: 'EN PROCESAMIENTO', note: err.message };
    }

    const now = this.now();
    record.updated_at = now;

    if (outcome.state === 'AUTORIZADO' && auth) {
      record.status = 'authorized';
      record.authorization_number = auth.numeroAutorizacion ?? record.access_key;
      record.authorization_date = auth.fechaAutorizacion ? new Date(auth.fechaAutorizacion) : now;
      record.last_error = null;
      record.next_check_at = null;

      const { xmlAutorizado, ...summary } = auth;
      record.sri_response = summary;
      if (xmlAutorizado) {
        try {
          record.authorized_xml_file_id = await deps.documents.upload({
            resourceType: 'fiscal_invoice',
            organizationId: record.organization_id,
            resourceId: record.billing_invoice_id,
            category: 'comprobante-autorizado',
            originalName: `factura-${record.number}-autorizado.xml`,
            mimeType: 'application/xml',
            buffer: Buffer.from(xmlAutorizado, 'utf-8'),
          });
        } catch (err) {
          // Es el comprobante legal: si no se pudo guardar como archivo, no se pierde.
          this.log.error(`[fiscal-ecuador] No se pudo guardar el XML autorizado de ${record.number}: ${(err as Error).message}`);
          record.sri_response = { ...summary, xmlAutorizado };
        }
      }

      const voided = Boolean(record.billing_voided_at);
      await deps.store.save(record, {
        type: 'authorized',
        message: voided
          ? `Autorizada #${record.authorization_number}, pero la factura está anulada en el sistema: emite una nota de crédito o anúlala en SRI en línea`
          : `Autorizada #${record.authorization_number}`,
        requiresAttention: voided,
      });
      return record;
    }

    if (outcome.state === 'NO AUTORIZADO' && auth) {
      record.status = 'rejected';
      record.next_check_at = null;
      record.sri_response = auth;
      record.last_error = describeMessages(auth.mensajes, 'No autorizada por el SRI');
      await deps.store.save(record, { type: 'rejected', message: record.last_error, requiresAttention: true });
      return record;
    }

    record.retry_count += 1;
    if (record.retry_count >= RETRY_POLICY.maxAuthorizationChecks) {
      record.status = 'error';
      record.next_check_at = null;
      record.last_error =
        `El SRI no confirmó la autorización tras ${record.retry_count} consultas` + (outcome.note ? ` (${outcome.note})` : '');
      await deps.store.save(record, { type: 'error', message: record.last_error, requiresAttention: true });
      return record;
    }

    record.next_check_at = new Date(now.getTime() + backoffDelayMs(record.retry_count));
    if (outcome.note) record.last_error = outcome.note;
    await deps.store.save(record);
    return record;
  }

  /**
   * Trabajo pendiente: autorizaciones por consultar, errores de red por
   * reintentar y envíos que se quedaron a medias porque el proceso murió.
   */
  async runDueWork(limit = 20): Promise<{ authorizations: number; retries: number; stale: number }> {
    const now = this.now();
    const { store } = this.deps;

    const sent = await store.findDue('sent', now, limit);
    for (const record of sent) await this.safely(record, () => this.checkAuthorization(record));

    const errors = await store.findDue('error', now, limit);
    for (const record of errors) {
      if (!record.original_payload) continue;
      await this.safely(record, () => this.processIssued(record.original_payload!));
    }

    const stale = await store.findStalePending(new Date(now.getTime() - RETRY_POLICY.stalePendingMs), limit);
    for (const record of stale) {
      if (!record.original_payload) continue;
      await this.safely(record, () => this.processIssued(record.original_payload!));
    }

    return { authorizations: sent.length, retries: errors.length, stale: stale.length };
  }

  private async safely(record: FiscalInvoiceRecord, work: () => Promise<unknown>): Promise<void> {
    try {
      await work();
    } catch (err) {
      this.log.error(`[fiscal-ecuador] Falló el trabajo pendiente de ${record.number}: ${(err as Error).message}`);
    }
  }

  /**
   * Billing anuló una factura. Anular en el sistema no anula ante el SRI: si ya
   * está autorizada hace falta una nota de crédito (o la anulación en SRI en
   * línea), y eso lo tiene que saber alguien. Si todavía no se envió, no se envía.
   */
  async processVoided(payload: InvoiceVoidedPayload): Promise<FiscalInvoiceRecord | null> {
    const record = await this.deps.store.findByBillingInvoiceId(payload.invoiceId);
    if (!record) {
      this.log.log(`[fiscal-ecuador] Anulación de ${payload.number}: no tiene comprobante fiscal (no es de Ecuador o nunca se procesó)`);
      return null;
    }
    if (record.billing_voided_at) return record;

    const now = this.now();
    record.billing_voided_at = payload.voidedAt ? new Date(payload.voidedAt) : now;
    record.updated_at = now;

    let event: FiscalEvent;
    if (record.status === 'authorized') {
      event = {
        type: 'void_requires_action',
        message: `La factura ${record.number} ya está autorizada por el SRI. Anularla en el sistema no la anula ante el SRI: emite una nota de crédito o solicita la anulación en SRI en línea.`,
        requiresAttention: true,
      };
    } else if (record.status === 'sent' || record.status === 'pending') {
      // Se sigue consultando: hay que saber si acaba autorizada.
      event = {
        type: 'void_requires_action',
        message: `La factura ${record.number} se anuló mientras el SRI la procesaba. Si llega a autorizarse, habrá que emitir una nota de crédito o anularla en SRI en línea.`,
        requiresAttention: true,
      };
    } else {
      record.next_check_at = null;
      event = {
        type: 'void_requires_action',
        message: `La factura ${record.number} se anuló antes de autorizarse: no se enviará al SRI.`,
        requiresAttention: false,
      };
    }

    await this.deps.store.save(record, event);
    return record;
  }

  private newRecord(payload: InvoiceIssuedPayload): FiscalInvoiceRecord {
    const now = this.now();
    return {
      id: this.newId(),
      organization_id: payload.organizationId,
      billing_invoice_id: payload.invoiceId,
      document_type: documentTypeOf(payload),
      number: payload.number,
      access_key: null,
      status: 'pending',
      authorization_number: null,
      authorization_date: null,
      sri_response: null,
      signed_xml_file_id: null,
      authorized_xml_file_id: null,
      retry_count: 0,
      last_error: null,
      original_payload: payload,
      next_check_at: null,
      billing_voided_at: null,
      created_at: now,
      updated_at: now,
    };
  }
}

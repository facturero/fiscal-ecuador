import { randomUUID } from 'node:crypto';
import { Op, QueryTypes, Transaction } from 'sequelize';
import { sequelize } from './sequelize.js';
import { CertificateModel, FiscalInvoiceModel, OutboxModel } from './models.js';
import type {
  CertificateStore,
  DirectDocumentStore,
  FiscalEvent,
  FiscalInvoiceRecord,
  FiscalInvoiceStore,
  FiscalStatus,
  SigningCertificate,
  StoredPayload,
} from '../../application/ports.js';
import type { DirectDocumentType, WithholdingPayload } from '../../domain/direct-documents.js';

/** Aviso para la campana: una factura fiscal necesita que alguien actúe. */
export const ATTENTION_EVENT = 'fiscal.ec.invoice.attention_required';

function toRecord(model: FiscalInvoiceModel): FiscalInvoiceRecord {
  const v = model.get({ plain: true }) as Record<string, unknown>;
  return {
    ...(v as unknown as FiscalInvoiceRecord),
    original_payload: (v.original_payload as StoredPayload | null) ?? null,
  };
}

export class SequelizeFiscalInvoiceStore implements FiscalInvoiceStore {
  /** El relay publica el outbox al momento del commit; se engancha desde main. */
  private onCommit: ((tx: Transaction) => void) | undefined;

  setOnCommit(fn: (tx: Transaction) => void): void {
    this.onCommit = fn;
  }

  async findByBillingInvoiceId(billingInvoiceId: string): Promise<FiscalInvoiceRecord | null> {
    const row = await FiscalInvoiceModel.findOne({ where: { billing_invoice_id: billingInvoiceId } });
    return row ? toRecord(row) : null;
  }

  async findOtherWithNumber(organizationId: string, number: string, documentType: string, billingInvoiceId: string): Promise<FiscalInvoiceRecord | null> {
    const row = await FiscalInvoiceModel.findOne({
      where: { organization_id: organizationId, number, document_type: documentType, billing_invoice_id: { [Op.ne]: billingInvoiceId } },
    });
    return row ? toRecord(row) : null;
  }

  async findLatestBefore(organizationId: string, number: string, documentType: string): Promise<FiscalInvoiceRecord | null> {
    // El prefijo (establecimiento-punto) va delante del secuencial: comparar
    // cadenas del mismo prefijo es comparar secuenciales. El LIKE evita saltar
    // entre puntos de emisión distintos de la misma organización, y el tipo evita
    // cruzar series de facturas con notas de crédito que comparten numeración.
    const prefix = number.slice(0, 8);
    const row = await FiscalInvoiceModel.findOne({
      where: {
        organization_id: organizationId,
        document_type: documentType,
        number: { [Op.like]: `${prefix}%`, [Op.lt]: number },
      },
      order: [['number', 'DESC']],
    });
    return row ? toRecord(row) : null;
  }

  async findBetween(organizationId: string, fromNumber: string, toNumber: string, documentType: string): Promise<FiscalInvoiceRecord[]> {
    const rows = await FiscalInvoiceModel.findAll({
      where: {
        organization_id: organizationId,
        document_type: documentType,
        number: { [Op.gt]: fromNumber, [Op.lt]: toNumber },
      },
    });
    return rows.map(toRecord);
  }

  /**
   * Registro y evento en una sola transacción: si el proceso muere entre las
   * dos escrituras no queda un estado sin evento ni al revés.
   *
   * Insert o update explícito por id, y NO `upsert`. En MySQL `upsert` es
   * `INSERT ... ON DUPLICATE KEY UPDATE`, que salta con CUALQUIER índice único:
   * una factura nueva con un número ya usado reemplazaba entera la fila de la
   * otra factura (id incluido) sin dar error. Lo encontró el test de
   * integración contra MySQL; con dobles en memoria no se ve.
   */
  async save(record: FiscalInvoiceRecord, event?: FiscalEvent): Promise<void> {
    await sequelize.transaction(async (transaction) => {
      // El relay publica el outbox justo tras el commit; sin este enganche los
      // eventos fiscales esperan los 30s del timer de respaldo del relay.
      this.onCommit?.(transaction);
      const { id, ...fields } = record;
      const [updated] = await FiscalInvoiceModel.update(fields as never, { where: { id }, transaction });
      if (updated === 0) {
        const exists = await FiscalInvoiceModel.count({ where: { id }, transaction });
        // MySQL cuenta como 0 filas afectadas un UPDATE sin cambios reales.
        if (!exists) await FiscalInvoiceModel.create(record as never, { transaction });
      }
      if (!event) return;
      const payload = {
        fiscalInvoiceId: record.id,
        billingInvoiceId: record.billing_invoice_id,
        // Mismo nombre que en billing.invoice.*: la campana enlaza con él a la factura.
        invoiceId: record.billing_invoice_id,
        organizationId: record.organization_id,
        number: record.number,
        status: record.status,
        type: event.type,
        message: event.message,
        requiresAttention: event.requiresAttention,
        // Sin destinatario el gateway descarta el evento y la campana no suena.
        ...(record.original_payload?.userId ? { userId: record.original_payload.userId } : {}),
      };
      const rows: Array<{ type: string; payload: Record<string, unknown> }> = [{ type: `fiscal.ec.invoice.${event.type}`, payload }];
      // Un aviso aparte, y solo cuando hace falta una persona: los errores que
      // se reintentan solos no deben llenar la campana. Es el evento al que
      // están suscritos notification-service y el hub del gateway.
      if (event.requiresAttention) rows.push({ type: ATTENTION_EVENT, payload });
      // Una retención AUTORIZADA es un hecho contable: contabilidad la registra al recibir este evento. Se publica al autorizarse
      // y no al crearse porque hasta entonces el SRI puede rechazarla y no habría tal retención.
      if (event.type === 'authorized' && record.document_type === '07' && record.original_payload) {
        rows.push({ type: WITHHOLDING_ISSUED_EVENT, payload: withholdingIssuedPayload(record, record.original_payload as WithholdingPayload) });
      }
      for (const row of rows) {
        await OutboxModel.create(
          {
            id: randomUUID(),
            aggregate_type: 'fiscal_invoice',
            aggregate_id: record.id,
            type: row.type,
            payload: row.payload,
            occurred_at: new Date(),
            processed_at: null,
          },
          { transaction },
        );
      }
    });
  }

  async findDue(status: FiscalStatus, now: Date, limit: number): Promise<FiscalInvoiceRecord[]> {
    const rows = await FiscalInvoiceModel.findAll({
      where: { status, next_check_at: { [Op.lte]: now } },
      order: [['next_check_at', 'ASC']],
      limit,
    });
    return rows.map(toRecord);
  }

  async findStalePending(updatedBefore: Date, limit: number): Promise<FiscalInvoiceRecord[]> {
    const rows = await FiscalInvoiceModel.findAll({
      where: { status: 'pending', updated_at: { [Op.lt]: updatedBefore }, billing_voided_at: null },
      order: [['updated_at', 'ASC']],
      limit,
    });
    return rows.map(toRecord);
  }
}

/** Retención autorizada por el SRI. Lo consume contabilidad. */
export const WITHHOLDING_ISSUED_EVENT = 'fiscal.ec.withholding.issued';

/**
 * Lo que contabilidad necesita para asentar la retención: cuánto se retuvo de cada impuesto, a quién y de qué compra. No lleva
 * el XML ni los datos de contacto del proveedor.
 */
export function withholdingIssuedPayload(record: FiscalInvoiceRecord, payload: WithholdingPayload): Record<string, unknown> {
  const sum = (tax: 'income' | 'vat' | 'isd') => payload.withholdings.filter((w) => w.tax === tax).reduce((total, w) => total + w.amountCents, 0);
  return {
    withholdingId: payload.invoiceId,
    fiscalInvoiceId: record.id,
    organizationId: record.organization_id,
    number: record.number,
    issueDate: payload.issueDate,
    establishmentId: payload.establishmentId,
    authorizationNumber: record.authorization_number,
    userId: payload.userId,
    currencyCode: 'USD',
    supplier: { identification: payload.subject.identification, businessName: payload.subject.businessName },
    support: { documentCode: payload.support.documentCode, number: payload.support.number, issueDate: payload.support.issueDate },
    incomeTaxWithheldCents: sum('income'),
    vatWithheldCents: sum('vat'),
    isdWithheldCents: sum('isd'),
    totalWithheldCents: payload.totalWithheldCents,
  };
}

/**
 * Numeración y alta de los comprobantes que fiscal emite directamente. El contador y el registro nacen en la misma transacción:
 * si el alta falla, el número no se quema.
 *
 * El incremento es UNA sentencia (`INSERT … ON DUPLICATE KEY UPDATE`): la primera emisión de una serie crea el contador en 1 y
 * las siguientes lo suben, sin carrera entre un SELECT y un UPDATE. Leer después con FOR UPDATE da el valor propio porque la
 * fila ya quedó bloqueada por esta transacción. (Insertar «por si acaso» primero y actualizar después provocó interbloqueos en
 * accounting-service: aquí no se hace.)
 */
export class SequelizeDirectDocumentStore implements DirectDocumentStore {
  async createNumbered(input: Parameters<DirectDocumentStore['createNumbered']>[0]): Promise<FiscalInvoiceRecord> {
    return sequelize.transaction(async (transaction) => {
      const series = {
        organizationId: input.organizationId,
        establishmentCode: input.establishmentCode,
        emissionPointCode: input.emissionPointCode,
        documentType: input.documentType satisfies DirectDocumentType,
      };
      await sequelize.query(
        `INSERT INTO fiscal_sequences (id, organization_id, establishment_code, emission_point_code, document_type, current_value, updated_at)
         VALUES (:id, :organizationId, :establishmentCode, :emissionPointCode, :documentType, 1, :now)
         ON DUPLICATE KEY UPDATE current_value = current_value + 1, updated_at = :now`,
        { replacements: { id: randomUUID(), now: new Date(), ...series }, transaction },
      );
      const [row] = await sequelize.query<{ current_value: number }>(
        `SELECT current_value FROM fiscal_sequences
         WHERE organization_id = :organizationId AND establishment_code = :establishmentCode
           AND emission_point_code = :emissionPointCode AND document_type = :documentType FOR UPDATE`,
        { replacements: series, transaction, type: QueryTypes.SELECT },
      );
      const record = input.build(String(row!.current_value).padStart(9, '0'));
      await FiscalInvoiceModel.create(record as never, { transaction });
      return record;
    });
  }
}

export class SequelizeCertificateStore implements CertificateStore {
  async listActive(organizationId: string): Promise<SigningCertificate[]> {
    const rows = await CertificateModel.findAll({
      where: { organization_id: organizationId, status: 'active' },
      order: [['created_at', 'DESC']],
    });
    return rows.map((c) => ({
      id: c.id,
      p12FileId: c.p12_file_id,
      passwordEncrypted: c.password_encrypted,
      validFrom: String(c.valid_from),
      validUntil: String(c.valid_until),
      status: c.status,
      createdAt: c.created_at,
    }));
  }

  async markExpired(ids: string[]): Promise<void> {
    if (!ids.length) return;
    await CertificateModel.update({ status: 'expired' }, { where: { id: ids, status: 'active' } });
  }
}

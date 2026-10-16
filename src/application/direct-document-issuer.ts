import { randomUUID } from 'node:crypto';
import type { DirectDocumentStore, FiscalInvoiceRecord, IssuerDirectory } from './ports.js';
import type { FiscalInvoiceProcessor } from './fiscal-processor.js';
import { FiscalValidationError } from '../domain/errors.js';
import { ecuadorToday } from '../domain/ecuador-time.js';
import {
  computeWithholdings,
  validateDocumentNumber,
  type DeliveryGuidePayload,
  type DirectDocumentType,
  type DirectPayload,
  type GuideRecipient,
  type PartyIdentificationType,
  type SupportTax,
  type WithholdingLine,
  type WithholdingPayload,
} from '../domain/direct-documents.js';

/** Quién pide la emisión. */
export interface IssueContext {
  organizationId: string;
  userId?: string;
}

export interface WithholdingInput {
  establishmentId: string;
  emissionPointId: string;
  subject: WithholdingPayload['subject'];
  /** `MM/AAAA`. Si falta es el mes de la emisión. */
  fiscalPeriod?: string;
  support: {
    supportCode?: string;
    documentCode?: string;
    number: string;
    issueDate: string;
    authorizationNumber?: string | null;
    totalWithoutTaxesCents: number;
    totalCents: number;
    paymentMethodCode?: string;
    taxes: SupportTax[];
  };
  withholdings: Array<Pick<WithholdingLine, 'tax' | 'retentionCode' | 'baseCents' | 'ratePercent'>>;
}

export interface DeliveryGuideInput {
  establishmentId: string;
  emissionPointId: string;
  /** Si falta, la dirección del establecimiento emisor. */
  originAddress?: string | null;
  carrier: DeliveryGuidePayload['carrier'];
  transportStart: string;
  transportEnd: string;
  recipients: GuideRecipient[];
}

const IDENTIFICATION_PATTERNS: Record<PartyIdentificationType, RegExp> = {
  RUC: /^\d{13}$/,
  CEDULA: /^\d{10}$/,
  PASAPORTE: /^[A-Za-z0-9]{1,20}$/,
  EXTERIOR: /^[A-Za-z0-9]{1,20}$/,
};

function checkIdentification(type: PartyIdentificationType, identification: string, who: string): void {
  if (!IDENTIFICATION_PATTERNS[type].test(identification)) {
    throw new FiscalValidationError(`${who}: la identificación "${identification}" no corresponde a un ${type === 'RUC' ? 'RUC (13 dígitos)' : type === 'CEDULA' ? 'número de cédula (10 dígitos)' : 'documento válido'}`);
  }
}

/**
 * Emite los comprobantes que fiscal numera por su cuenta: retención (07) y guía de remisión (06).
 *
 * Valida los datos, resuelve al emisor, reserva el número junto con el registro (una transacción) y lleva el comprobante al SRI.
 * El envío se hace en la misma petición para que la persona vea el resultado; si el SRI no responde, el registro queda en
 * `error` con reintento automático (o `pending` si el proceso muere a mitad, que el trabajo de reconciliación retoma), así que
 * el comprobante nunca se pierde.
 */
export class DirectDocumentIssuer {
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(
    private readonly deps: {
      issuers: IssuerDirectory;
      store: DirectDocumentStore;
      processor: Pick<FiscalInvoiceProcessor, 'processDirect'>;
      now?: () => Date;
      newId?: () => string;
    },
  ) {
    this.now = deps.now ?? (() => new Date());
    this.newId = deps.newId ?? randomUUID;
  }

  async issueWithholding(ctx: IssueContext, input: WithholdingInput): Promise<FiscalInvoiceRecord> {
    const { subject, support } = input;
    checkIdentification(subject.identificationType, subject.identification, 'Sujeto retenido');
    if (!subject.businessName?.trim()) throw new FiscalValidationError('Falta el nombre o razón social del sujeto retenido');
    validateDocumentNumber(support.number, 'Número del comprobante de sustento');

    const issueDate = this.now();
    const today = ecuadorToday(issueDate);
    if (support.issueDate > today) throw new FiscalValidationError('La fecha del comprobante de sustento no puede ser futura');
    // El periodo fiscal es el mes de la emisión salvo que se indique otro.
    const [year, month] = today.split('-');
    const fiscalPeriod = input.fiscalPeriod ?? `${month}/${year}`;

    const normalizedSupport: WithholdingPayload['support'] = {
      supportCode: support.supportCode ?? '01',
      documentCode: support.documentCode ?? '01',
      number: support.number,
      issueDate: support.issueDate,
      authorizationNumber: support.authorizationNumber?.trim() || null,
      totalWithoutTaxesCents: support.totalWithoutTaxesCents,
      totalCents: support.totalCents,
      paymentMethodCode: support.paymentMethodCode ?? '20',
      taxes: support.taxes,
    };
    const { withholdings, totalWithheldCents } = computeWithholdings(normalizedSupport, input.withholdings);

    return this.create(ctx, '07', input.establishmentId, input.emissionPointId, (issuer, number, sequentialNumber, invoiceId): WithholdingPayload => ({
      invoiceId,
      documentTypeCode: '07',
      organizationId: ctx.organizationId,
      userId: ctx.userId,
      countryCode: 'EC',
      number,
      sequentialNumber,
      establishmentId: input.establishmentId,
      emissionPointId: input.emissionPointId,
      issueDate: issueDate.toISOString(),
      issuerSnapshot: issuer,
      subject: { ...subject, businessName: subject.businessName.trim() },
      fiscalPeriod,
      support: normalizedSupport,
      withholdings,
      totalWithheldCents,
    }));
  }

  async issueDeliveryGuide(ctx: IssueContext, input: DeliveryGuideInput): Promise<FiscalInvoiceRecord> {
    const issueDate = this.now();
    const today = ecuadorToday(issueDate);
    const { carrier } = input;
    checkIdentification(carrier.identificationType, carrier.identification, 'Transportista');
    if (!carrier.businessName?.trim()) throw new FiscalValidationError('Falta el nombre o razón social del transportista');
    if (!carrier.plate?.trim()) throw new FiscalValidationError('Falta la placa del vehículo');
    // La guía ampara un traslado que aún no ocurrió: se emite antes de que salga la mercadería.
    if (input.transportStart < today) throw new FiscalValidationError('El traslado no puede iniciar antes de la fecha de emisión de la guía');
    if (input.transportEnd < input.transportStart) throw new FiscalValidationError('La fecha de fin del traslado no puede ser anterior a la de inicio');
    if (!input.recipients.length) throw new FiscalValidationError('La guía necesita al menos un destinatario');

    input.recipients.forEach((recipient, i) => {
      const who = `Destinatario ${i + 1}`;
      if (!recipient.items.length) throw new FiscalValidationError(`${who}: no lleva ninguna mercadería`);
      for (const item of recipient.items) {
        if (!(item.quantity > 0)) throw new FiscalValidationError(`${who}: la cantidad de "${item.description}" debe ser mayor que cero`);
      }
      if (recipient.support) validateDocumentNumber(recipient.support.number, `${who}: comprobante de sustento`);
    });

    return this.create(ctx, '06', input.establishmentId, input.emissionPointId, (issuer, number, sequentialNumber, invoiceId): DeliveryGuidePayload => {
      const originAddress = input.originAddress?.trim() || issuer.address?.trim();
      if (!originAddress) throw new FiscalValidationError('Falta la dirección de partida: indícala o completa la dirección del establecimiento');
      return {
        invoiceId,
        documentTypeCode: '06',
        organizationId: ctx.organizationId,
        userId: ctx.userId,
        countryCode: 'EC',
        number,
        sequentialNumber,
        establishmentId: input.establishmentId,
        emissionPointId: input.emissionPointId,
        issueDate: issueDate.toISOString(),
        issuerSnapshot: issuer,
        originAddress,
        carrier: { ...carrier, businessName: carrier.businessName.trim(), plate: carrier.plate.trim().toUpperCase() },
        transportStart: input.transportStart,
        transportEnd: input.transportEnd,
        recipients: input.recipients,
      };
    });
  }

  private async create(
    ctx: IssueContext,
    documentType: DirectDocumentType,
    establishmentId: string,
    emissionPointId: string,
    buildPayload: (issuer: Awaited<ReturnType<IssuerDirectory['resolve']>>, number: string, sequentialNumber: string, invoiceId: string) => DirectPayload,
  ): Promise<FiscalInvoiceRecord> {
    const issuer = await this.deps.issuers.resolve(ctx.organizationId, establishmentId, emissionPointId);
    const now = this.now();

    const record = await this.deps.store.createNumbered({
      organizationId: ctx.organizationId,
      establishmentCode: issuer.establishmentCode,
      emissionPointCode: issuer.emissionPointCode,
      documentType,
      build: (sequentialNumber) => {
        const id = this.newId();
        const number = `${issuer.establishmentCode}-${issuer.emissionPointCode}-${sequentialNumber}`;
        return {
          id,
          organization_id: ctx.organizationId,
          // El comprobante no nace de una factura de billing: su id propio ocupa esta columna (ver la migración).
          billing_invoice_id: id,
          document_type: documentType,
          source: 'fiscal',
          number,
          access_key: null,
          status: 'pending',
          authorization_number: null,
          authorization_date: null,
          sri_response: null,
          signed_xml_file_id: null,
          authorized_xml_file_id: null,
          retry_count: 0,
          last_error: null,
          original_payload: buildPayload(issuer, number, sequentialNumber, id),
          next_check_at: null,
          billing_voided_at: null,
          created_at: now,
          updated_at: now,
        };
      },
    });

    return this.deps.processor.processDirect(record);
  }
}

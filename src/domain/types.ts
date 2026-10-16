/** Código SRI del tipo de comprobante. Solo los que este servicio sabe construir. */
export type SriDocumentType = '01' | '04' | '05' | '06' | '07';

/**
 * Código SRI del comprobante que billing emite: factura (01), nota de crédito (04) o nota de débito (05); cualquier otro valor (o
 * la ausencia del campo, que es como venían los eventos antes de las notas de crédito) es una factura. La guía de remisión (06) y
 * la retención (07) NO pasan por billing: las emite este servicio directamente.
 */
export function documentTypeOf(payload: Pick<InvoiceIssuedPayload, 'documentTypeCode'>): SriDocumentType {
  return payload.documentTypeCode === '04' || payload.documentTypeCode === '05' ? payload.documentTypeCode : '01';
}

/** Notas que modifican un comprobante anterior: necesitan su número y su fecha de emisión. */
export function modifiesAnotherDocument(type: SriDocumentType): boolean {
  return type === '04' || type === '05';
}

export interface InvoiceIssuedPayload {
  invoiceId: string;
  number: string;
  sequentialNumber: string;
  /** Código SRI del tipo de comprobante (`01` factura, `04` nota de crédito, `05` nota de débito). Factura si falta. */
  documentTypeCode?: '01' | '04' | '05';
  /**
   * Nota de crédito o de débito: id de billing de la factura que se modifica. La clave de
   * acceso del comprobante original la resuelve fiscal (fue él quien la generó);
   * billing no la conoce.
   */
  relatedInvoiceId?: string | null;
  /** Fecha de emisión del comprobante que se modifica (`fechaEmisionDocSustento`). */
  relatedIssueDate?: string | null;
  /**
   * Motivo de la nota de crédito, tal como exige el SRI. vacío no es un motivo.
   */
  creditNoteReason?: string | null;
  /**
   * Momento de emisión en billing (ISO). Es la fecha legal del comprobante; los
   * eventos anteriores no la traían y se cae a la hora de procesamiento.
   */
  issueDate?: string | null;
  /** Código SRI de forma de pago (Tabla 24). Si falta, sale de la organización o `01`. */
  paymentMethodCode?: string | null;
  organizationId: string;
  /** Quien emitió; viaja en los eventos fiscales para que la campana sepa a quién avisar. */
  userId?: string;
  countryCode: string;
  establishmentId: string;
  emissionPointId: string;
  customerSnapshot: {
    id: string;
    businessName: string;
    identification: string;
    identificationTypeId: string;
    /** RUC, CEDULA, PASAPORTE... Lo manda billing desde que customer-service lo expone. */
    identificationTypeCode?: string | null;
    email?: string | null;
    phone?: string | null;
    type: 'person' | 'company';
    taxClassification?: string | null;
  } | null;
  issuerSnapshot: {
    legalName: string;
    tradeName?: string | null;
    taxId: string;
    establishmentCode?: string;
    emissionPointCode?: string;
    address?: string | null;
  } | null;
  subtotalCents: number;
  taxTotalCents: number;
  totalCents: number;
  currencyCode: string;
  lines: Array<{
    productId: string;
    /** SKU del producto; es lo que va en `codigoPrincipal` cuando existe. */
    productCode?: string | null;
    description: string;
    quantity: number;
    unitPriceCents: number;
    discountCents: number;
    subtotalCents: number;
    taxes: Array<{
      taxRateId: string;
      kind: string;
      rateSnapshot: string;
      baseCents: number;
      amountCents: number;
    }>;
  }>;
}

/** `billing.invoice.voided`. */
export interface InvoiceVoidedPayload {
  invoiceId: string;
  number: string;
  organizationId: string;
  reason?: string | null;
  voidedAt?: string | null;
  userId?: string;
}

export interface CertificateInfo {
  id: string;
  alias: string;
  p12FileId: string;
  passwordEncrypted: string;
  validFrom: string;
  validUntil: string;
}

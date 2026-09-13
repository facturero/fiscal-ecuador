export interface InvoiceIssuedPayload {
  invoiceId: string;
  number: string;
  sequentialNumber: string;
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

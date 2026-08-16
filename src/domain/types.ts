export interface InvoiceIssuedPayload {
  invoiceId: string;
  number: string;
  sequentialNumber: string;
  organizationId: string;
  countryCode: string;
  establishmentId: string;
  emissionPointId: string;
  customerSnapshot: {
    id: string;
    businessName: string;
    identification: string;
    identificationTypeId: string;
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

export interface CertificateInfo {
  id: string;
  alias: string;
  p12FileId: string;
  passwordEncrypted: string;
  validFrom: string;
  validUntil: string;
}

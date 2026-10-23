import type { WithholdingPayload } from '../domain/direct-documents.js';
import type { FiscalInvoiceRecord } from './ports.js';

/** Retención autorizada por el SRI. Lo consume contabilidad. */
export const WITHHOLDING_ISSUED_EVENT = 'fiscal.ec.withholding.issued';

/**
 * Lo que contabilidad necesita para asentar la retención: cuánto se retuvo de cada impuesto, a quién y de qué compra. No lleva
 * el XML ni los datos de contacto del proveedor.
 */
export function withholdingIssuedPayload(
  record: Pick<FiscalInvoiceRecord, 'id' | 'organization_id' | 'number' | 'authorization_number'>,
  payload: WithholdingPayload,
): Record<string, unknown> {
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
    // Para los anexos del SRI (ATS, 103 y 104) hace falta el detalle, no solo el total por impuesto: los anexos se
    // declaran por concepto (código de retención) y por periodo fiscal. Los nombres son los del dominio, sin traducir.
    fiscalPeriod: payload.fiscalPeriod,
    supplier: {
      identificationType: payload.subject.identificationType,
      identification: payload.subject.identification,
      businessName: payload.subject.businessName,
    },
    support: {
      documentCode: payload.support.documentCode,
      number: payload.support.number,
      issueDate: payload.support.issueDate,
      supportCode: payload.support.supportCode,
      authorizationNumber: payload.support.authorizationNumber ?? null,
    },
    lines: payload.withholdings.map((w) => ({
      tax: w.tax,
      retentionCode: w.retentionCode,
      baseCents: w.baseCents,
      ratePercent: w.ratePercent,
      amountCents: w.amountCents,
    })),
    incomeTaxWithheldCents: sum('income'),
    vatWithheldCents: sum('vat'),
    isdWithheldCents: sum('isd'),
    totalWithheldCents: payload.totalWithheldCents,
  };
}

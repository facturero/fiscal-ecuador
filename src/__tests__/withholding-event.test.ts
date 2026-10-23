import { describe, expect, it } from 'vitest';
import { WITHHOLDING_ISSUED_EVENT, withholdingIssuedPayload } from '../application/withholding-event.js';
import type { WithholdingPayload } from '../domain/direct-documents.js';

// El evento `fiscal.ec.withholding.issued` lo consumen contabilidad, tesorería, compras y reporting-service (anexos del SRI).
// Estos campos son su contrato: si cambian de nombre, los consumidores dejan de ver el detalle sin que nada falle.
const record = { id: 'fiscal-1', organization_id: 'org-1', number: '001-001-000000007', authorization_number: '1209202607179001234500110010010000000071234567818' };

const payload = {
  invoiceId: 'ret-1',
  documentTypeCode: '07',
  number: '001-001-000000007',
  issueDate: '2026-10-20T15:00:00.000Z',
  establishmentId: 'est-1',
  userId: 'user-1',
  fiscalPeriod: '10/2026',
  totalWithheldCents: 5_50,
  subject: { identificationType: 'RUC', identification: '1790012345001', businessName: 'Proveedor Andino', relatedParty: false },
  support: {
    supportCode: '01',
    documentCode: '01',
    number: '002-003-000004567',
    issueDate: '2026-10-12',
    authorizationNumber: '1209202601179001234500120020030000045671234567815',
    totalWithoutTaxesCents: 100_00,
    totalCents: 115_00,
    paymentMethodCode: '20',
    taxes: [],
  },
  withholdings: [
    { tax: 'income', retentionCode: '312', baseCents: 100_00, ratePercent: 1, amountCents: 1_00 },
    { tax: 'vat', retentionCode: '1', baseCents: 15_00, ratePercent: 30, amountCents: 4_50 },
  ],
} as unknown as WithholdingPayload;

describe('payload de fiscal.ec.withholding.issued', () => {
  it('lleva el evento con su nombre contractual', () => {
    expect(WITHHOLDING_ISSUED_EVENT).toBe('fiscal.ec.withholding.issued');
  });

  it('trae el detalle por línea (concepto, base, porcentaje, valor) además de los totales por impuesto', () => {
    const p = withholdingIssuedPayload(record, payload) as Record<string, unknown>;
    expect(p.lines).toEqual([
      { tax: 'income', retentionCode: '312', baseCents: 100_00, ratePercent: 1, amountCents: 1_00 },
      { tax: 'vat', retentionCode: '1', baseCents: 15_00, ratePercent: 30, amountCents: 4_50 },
    ]);
    expect(p).toMatchObject({ incomeTaxWithheldCents: 1_00, vatWithheldCents: 4_50, isdWithheldCents: 0, totalWithheldCents: 5_50 });
  });

  it('trae el periodo fiscal, el tipo de identificación del proveedor y el sustento (código, comprobante y autorización)', () => {
    const p = withholdingIssuedPayload(record, payload) as Record<string, any>;
    expect(p.fiscalPeriod).toBe('10/2026');
    expect(p.supplier).toEqual({ identificationType: 'RUC', identification: '1790012345001', businessName: 'Proveedor Andino' });
    expect(p.support).toEqual({
      documentCode: '01',
      number: '002-003-000004567',
      issueDate: '2026-10-12',
      supportCode: '01',
      authorizationNumber: '1209202601179001234500120020030000045671234567815',
    });
  });

  it('conserva lo que ya consumían los demás servicios (no se quitó nada)', () => {
    const p = withholdingIssuedPayload(record, payload) as Record<string, unknown>;
    expect(p).toMatchObject({
      withholdingId: 'ret-1',
      fiscalInvoiceId: 'fiscal-1',
      organizationId: 'org-1',
      number: '001-001-000000007',
      authorizationNumber: record.authorization_number,
      currencyCode: 'USD',
      issueDate: '2026-10-20T15:00:00.000Z',
    });
  });

  it('si el sustento no trae autorización, viaja null (no se inventa)', () => {
    const sinAut = { ...payload, support: { ...payload.support, authorizationNumber: undefined } } as unknown as WithholdingPayload;
    const p = withholdingIssuedPayload(record, sinAut) as Record<string, any>;
    expect(p.support.authorizationNumber).toBeNull();
  });
});

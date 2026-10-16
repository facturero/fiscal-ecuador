import forge from 'node-forge';
import type { InvoiceIssuedPayload } from '../domain/types.js';
import type { DeliveryGuidePayload, WithholdingPayload } from '../domain/direct-documents.js';

/** Una factura que cuadra: 2 × $10,00 con IVA 15% y 1 × $5,00 con IVA 0%. */
export function sampleInvoice(overrides: Partial<InvoiceIssuedPayload> = {}): InvoiceIssuedPayload {
  return {
    invoiceId: '6f1c2b1e-8d4a-4c8e-9f3b-2a7d5e9c1b10',
    number: '001-001-000000123',
    sequentialNumber: '000000123',
    issueDate: '2026-09-13T17:30:00.000Z',
    organizationId: 'org-1',
    countryCode: 'EC',
    establishmentId: 'est-1',
    emissionPointId: 'pt-1',
    customerSnapshot: {
      id: 'cus-1',
      businessName: 'Farmacia "La Salud" & Cía',
      identification: '0992512549001',
      identificationTypeId: 'ident-ruc',
      email: 'compras@lasalud.ec',
      phone: null,
      type: 'company',
    },
    issuerSnapshot: {
      legalName: 'Comercial Ejemplo S.A.',
      tradeName: 'Ejemplo',
      taxId: '1792175606001',
      establishmentCode: '001',
      emissionPointCode: '001',
      address: 'Av. Amazonas N34-12, Quito',
    },
    subtotalCents: 25_00,
    taxTotalCents: 3_00,
    totalCents: 28_00,
    currencyCode: 'USD',
    lines: [
      {
        productId: '11111111-2222-3333-4444-555555555555',
        productCode: 'SKU-001',
        description: 'Paracetamol 500mg',
        quantity: 2,
        unitPriceCents: 10_00,
        discountCents: 0,
        subtotalCents: 20_00,
        taxes: [{ taxRateId: 'rate-iva15', kind: 'vat', rateSnapshot: '15.00', baseCents: 20_00, amountCents: 3_00 }],
      },
      {
        productId: '66666666-7777-8888-9999-000000000000',
        description: 'Consulta',
        quantity: 1,
        unitPriceCents: 5_00,
        discountCents: 0,
        subtotalCents: 5_00,
        taxes: [{ taxRateId: 'rate-iva0', kind: 'vat', rateSnapshot: '0.00', baseCents: 5_00, amountCents: 0 }],
      },
    ],
    ...overrides,
  };
}

export const TAX_CODES = { 'rate-iva15': 'IVA15', 'rate-iva0': 'IVA0', 'rate-no-objeto': 'NO_OBJETO' };

/**
 * Una nota de crédito que revierte toda la factura del sample. Comparte montos y
 * líneas con ella (en positivo); solo cambia lo que anuncia que es una nota de
 * crédito: tipo 04, el comprobante que modifica y el motivo.
 */
export function sampleCreditNote(overrides: Partial<InvoiceIssuedPayload> = {}): InvoiceIssuedPayload {
  return sampleInvoice({
    invoiceId: '6f1c2b1e-8d4a-4c8e-9f3b-2a7d5e9c1b11',
    number: '001-001-000000124',
    sequentialNumber: '000000124',
    documentTypeCode: '04',
    relatedInvoiceId: '6f1c2b1e-8d4a-4c8e-9f3b-2a7d5e9c1b10',
    relatedIssueDate: '2026-09-13T17:30:00.000Z',
    creditNoteReason: 'Devolución total de la mercadería por garantía',
    ...overrides,
  });
}

/** Un .p12 autofirmado, para probar la firma sin depender de un certificado real. */
export function selfSignedP12(options: { password?: string; notBefore?: Date; notAfter?: Date } = {}) {
  const password = options.password ?? 'clave-de-prueba';
  const keys = forge.pki.rsa.generateKeyPair({ bits: 1024, e: 0x10001 });
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '0a1b2c3d';
  cert.validity.notBefore = options.notBefore ?? new Date(Date.now() - 24 * 3600_000);
  cert.validity.notAfter = options.notAfter ?? new Date(Date.now() + 365 * 24 * 3600_000);
  const attrs = [
    { shortName: 'CN', value: 'Comercial Ejemplo' },
    { shortName: 'O', value: 'Pruebas' },
    { shortName: 'C', value: 'EC' },
  ];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.sign(keys.privateKey, forge.md.sha256.create());

  const asn1 = forge.pkcs12.toPkcs12Asn1(keys.privateKey, [cert], password, { algorithm: '3des' });
  const buffer = Buffer.from(forge.asn1.toDer(asn1).getBytes(), 'binary');
  return { buffer, password, certPem: forge.pki.certificateToPem(cert) };
}

/**
 * Una nota de débito sobre la factura del sample: dos motivos (cada uno es una línea de cantidad 1). Intereses por mora sin IVA y
 * gastos de cobranza con IVA 15%: $10,00 + $4,00 = $14,00; IVA $0,60; total $14,60.
 */
export function sampleDebitNote(overrides: Partial<InvoiceIssuedPayload> = {}): InvoiceIssuedPayload {
  return sampleInvoice({
    invoiceId: '6f1c2b1e-8d4a-4c8e-9f3b-2a7d5e9c1b12',
    number: '001-001-000000125',
    sequentialNumber: '000000125',
    documentTypeCode: '05',
    relatedInvoiceId: '6f1c2b1e-8d4a-4c8e-9f3b-2a7d5e9c1b10',
    relatedIssueDate: '2026-09-13T17:30:00.000Z',
    subtotalCents: 14_00,
    taxTotalCents: 60,
    totalCents: 14_60,
    lines: [
      {
        productId: '00000000-0000-0000-0000-000000000000',
        description: 'Intereses por mora',
        quantity: 1,
        unitPriceCents: 10_00,
        discountCents: 0,
        subtotalCents: 10_00,
        taxes: [{ taxRateId: 'rate-iva0', kind: 'vat', rateSnapshot: '0.00', baseCents: 10_00, amountCents: 0 }],
      },
      {
        productId: '00000000-0000-0000-0000-000000000000',
        description: 'Gastos de cobranza',
        quantity: 1,
        unitPriceCents: 4_00,
        discountCents: 0,
        subtotalCents: 4_00,
        taxes: [{ taxRateId: 'rate-iva15', kind: 'vat', rateSnapshot: '15.00', baseCents: 4_00, amountCents: 60 }],
      },
    ],
    ...overrides,
  });
}

const DIRECT_ISSUER = {
  legalName: 'Comercial Ejemplo S.A.',
  tradeName: 'Ejemplo',
  taxId: '1792175606001',
  establishmentCode: '001',
  emissionPointCode: '001',
  address: 'Av. Amazonas N34-12, Quito',
};

/**
 * Una retención a un proveedor por una compra de $100,00 + IVA 15% ($15,00): retiene 1% de renta sobre el subtotal ($1,00) y 30%
 * del IVA ($4,50).
 */
export function sampleWithholding(overrides: Partial<WithholdingPayload> = {}): WithholdingPayload {
  return {
    invoiceId: '7a1c2b1e-8d4a-4c8e-9f3b-2a7d5e9c1b20',
    documentTypeCode: '07',
    organizationId: 'org-1',
    userId: 'user-1',
    countryCode: 'EC',
    number: '001-001-000000007',
    sequentialNumber: '000000007',
    establishmentId: 'est-1',
    emissionPointId: 'pt-1',
    issueDate: '2026-10-14T17:30:00.000Z',
    issuerSnapshot: { ...DIRECT_ISSUER },
    subject: {
      identificationType: 'RUC',
      identification: '1790012345001',
      businessName: 'Proveedor "Andino" & Cía. Ltda.',
      email: 'ventas@andino.ec',
      phone: '022345678',
      relatedParty: false,
    },
    fiscalPeriod: '10/2026',
    support: {
      supportCode: '01',
      documentCode: '01',
      number: '002-003-000004567',
      issueDate: '2026-10-12',
      authorizationNumber: '1210202601179001234500120020030000045671234567815',
      totalWithoutTaxesCents: 100_00,
      totalCents: 115_00,
      paymentMethodCode: '20',
      taxes: [{ code: '2', percentageCode: '4', rate: 15, baseCents: 100_00, amountCents: 15_00 }],
    },
    withholdings: [
      { tax: 'income', retentionCode: '312', baseCents: 100_00, ratePercent: 1, amountCents: 1_00 },
      { tax: 'vat', retentionCode: '1', baseCents: 15_00, ratePercent: 30, amountCents: 4_50 },
    ],
    totalWithheldCents: 5_50,
    ...overrides,
  };
}

/** Una guía con un destinatario y dos productos, sustentada en una factura. */
export function sampleDeliveryGuide(overrides: Partial<DeliveryGuidePayload> = {}): DeliveryGuidePayload {
  return {
    invoiceId: '7a1c2b1e-8d4a-4c8e-9f3b-2a7d5e9c1b21',
    documentTypeCode: '06',
    organizationId: 'org-1',
    userId: 'user-1',
    countryCode: 'EC',
    number: '001-001-000000003',
    sequentialNumber: '000000003',
    establishmentId: 'est-1',
    emissionPointId: 'pt-1',
    issueDate: '2026-10-14T17:30:00.000Z',
    issuerSnapshot: { ...DIRECT_ISSUER },
    originAddress: 'Bodega central, Av. Amazonas N34-12, Quito',
    carrier: {
      identificationType: 'RUC',
      identification: '1791234567001',
      businessName: 'Transportes "Rápido" S.A.',
      plate: 'PBA-1234',
    },
    transportStart: '2026-10-15',
    transportEnd: '2026-10-16',
    recipients: [
      {
        identification: '0992512549001',
        businessName: 'Farmacia "La Salud" & Cía',
        address: 'Av. 9 de Octubre 100, Guayaquil',
        reason: 'Venta',
        route: 'Quito - Guayaquil',
        support: {
          documentCode: '01',
          number: '001-001-000000123',
          issueDate: '2026-10-14',
          authorizationNumber: '1410202601179217560600110010010000001231234567810',
        },
        items: [
          { internalCode: 'SKU-001', description: 'Paracetamol 500mg', quantity: 20 },
          { description: 'Consulta <kit>', quantity: 1.5 },
        ],
      },
    ],
    ...overrides,
  };
}

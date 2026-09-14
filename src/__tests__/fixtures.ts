import forge from 'node-forge';
import type { InvoiceIssuedPayload } from '../domain/types.js';

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

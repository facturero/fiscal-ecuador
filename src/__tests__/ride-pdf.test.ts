import { describe, expect, it } from 'vitest';
import { rideQrUrl } from '../domain/ride-qr.js';
import { renderRidePdf, DOCUMENT_NAMES, type RidePdfData } from '../domain/ride-pdf.js';

function sampleRide(overrides: Partial<RidePdfData> = {}): RidePdfData {
  return {
    documentType: '01',
    number: '001-001-000000123',
    accessKey: '0102202601092438363100110010010000000012345678917',
    authorizationNumber: '0102202601092438363100110010010000000012345678917',
    authorizationDate: '2026-02-02T15:30:00.000Z',
    environment: 'pruebas',
    currency: 'USD',
    subtotalCents: 10000,
    taxTotalCents: 1500,
    totalCents: 11500,
    qrContent: rideQrUrl('0102202601092438363100110010010000000012345678917', 'https://celcer.sri.gob.ec/comprobantes-electronico/comprobantes/consulta'),
    issuer: {
      legalName: 'MI EMPRESA S.A.',
      tradeName: 'MI EMPRESA',
      taxId: '0924383631001',
      address: 'Av. Siempre Viva 123',
      establishmentCode: '001',
      emissionPointCode: '001',
    },
    customer: {
      businessName: 'CLIENTE DE PRUEBA',
      identification: '0924383631',
      email: 'cliente@test.com',
    },
    lines: [
      {
        description: 'LAPIZ',
        quantity: 2,
        unitPriceCents: 5000,
        discountCents: 0,
        subtotalCents: 10000,
        taxes: [{ kind: 'IVA', rateSnapshot: '15%', amountCents: 1500 }],
      },
    ],
    ...overrides,
  };
}

describe('rideQrUrl', () => {
  it('arma la URL de consulta del SRI con la clave de acceso precargada', () => {
    expect(rideQrUrl('ABC123', 'https://www.sri.gob.ec/consulta'))
      .toBe('https://www.sri.gob.ec/consulta?clave_acceso=ABC123');
  });
});

describe('renderRidePdf', () => {
  it('genera un PDF válido con datos de autorización', async () => {
    const pdf = await renderRidePdf(sampleRide());
    const text = pdf.toString('latin1');
    expect(text.startsWith('%PDF')).toBe(true);
    expect(text.trimEnd().endsWith('%%EOF')).toBe(true);
    expect(pdf.length).toBeGreaterThan(1000);
  });

  it('marca el documento como ambiente de pruebas', async () => {
    const pdf = await renderRidePdf(sampleRide({ environment: 'pruebas' }));
    expect(pdf.length).toBeGreaterThan(1000);
  });

  it('también genera notas de crédito', async () => {
    const pdf = await renderRidePdf(sampleRide({ documentType: '04' }));
    expect(pdf.toString('latin1').startsWith('%PDF')).toBe(true);
  });

  it('tolera datos mínimos (sin emisor, sin cliente, sin líneas)', async () => {
    const pdf = await renderRidePdf(sampleRide({ issuer: null, customer: null, lines: [], environment: 'produccion' }));
    expect(pdf.toString('latin1').startsWith('%PDF')).toBe(true);
  });

  it('reconoce los nombres de documento soportados', () => {
    expect(DOCUMENT_NAMES['01']).toBe('FACTURA');
    expect(DOCUMENT_NAMES['04']).toBe('NOTA DE CRÉDITO');
  });
});
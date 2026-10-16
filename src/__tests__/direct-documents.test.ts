import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { validateXML } from 'xmllint-wasm';
import {
  computeWithholdings,
  sriDateFromIsoDay,
  validateRate,
  withheldAmountCents,
  type WithholdingPayload,
} from '../domain/direct-documents.js';
import { buildWithholdingXml } from '../domain/withholding-xml-builder.js';
import { buildDeliveryGuideXml } from '../domain/delivery-guide-xml-builder.js';
import { signXmlWithP12 } from '../domain/xml-signer.js';
import { FiscalValidationError } from '../domain/errors.js';
import { sampleDeliveryGuide, sampleWithholding, selfSignedP12 } from './fixtures.js';

const XSD_DIR = resolve(import.meta.dirname, '../../test-resources/sri-xsd');
const read = (name: string) => readFileSync(resolve(XSD_DIR, name), 'utf8');
const RETENCION_XSD = read('comprobanteRetencion_V2.0.0.xsd');
const GUIA_XSD = read('guiaRemision_V1.1.0.xsd');
const XMLDSIG_XSD = read('xmldsig-core-schema.xsd');

async function validateWith(xsd: string, xml: string): Promise<{ valid: boolean; errors: string[] }> {
  const result = await validateXML({
    xml: [{ fileName: 'comprobante.xml', contents: xml }],
    schema: [xsd],
    preload: [{ fileName: 'xmldsig-core-schema.xsd', contents: XMLDSIG_XSD }],
  });
  return { valid: result.valid, errors: result.errors.map((e) => e.rawMessage) };
}

const WITHHOLDING_KEY = '1410202607179217560600110010010000000071234567813';
const GUIDE_KEY = '1410202606179217560600110010010000000031234567814';

const withholdingXml = (over: Partial<WithholdingPayload> = {}, profile?: Parameters<typeof buildWithholdingXml>[0]['issuerProfile']) =>
  buildWithholdingXml({ payload: sampleWithholding(over), accessKey: WITHHOLDING_KEY, environment: 'pruebas', issueDate: new Date('2026-10-14T17:30:00.000Z'), issuerProfile: profile });

const guideXml = (over = {}, profile?: Parameters<typeof buildDeliveryGuideXml>[0]['issuerProfile']) =>
  buildDeliveryGuideXml({ payload: sampleDeliveryGuide(over), accessKey: GUIDE_KEY, environment: 'pruebas', issueDate: new Date('2026-10-14T17:30:00.000Z'), issuerProfile: profile });

describe('cálculo de retenciones', () => {
  it('base × porcentaje, en centavos y sin errores de coma flotante', () => {
    expect(withheldAmountCents(100_00, 1)).toBe(1_00);
    expect(withheldAmountCents(15_00, 30)).toBe(4_50);
    expect(withheldAmountCents(100_00, 2.75)).toBe(2_75);
    // 0,005 → redondea hacia arriba en la mitad
    expect(withheldAmountCents(1_00, 0.5)).toBe(1);
    expect(withheldAmountCents(33_33, 8)).toBe(2_67);
    // 100,5 centavos: en la mitad se redondea hacia arriba
    expect(withheldAmountCents(1005, 10)).toBe(101);
    expect(withheldAmountCents(1015, 10)).toBe(102);
  });

  it('el porcentaje admite lo que admite el esquema: tres cifras y dos decimales', () => {
    for (const ok of [0, 1, 2.75, 8, 10, 30, 70, 100]) expect(validateRate(ok)).toBeNull();
    expect(validateRate(-1)).toMatch(/entre 0 y 100/);
    expect(validateRate(101)).toMatch(/entre 0 y 100/);
    expect(validateRate(1.234)).toMatch(/dos decimales/);
    expect(validateRate(10.25)).toMatch(/tres cifras/);
  });

  const support = sampleWithholding().support;

  it('calcula cada valor y el total, ignorando cualquier importe que mande el cliente', () => {
    const result = computeWithholdings(support, [
      { tax: 'income', retentionCode: '312', baseCents: 100_00, ratePercent: 1 },
      { tax: 'vat', retentionCode: '1', baseCents: 15_00, ratePercent: 30 },
    ]);
    expect(result.withholdings.map((w) => w.amountCents)).toEqual([1_00, 4_50]);
    expect(result.totalWithheldCents).toBe(5_50);
  });

  it('no se puede retener sobre más de lo que tiene el comprobante', () => {
    const run = (line: Parameters<typeof computeWithholdings>[1][number]) => () => computeWithholdings(support, [line]);
    expect(run({ tax: 'income', retentionCode: '312', baseCents: 100_01, ratePercent: 1 })).toThrow(/supera el subtotal/);
    expect(run({ tax: 'vat', retentionCode: '1', baseCents: 15_01, ratePercent: 30 })).toThrow(/supera el IVA/);
    expect(run({ tax: 'isd', retentionCode: '4580', baseCents: 115_01, ratePercent: 5 })).toThrow(/supera el total/);
  });

  it('el sustento tiene que cuadrar y la retención no puede venir vacía', () => {
    expect(() => computeWithholdings({ ...support, totalCents: 116_00 }, [{ tax: 'income', retentionCode: '312', baseCents: 1_00, ratePercent: 1 }])).toThrow(/no es subtotal más impuestos/);
    expect(() => computeWithholdings(support, [])).toThrow(/al menos un impuesto retenido/);
    expect(() => computeWithholdings(support, [{ tax: 'income', retentionCode: 'demasiado-largo', baseCents: 1_00, ratePercent: 1 }])).toThrow(FiscalValidationError);
  });

  it('las fechas de calendario no se mueven con la zona horaria', () => {
    expect(sriDateFromIsoDay('2026-10-12')).toBe('12/10/2026');
    expect(() => sriDateFromIsoDay('12/10/2026')).toThrow(/AAAA-MM-DD/);
    expect(() => sriDateFromIsoDay('1999-10-12')).toThrow(/fuera de rango/);
  });
});

describe('comprobante de retención (XSD oficial v2.0.0)', () => {
  it('nuestro comprobante sin firmar es válido', async () => {
    expect(await validateWith(RETENCION_XSD, withholdingXml())).toEqual({ valid: true, errors: [] });
  });

  it('firmado (con ds:Signature) es válido', async () => {
    const p12 = selfSignedP12();
    const { signedXml } = signXmlWithP12(withholdingXml(), p12.buffer, p12.password);
    expect(await validateWith(RETENCION_XSD, signedXml)).toEqual({ valid: true, errors: [] });
  });

  it('con todos los opcionales del emisor, parte relacionada y sin email ni teléfono es válido', async () => {
    const payload = sampleWithholding();
    payload.subject = { ...payload.subject, email: null, phone: null, relatedParty: true };
    const xml = buildWithholdingXml({
      payload,
      accessKey: WITHHOLDING_KEY,
      environment: 'produccion',
      issueDate: new Date('2026-10-14T17:30:00.000Z'),
      issuerProfile: { contribuyenteRimpe: 'CONTRIBUYENTE RÉGIMEN RIMPE', agenteRetencion: '1', contribuyenteEspecial: '5368', dirMatriz: 'Av. 10 de Agosto y Colón, Quito', obligadoContabilidad: 'NO' },
    });
    expect(xml).toContain('<parteRel>SI</parteRel>');
    expect(await validateWith(RETENCION_XSD, xml)).toEqual({ valid: true, errors: [] });
  });

  it('con una cédula, un sustento sin autorización y varios impuestos del sustento es válido', async () => {
    const payload = sampleWithholding();
    payload.subject = { ...payload.subject, identificationType: 'CEDULA', identification: '1712345678' };
    payload.support = {
      ...payload.support,
      authorizationNumber: null,
      totalWithoutTaxesCents: 150_00,
      totalCents: 165_00,
      taxes: [
        { code: '2', percentageCode: '4', rate: 15, baseCents: 100_00, amountCents: 15_00 },
        { code: '2', percentageCode: '0', rate: 0, baseCents: 50_00, amountCents: 0 },
      ],
    };
    expect(await validateWith(RETENCION_XSD, withholdingXml(payload))).toEqual({ valid: true, errors: [] });
  });

  it('lleva el sustento sin guiones y las retenciones dentro de él', () => {
    const xml = withholdingXml();
    expect(xml).toContain('<numDocSustento>002003000004567</numDocSustento>');
    expect(xml).toContain('<fechaEmisionDocSustento>12/10/2026</fechaEmisionDocSustento>');
    expect(xml).toContain('<periodoFiscal>10/2026</periodoFiscal>');
    expect(xml.indexOf('<docSustento>')).toBeLessThan(xml.indexOf('<retenciones>'));
    expect(xml).toContain('<porcentajeRetener>30.00</porcentajeRetener>');
    expect(xml).toContain('<valorRetenido>4.50</valorRetenido>');
  });

  it('un porcentaje de más de tres cifras o un nodo fuera de orden lo rechaza el esquema', async () => {
    expect((await validateWith(RETENCION_XSD, withholdingXml().replace('<porcentajeRetener>1.00</porcentajeRetener>', '<porcentajeRetener>10.25</porcentajeRetener>'))).valid).toBe(false);
    expect((await validateWith(RETENCION_XSD, withholdingXml().replace('<parteRel>NO</parteRel>', ''))).valid).toBe(false);
    expect((await validateWith(RETENCION_XSD, withholdingXml().replace('<numDocSustento>002003000004567</numDocSustento>', '<numDocSustento>002-003-000004567</numDocSustento>'))).valid).toBe(false);
  });

  it('sin dirección, con número de sustento mal formado o periodo inválido no se arma', () => {
    const noAddress = sampleWithholding();
    noAddress.issuerSnapshot.address = '';
    expect(() => withholdingXml(noAddress)).toThrow(/dirMatriz/);
    expect(() => withholdingXml({ support: { ...sampleWithholding().support, number: '2-3-4567' } })).toThrow(/000-000-000000000/);
    expect(() => withholdingXml({ fiscalPeriod: '13/2026' })).toThrow(/Periodo fiscal/);
    expect(() => withholdingXml({ withholdings: [] })).toThrow(/al menos un impuesto retenido/);
  });
});

describe('guía de remisión (XSD oficial v1.1.0)', () => {
  it('nuestra guía sin firmar es válida', async () => {
    expect(await validateWith(GUIA_XSD, guideXml())).toEqual({ valid: true, errors: [] });
  });

  it('firmada (con ds:Signature) es válida', async () => {
    const p12 = selfSignedP12();
    const { signedXml } = signXmlWithP12(guideXml(), p12.buffer, p12.password);
    expect(await validateWith(GUIA_XSD, signedXml)).toEqual({ valid: true, errors: [] });
  });

  it('con opcionales del emisor, RISE, varios destinatarios y sin sustento es válida', async () => {
    const guide = sampleDeliveryGuide();
    guide.carrier = { ...guide.carrier, rise: 'RISE-2026', identificationType: 'CEDULA', identification: '1712345678' };
    guide.recipients = [
      guide.recipients[0]!,
      {
        identification: '1790012345001',
        businessName: 'Bodega propia',
        address: 'Calle 5 y Av. 2, Cuenca',
        reason: 'Traslado entre establecimientos',
        destinationEstablishmentCode: '002',
        customsDocument: 'DAU-20260001',
        items: [{ internalCode: 'A1', additionalCode: 'B2', description: 'Cajas', quantity: 100 }],
      },
    ];
    const xml = guideXml(guide, { contribuyenteRimpe: 'CONTRIBUYENTE RÉGIMEN RIMPE', agenteRetencion: '1', contribuyenteEspecial: '5368', dirMatriz: 'Av. 10 de Agosto y Colón, Quito', obligadoContabilidad: 'NO' });
    expect(await validateWith(GUIA_XSD, xml)).toEqual({ valid: true, errors: [] });
  });

  it('las cantidades llevan decimales y los textos se escapan', () => {
    const xml = guideXml();
    expect(xml).toContain('<cantidad>1.50</cantidad>');
    expect(xml).toContain('Consulta &lt;kit&gt;');
    expect(xml).toContain('<fechaIniTransporte>15/10/2026</fechaIniTransporte>');
    expect(xml).toContain('<numDocSustento>001-001-000000123</numDocSustento>');
  });

  it('un nodo fuera de su orden o una placa vacía lo rechaza el esquema', async () => {
    expect((await validateWith(GUIA_XSD, guideXml().replace('<placa>PBA-1234</placa>', '<placa></placa>'))).valid).toBe(false);
    expect((await validateWith(GUIA_XSD, guideXml().replace('<numDocSustento>001-001-000000123</numDocSustento>', '<numDocSustento>0010010000001</numDocSustento>'))).valid).toBe(false);
  });

  it('sin destinatarios o con un destinatario sin mercadería no se arma', () => {
    expect(() => guideXml({ recipients: [] })).toThrow(/al menos un destinatario/);
    const empty = sampleDeliveryGuide();
    empty.recipients[0]!.items = [];
    expect(() => guideXml(empty)).toThrow(/no lleva ninguna mercadería/);
  });
});

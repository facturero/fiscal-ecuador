import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { validateXML } from 'xmllint-wasm';
import { buildInvoiceXml, type InvoiceXmlInput } from '../domain/invoice-xml-builder.js';
import { signXmlWithP12 } from '../domain/xml-signer.js';
import type { InvoiceIssuedPayload } from '../domain/types.js';
import { sampleInvoice, selfSignedP12, TAX_CODES } from './fixtures.js';

/**
 * El XML que generamos, validado contra el XSD OFICIAL del SRI (factura
 * v2.1.0, ver test-resources/sri-xsd/README.md) con libxml2 (xmllint-wasm).
 * Es la misma validación que hace el SRI al recibir: si esto falla, el SRI
 * devuelve "ARCHIVO NO CUMPLE ESTRUCTURA XML".
 */
const XSD_DIR = resolve(import.meta.dirname, '../../test-resources/sri-xsd');
const read = (name: string) => readFileSync(resolve(XSD_DIR, name), 'utf8');
const FACTURA_XSD = read('factura_V2.1.0.xsd');
const XMLDSIG_XSD = read('xmldsig-core-schema.xsd');

async function validate(xml: string): Promise<{ valid: boolean; errors: string[] }> {
  const result = await validateXML({
    xml: [{ fileName: 'factura.xml', contents: xml }],
    schema: [FACTURA_XSD],
    preload: [{ fileName: 'xmldsig-core-schema.xsd', contents: XMLDSIG_XSD }],
  });
  return { valid: result.valid, errors: result.errors.map((e) => e.rawMessage) };
}

const KEY = '1309202601179217560600110010010000001231234567814';

function build(payload: InvoiceIssuedPayload = sampleInvoice(), overrides: Partial<InvoiceXmlInput> = {}): string {
  return buildInvoiceXml({
    payload,
    accessKey: KEY,
    environment: 'pruebas',
    issueDate: new Date(payload.issueDate!),
    establishmentCode: '001',
    emissionPointCode: '001',
    sequentialNumber: payload.sequentialNumber,
    taxCodeById: TAX_CODES,
    identificationTypeCode: 'RUC',
    ...overrides,
  });
}

describe('XSD oficial del SRI (factura v2.1.0)', () => {
  it('la herramienta acepta el XML de ejemplo del propio SRI', async () => {
    expect(await validate(read('factura_V2.1.0.xml'))).toEqual({ valid: true, errors: [] });
  }, 30_000);

  it('nuestra factura sin firmar es válida', async () => {
    expect(await validate(build())).toEqual({ valid: true, errors: [] });
  });

  it('nuestra factura firmada (con ds:Signature y XAdES) es válida', async () => {
    const p12 = selfSignedP12();
    const { signedXml } = signXmlWithP12(build(), p12.buffer, p12.password);
    expect(await validate(signedXml)).toEqual({ valid: true, errors: [] });
  });

  it('con todos los opcionales del emisor (RIMPE, agente de retención, contribuyente especial, matriz) es válida', async () => {
    const xml = build(sampleInvoice(), {
      issuerProfile: {
        contribuyenteRimpe: 'CONTRIBUYENTE RÉGIMEN RIMPE',
        agenteRetencion: '1',
        contribuyenteEspecial: '5368',
        dirMatriz: 'Av. 10 de Agosto y Colón, Quito',
        obligadoContabilidad: 'NO',
        defaultPaymentMethodCode: '20',
      },
    });
    expect(await validate(xml)).toEqual({ valid: true, errors: [] });
  });

  it('a consumidor final, sin email ni teléfono, es válida', async () => {
    const payload = sampleInvoice({ customerSnapshot: null, subtotalCents: 25_00, taxTotalCents: 3_00, totalCents: 28_00 });
    expect(await validate(build(payload, { identificationTypeCode: undefined }))).toEqual({ valid: true, errors: [] });
  });

  it('con pasaporte, cantidades con decimales, descuento y no objeto de IVA es válida', async () => {
    const payload = sampleInvoice();
    payload.customerSnapshot = { ...payload.customerSnapshot!, identification: 'AB1234567', identificationTypeCode: 'PASAPORTE' };
    payload.lines[0] = { ...payload.lines[0], quantity: 1.5, unitPriceCents: 10_00, discountCents: 50, subtotalCents: 14_50 };
    payload.lines[0].taxes = [{ taxRateId: 'rate-iva15', kind: 'vat', rateSnapshot: '15.00', baseCents: 14_50, amountCents: 2_18 }];
    payload.lines[1].taxes = [{ taxRateId: 'rate-no-objeto', kind: 'vat', rateSnapshot: '0', baseCents: 5_00, amountCents: 0 }];
    payload.subtotalCents = 19_50;
    payload.taxTotalCents = 2_18;
    payload.totalCents = 21_68;
    expect(await validate(build(payload, { identificationTypeCode: 'PASAPORTE' }))).toEqual({ valid: true, errors: [] });
  });

  it('con caracteres especiales en los textos (&, <, comillas, tildes) es válida', async () => {
    const payload = sampleInvoice();
    payload.lines[0].description = 'Café "premium" <500g> & azúcar';
    expect(await validate(build(payload))).toEqual({ valid: true, errors: [] });
  });

  /**
   * Los fallos que se corrigieron en el generador, reproducidos a mano sobre un
   * XML válido: el XSD oficial los rechaza. Confirma que no eran detalles
   * cosméticos, eran rechazos del SRI.
   */
  describe('los fallos corregidos eran rechazos del esquema', () => {
    it('un codigoPrincipal de 36 caracteres (el UUID interno)', async () => {
      const xml = build().replace('<codigoPrincipal>SKU-001</codigoPrincipal>', '<codigoPrincipal>11111111-2222-3333-4444-555555555555</codigoPrincipal>');
      const result = await validate(xml);
      expect(result.valid).toBe(false);
      expect(result.errors.join('\n')).toMatch(/codigoPrincipal/);
    });

    it('un <infoAdicional> vacío', async () => {
      const xml = build().replace(/<infoAdicional>[\s\S]*<\/infoAdicional>/, '<infoAdicional>\n  </infoAdicional>');
      const result = await validate(xml);
      expect(result.valid).toBe(false);
      expect(result.errors.join('\n')).toMatch(/infoAdicional/);
    });

    it('la tarifa "15.00.00"', async () => {
      const xml = build().replace('<tarifa>15.00</tarifa>', '<tarifa>15.00.00</tarifa>');
      const result = await validate(xml);
      expect(result.valid).toBe(false);
      expect(result.errors.join('\n')).toMatch(/tarifa/);
    });

    it('un nodo fuera de su orden', async () => {
      const xml = build().replace(
        /(<obligadoContabilidad>[^<]*<\/obligadoContabilidad>)(\s*)(<dirEstablecimiento>[^<]*<\/dirEstablecimiento>)?/,
        '$1',
      ).replace('<fechaEmision>', '<obligadoContabilidad>SI</obligadoContabilidad><fechaEmision>');
      expect((await validate(xml)).valid).toBe(false);
    });
  });
});

import { describe, expect, it } from 'vitest';
import { DOMParser } from '@xmldom/xmldom';
import { buildInvoiceXml, type InvoiceXmlInput } from '../domain/invoice-xml-builder.js';
import { FiscalValidationError } from '../domain/errors.js';
import { sampleInvoice, TAX_CODES } from './fixtures.js';

const KEY = '1309202601179217560600110010010000001231234567814';

function build(overrides: Partial<InvoiceXmlInput> = {}, payload = sampleInvoice()): string {
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

function childNames(xml: string, parent: string): string[] {
  const doc = new DOMParser().parseFromString(xml, 'text/xml');
  const node = doc.getElementsByTagName(parent)[0];
  return Array.from(node.childNodes as unknown as ArrayLike<Node>)
    .filter((n) => n.nodeType === 1)
    .map((n) => (n as Element).tagName);
}

function value(xml: string, tagName: string, index = 0): string | undefined {
  const doc = new DOMParser().parseFromString(xml, 'text/xml');
  return doc.getElementsByTagName(tagName)[index]?.textContent ?? undefined;
}

describe('XML de la factura', () => {
  it('es XML bien formado', () => {
    const errors: string[] = [];
    new DOMParser({ onError: (level, msg) => { if (level !== 'warning') errors.push(msg); } }).parseFromString(build(), 'text/xml');
    expect(errors).toEqual([]);
  });

  it('respeta el orden de nodos del esquema v2.1.0', () => {
    const xml = build({ issuerProfile: { contribuyenteRimpe: 'CONTRIBUYENTE RÉGIMEN RIMPE', agenteRetencion: '1', contribuyenteEspecial: '5368' } });
    expect(childNames(xml, 'infoTributaria')).toEqual([
      'ambiente', 'tipoEmision', 'razonSocial', 'nombreComercial', 'ruc', 'claveAcceso', 'codDoc',
      'estab', 'ptoEmi', 'secuencial', 'dirMatriz', 'agenteRetencion', 'contribuyenteRimpe',
    ]);
    expect(childNames(xml, 'infoFactura')).toEqual([
      'fechaEmision', 'dirEstablecimiento', 'contribuyenteEspecial', 'obligadoContabilidad',
      'tipoIdentificacionComprador', 'razonSocialComprador', 'identificacionComprador',
      'totalSinImpuestos', 'totalDescuento', 'totalConImpuestos', 'propina', 'importeTotal', 'moneda', 'pagos',
    ]);
    expect(childNames(xml, 'detalle')).toEqual([
      'codigoPrincipal', 'descripcion', 'cantidad', 'precioUnitario', 'descuento', 'precioTotalSinImpuesto', 'impuestos',
    ]);
  });

  it('la fecha de emisión es la de billing en hora de Ecuador, no la del servidor', () => {
    // 01:30 UTC del 14 = 20:30 del 13 en Guayaquil.
    const payload = sampleInvoice({ issueDate: '2026-09-14T01:30:00.000Z' });
    expect(value(build({ issueDate: new Date(payload.issueDate!) }, payload), 'fechaEmision')).toBe('13/09/2026');
  });

  it('traduce IVA 15% y 0% a los códigos de la Tabla 17 y agrupa los totales', () => {
    const xml = build();
    expect(value(xml, 'codigoPorcentaje', 0)).toBe('4');
    expect(value(xml, 'tarifa', 0)).toBe('15.00');
    expect(value(xml, 'codigoPorcentaje', 1)).toBe('0');
    expect(value(xml, 'tarifa', 1)).toBe('0.00');

    const doc = new DOMParser().parseFromString(xml, 'text/xml');
    const totals = Array.from(doc.getElementsByTagName('totalImpuesto') as unknown as ArrayLike<Element>).map((t) => ({
      codigoPorcentaje: t.getElementsByTagName('codigoPorcentaje')[0].textContent,
      base: t.getElementsByTagName('baseImponible')[0].textContent,
      valor: t.getElementsByTagName('valor')[0].textContent,
    }));
    expect(totals).toEqual([
      { codigoPorcentaje: '4', base: '20.00', valor: '3.00' },
      { codigoPorcentaje: '0', base: '5.00', valor: '0.00' },
    ]);
  });

  it('la tarifa ya no sale como "15.00.00" cuando el porcentaje viene con decimales', () => {
    expect(build()).not.toContain('.00.00');
  });

  it('codigoPrincipal es el SKU, o el id recortado a 25 caracteres (el UUID entero no cabe)', () => {
    const xml = build();
    expect(value(xml, 'codigoPrincipal', 0)).toBe('SKU-001');
    expect(value(xml, 'codigoPrincipal', 1)).toBe('6666666677778888999900000');
    expect(value(xml, 'codigoPrincipal', 1)).toHaveLength(25);
  });

  it('formatea la cantidad con decimales', () => {
    const payload = sampleInvoice();
    payload.lines[0].quantity = 1.5;
    expect(value(build({}, payload), 'cantidad', 0)).toBe('1.50');
    payload.lines[0].quantity = 0.123456;
    expect(value(build({}, payload), 'cantidad', 0)).toBe('0.123456');
  });

  it('incluye la forma de pago por el total', () => {
    const xml = build();
    expect(value(xml, 'formaPago')).toBe('01');
    expect(value(xml, 'total')).toBe('28.00');
    expect(value(build({}, sampleInvoice({ paymentMethodCode: '20' })), 'formaPago')).toBe('20');
  });

  it('sin email ni teléfono no genera un <infoAdicional> vacío (el esquema lo rechaza)', () => {
    const payload = sampleInvoice();
    payload.customerSnapshot!.email = null;
    expect(build({}, payload)).not.toContain('infoAdicional');
  });

  it('sin comprador es CONSUMIDOR FINAL', () => {
    const payload = sampleInvoice({ customerSnapshot: null });
    const xml = build({ identificationTypeCode: undefined }, payload);
    expect(value(xml, 'tipoIdentificacionComprador')).toBe('07');
    expect(value(xml, 'razonSocialComprador')).toBe('CONSUMIDOR FINAL');
    expect(value(xml, 'identificacionComprador')).toBe('9999999999999');
  });

  it('escapa & y < en los textos pero deja las comillas (la firma se verifica canonicalizada)', () => {
    const xml = build();
    expect(xml).toContain('<razonSocialComprador>Farmacia "La Salud" &amp; Cía</razonSocialComprador>');
    expect(value(xml, 'razonSocialComprador')).toBe('Farmacia "La Salud" & Cía');
  });

  it('un impuesto que no es IVA no se disfraza de IVA', () => {
    const payload = sampleInvoice();
    payload.lines[0].taxes[0].kind = 'withholding_iva';
    expect(() => build({}, payload)).toThrow(FiscalValidationError);
  });

  it('un código de IVA desconocido se rechaza en vez de salir como 15%', () => {
    expect(() => build({ taxCodeById: { ...TAX_CODES, 'rate-iva15': 'IVA_RARO' } })).toThrow(/no tiene equivalente/);
  });

  it('sin catálogo, un IVA 0% no se adivina (puede ser 0%, exento o no objeto)', () => {
    expect(() => build({ taxCodeById: undefined })).toThrow(/0%, exento o no objeto/);
  });

  it('sin dirección del establecimiento no hay dirMatriz y se rechaza', () => {
    const payload = sampleInvoice();
    payload.issuerSnapshot!.address = null;
    expect(() => build({}, payload)).toThrow(/dirMatriz/);
  });

  it('usa la dirección de la matriz de la organización si la hay', () => {
    const xml = build({ issuerProfile: { dirMatriz: 'Matriz Guayaquil' } });
    expect(value(xml, 'dirMatriz')).toBe('Matriz Guayaquil');
    expect(value(xml, 'dirEstablecimiento')).toBe('Av. Amazonas N34-12, Quito');
  });

  it('ambiente 2 en producción', () => {
    expect(value(build({ environment: 'produccion' }), 'ambiente')).toBe('2');
  });
});

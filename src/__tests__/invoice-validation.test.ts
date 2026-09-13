import { describe, expect, it } from 'vitest';
import { validateInvoiceForSri } from '../domain/invoice-validation.js';
import { FiscalValidationError } from '../domain/errors.js';
import { resolveTax } from '../domain/sri-tax-codes.js';
import { sampleInvoice } from './fixtures.js';

function problems(fn: () => void): string[] {
  try {
    fn();
    return [];
  } catch (err) {
    if (err instanceof FiscalValidationError) return err.problems;
    throw err;
  }
}

describe('Validación aritmética antes de enviar al SRI', () => {
  it('una factura que cuadra pasa', () => {
    expect(problems(() => validateInvoiceForSri(sampleInvoice()))).toEqual([]);
  });

  it('detecta el IVA cobrado dos veces cuando el precio ya lo incluía', () => {
    // Así llega hoy de billing con priceIncludesTax: el subtotal de la línea trae
    // el IVA dentro, la base es el precio sin IVA, y el total suma IVA otra vez.
    const payload = sampleInvoice({
      subtotalCents: 11_50,
      taxTotalCents: 1_50,
      totalCents: 13_00,
      lines: [{
        productId: 'p', description: 'Con IVA incluido', quantity: 1, unitPriceCents: 11_50, discountCents: 0,
        subtotalCents: 11_50,
        taxes: [{ taxRateId: 'rate-iva15', kind: 'vat', rateSnapshot: '15', baseCents: 10_00, amountCents: 1_50 }],
      }],
    });
    expect(problems(() => validateInvoiceForSri(payload))).toEqual([
      expect.stringMatching(/base del IVA \(\$10\.00\) no coincide con el precio sin impuestos \(\$11\.50\).*incluye IVA/),
    ]);
  });

  it('subtotal de línea que no es cantidad × precio − descuento', () => {
    const payload = sampleInvoice();
    payload.lines[0].subtotalCents = 19_00;
    payload.lines[0].taxes[0].baseCents = 19_00;
    payload.lines[0].taxes[0].amountCents = 2_85;
    payload.subtotalCents = 24_00;
    payload.taxTotalCents = 2_85;
    payload.totalCents = 26_85;
    expect(problems(() => validateInvoiceForSri(payload))).toEqual([expect.stringMatching(/Línea 1: el subtotal \$19\.00/)]);
  });

  it('tolera un centavo de redondeo en la multiplicación', () => {
    const payload = sampleInvoice();
    payload.lines[0].taxes[0].amountCents = 3_01;
    payload.taxTotalCents = 3_01;
    payload.totalCents = 28_01;
    expect(problems(() => validateInvoiceForSri(payload))).toEqual([]);
  });

  it('totales que no suman', () => {
    const payload = sampleInvoice({ totalCents: 30_00 });
    expect(problems(() => validateInvoiceForSri(payload))).toEqual([expect.stringMatching(/El total \(\$30\.00\) no es subtotal \+ impuestos \(\$28\.00\)/)]);
  });

  it('una línea sin impuestos se rechaza', () => {
    const payload = sampleInvoice();
    payload.lines[1].taxes = [];
    expect(problems(() => validateInvoiceForSri(payload))).toContainEqual(expect.stringMatching(/Línea 2: no tiene impuestos/));
  });

  it('consumidor final por encima de $50', () => {
    const payload = sampleInvoice({ customerSnapshot: null, subtotalCents: 50_00, taxTotalCents: 7_50, totalCents: 57_50 });
    payload.lines = [{
      productId: 'p', description: 'x', quantity: 1, unitPriceCents: 50_00, discountCents: 0, subtotalCents: 50_00,
      taxes: [{ taxRateId: 'rate-iva15', kind: 'vat', rateSnapshot: '15', baseCents: 50_00, amountCents: 7_50 }],
    }];
    expect(problems(() => validateInvoiceForSri(payload))).toEqual([expect.stringMatching(/consumidor final no puede pasar de \$50\.00/)]);
  });

  it('RUC y secuencial con formato inválido', () => {
    const payload = sampleInvoice({ sequentialNumber: '123' });
    payload.issuerSnapshot!.taxId = '17921756';
    expect(problems(() => validateInvoiceForSri(payload))).toEqual([
      expect.stringMatching(/RUC del emisor debe tener 13 dígitos/),
      expect.stringMatching(/secuencial debe tener 9 dígitos/),
    ]);
  });
});

describe('Códigos de impuesto del SRI', () => {
  it.each([
    ['IVA0', '0', '0'], ['IVA5', '5', '5'], ['IVA12', '12', '2'], ['IVA13', '13', '10'], ['IVA14', '14', '3'],
    ['IVA15', '15', '4'], ['NO_OBJETO', '0', '6'], ['EXENTO', '0', '7'],
  ])('%s (%s%%) → codigoPorcentaje %s', (catalogCode, rate, expected) => {
    expect(resolveTax({ kind: 'vat', rateSnapshot: rate, catalogCode })).toEqual({
      codigo: '2', codigoPorcentaje: expected, tarifa: Number(rate),
    });
  });

  it('sin catálogo deduce las tarifas positivas', () => {
    expect(resolveTax({ kind: 'vat', rateSnapshot: '15.00' }).codigoPorcentaje).toBe('4');
    expect(resolveTax({ kind: 'vat', rateSnapshot: '12' }).codigoPorcentaje).toBe('2');
  });

  it('un código que no cuadra con la tarifa calculada se rechaza', () => {
    expect(() => resolveTax({ kind: 'vat', rateSnapshot: '12', catalogCode: 'IVA15' })).toThrow(/dice 15% pero la línea se calculó con 12%/);
  });
});

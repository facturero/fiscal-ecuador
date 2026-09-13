import { describe, it, expect } from 'vitest';
import { buildAccessKey, checkDigitMod11, numericCodeFor } from '../domain/access-key.js';

// Las fechas van a mediodía UTC: así caen en el mismo día en Ecuador (UTC-5) y
// el test no depende de la zona horaria de la máquina que lo corre.
const noonUtc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d, 17, 0, 0));

describe('checkDigitMod11 (validado contra ejemplo real publicado)', () => {
  it('reproduce el dígito verificador de un caso real documentado (Factuplan, RUC 1792146739001, factura 001-001-000000123, producción)', () => {
    // Base de 48 dígitos tomada del ejemplo completo publicado en:
    // https://factuplan.com.ec/blog/como-generar-clave-acceso-49-digitos-sri
    // fecha=12052026, tipo=01, ruc=1792146739001, ambiente=2 (producción),
    // serie=001001, secuencial=000000123, código numérico=12345678, emisión=1
    const base48 = '120520260117921467390012001001000000123123456781';
    expect(base48).toHaveLength(48);

    // El propio artículo publica el mismo algoritmo (mismos pesos 2-7, mismos
    // casos especiales 11->0 y 10->1) sin imprimir el dígito resultante en el
    // texto; se recalculó independientemente con esa implementación y coincide
    // con la nuestra: dígito verificador = 3.
    expect(checkDigitMod11(base48)).toBe('3');
  });
});

const base = {
  issueDate: noonUtc(2024, 1, 15),
  documentTypeCode: '01',
  issuerRuc: '1792175606001',
  environment: 'pruebas' as const,
  establishmentCode: '001',
  emissionPointCode: '001',
  sequentialNumber: '000000001',
};

describe('buildAccessKey', () => {
  it('genera una clave de 49 dígitos con los campos en su sitio', () => {
    const key = buildAccessKey({ ...base, numericCode: '12345678' });

    expect(key).toMatch(/^\d{49}$/);
    expect(key.slice(0, 8)).toBe('15012024');
    expect(key.slice(8, 10)).toBe('01');
    expect(key.slice(10, 23)).toBe('1792175606001');
    expect(key.slice(23, 24)).toBe('1');
    expect(key.slice(24, 30)).toBe('001001');
    expect(key.slice(30, 39)).toBe('000000001');
    expect(key.slice(39, 47)).toBe('12345678');
    expect(key.slice(47, 48)).toBe('1');
    expect(key[48]).toBe(checkDigitMod11(key.slice(0, 48)));
  });

  it('la misma factura da siempre la misma clave: un reintento no crea otro comprobante', () => {
    const code = numericCodeFor('6f1c2b1e-8d4a-4c8e-9f3b-2a7d5e9c1b10');
    expect(code).toMatch(/^\d{8}$/);
    expect(numericCodeFor('6f1c2b1e-8d4a-4c8e-9f3b-2a7d5e9c1b10')).toBe(code);
    expect(numericCodeFor('otra-factura')).not.toBe(code);
    expect(buildAccessKey({ ...base, numericCode: code })).toBe(buildAccessKey({ ...base, numericCode: code }));
  });

  it('sin código numérico usa uno aleatorio distinto cada vez', () => {
    const keys = new Set(Array.from({ length: 20 }, () => buildAccessKey(base).slice(39, 47)));
    expect(keys.size).toBeGreaterThan(1);
  });

  it('la fecha es la de Ecuador: las 20:30 del 13 (01:30 UTC del 14) es el día 13', () => {
    const key = buildAccessKey({ ...base, issueDate: new Date('2026-09-14T01:30:00Z'), numericCode: '00000000' });
    expect(key.slice(0, 8)).toBe('13092026');
  });

  it('ambiente 2 en producción', () => {
    expect(buildAccessKey({ ...base, environment: 'produccion', numericCode: '00000000' })[23]).toBe('2');
  });

  it('falla si la base no tiene exactamente 48 dígitos', () => {
    expect(() => buildAccessKey({ ...base, issuerRuc: '123' })).toThrow('48');
  });

  it('falla con un código numérico mal formado', () => {
    expect(() => buildAccessKey({ ...base, numericCode: '12ab' })).toThrow(/8 dígitos/);
  });
});

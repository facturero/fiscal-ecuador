import { createHash, randomInt } from 'node:crypto';
import { accessKeyDate } from './ecuador-time.js';

export function checkDigitMod11(digits48: string): string {
  const weights = [2, 3, 4, 5, 6, 7];
  let sum = 0;
  let weightIndex = 0;
  for (let i = digits48.length - 1; i >= 0; i--) {
    sum += parseInt(digits48[i], 10) * weights[weightIndex % weights.length];
    weightIndex++;
  }
  const mod = sum % 11;
  const result = 11 - mod;
  if (result === 11) return '0';
  if (result === 10) return '1';
  return String(result);
}

/**
 * Código numérico de 8 dígitos derivado de la factura de billing.
 *
 * Antes era `Math.random()`: cada reintento generaba una clave distinta para el
 * mismo comprobante. Si el primer envío sí había llegado al SRI, el segundo era
 * a sus ojos otro comprobante con el mismo secuencial. Derivado del id, la
 * clave de una factura es siempre la misma, y reenviarla da "clave ya
 * registrada", que se sabe tratar.
 */
export function numericCodeFor(seed: string): string {
  const digest = createHash('sha256').update(seed).digest();
  const value = digest.readUInt32BE(0) % 100_000_000;
  return String(value).padStart(8, '0');
}

export function buildAccessKey(input: {
  issueDate: Date;
  documentTypeCode: string;
  issuerRuc: string;
  environment: 'pruebas' | 'produccion';
  establishmentCode: string;
  emissionPointCode: string;
  sequentialNumber: string;
  /** 8 dígitos. Si falta se genera uno al azar (con `crypto`, no `Math.random`). */
  numericCode?: string;
}): string {
  const fecha = accessKeyDate(input.issueDate);
  const ambiente = input.environment === 'produccion' ? '2' : '1';
  const serie = `${input.establishmentCode}${input.emissionPointCode}`;
  const codigoNumerico = input.numericCode ?? String(randomInt(0, 100_000_000)).padStart(8, '0');
  if (!/^\d{8}$/.test(codigoNumerico)) throw new Error('El código numérico de la clave de acceso debe tener 8 dígitos');
  const tipoEmision = '1';

  const base48 = `${fecha}${input.documentTypeCode}${input.issuerRuc}${ambiente}${serie}${input.sequentialNumber}${codigoNumerico}${tipoEmision}`;
  if (base48.length !== 48) throw new Error(`Clave de acceso mal formada: ${base48.length} dígitos, se esperaban 48`);
  if (!/^\d{48}$/.test(base48)) throw new Error('Clave de acceso mal formada: solo puede contener dígitos');

  return base48 + checkDigitMod11(base48);
}

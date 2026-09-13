import { FiscalValidationError } from './errors.js';

/**
 * Traducción de los impuestos del CRM a los códigos del SRI (Tabla 16 "código
 * de impuesto" y Tabla 17 "código de porcentaje de IVA" de la ficha técnica).
 *
 * Antes cualquier código desconocido acababa como IVA 15% (`codigoPorcentaje`
 * 4), y cualquier impuesto que no fuera IVA (ICE, IRBPNR, retenciones) se
 * emitía también como IVA. Las dos cosas producen una factura con impuestos
 * falsos. Ahora lo que no se sabe traducir **se rechaza** con un mensaje, en vez
 * de adivinarse.
 */

/** Código de impuesto IVA en la Tabla 16. */
export const SRI_TAX_CODE_IVA = '2';

interface IvaEntry {
  codigoPorcentaje: string;
  /** Tarifa fija; `null` cuando depende del caso (IVA diferenciado). */
  tarifa: number | null;
}

/** Códigos del catálogo de tax-service → Tabla 17. */
const IVA_BY_CATALOG_CODE: Record<string, IvaEntry> = {
  IVA0: { codigoPorcentaje: '0', tarifa: 0 },
  IVA5: { codigoPorcentaje: '5', tarifa: 5 },
  IVA12: { codigoPorcentaje: '2', tarifa: 12 },
  IVA13: { codigoPorcentaje: '10', tarifa: 13 },
  IVA14: { codigoPorcentaje: '3', tarifa: 14 },
  IVA15: { codigoPorcentaje: '4', tarifa: 15 },
  NO_OBJETO: { codigoPorcentaje: '6', tarifa: 0 },
  EXENTO: { codigoPorcentaje: '7', tarifa: 0 },
  IVA_EXENTO: { codigoPorcentaje: '7', tarifa: 0 },
  IVA_DIFERENCIADO: { codigoPorcentaje: '8', tarifa: null },
};

/**
 * Sin catálogo solo se puede deducir el código por el porcentaje cuando no hay
 * ambigüedad. El 0% no está aquí a propósito: puede ser IVA 0%, exento o no
 * objeto de IVA, y cada uno se declara distinto.
 */
const IVA_BY_POSITIVE_RATE: Record<string, IvaEntry> = {
  '5': IVA_BY_CATALOG_CODE.IVA5,
  '12': IVA_BY_CATALOG_CODE.IVA12,
  '13': IVA_BY_CATALOG_CODE.IVA13,
  '14': IVA_BY_CATALOG_CODE.IVA14,
  '15': IVA_BY_CATALOG_CODE.IVA15,
};

export interface ResolvedTax {
  codigo: string;
  codigoPorcentaje: string;
  tarifa: number;
}

export interface TaxToResolve {
  kind: string;
  rateSnapshot: string;
  /** Código del catálogo de tax-service (`IVA15`, `NO_OBJETO`...), si se pudo consultar. */
  catalogCode?: string;
}

export function resolveTax(tax: TaxToResolve): ResolvedTax {
  if (tax.kind !== 'vat') {
    throw new FiscalValidationError(
      `El impuesto de tipo "${tax.kind}" no se puede declarar en una factura electrónica todavía: ` +
        'solo se emite IVA. Quita ese impuesto del producto o emite el comprobante que corresponda.',
    );
  }

  const rate = Number.parseFloat(tax.rateSnapshot);
  if (!Number.isFinite(rate) || rate < 0) {
    throw new FiscalValidationError(`Tarifa de IVA inválida: "${tax.rateSnapshot}"`);
  }

  let entry: IvaEntry | undefined;
  if (tax.catalogCode) {
    entry = IVA_BY_CATALOG_CODE[tax.catalogCode];
    if (!entry) {
      throw new FiscalValidationError(
        `El código de IVA "${tax.catalogCode}" del catálogo no tiene equivalente en la tabla del SRI`,
      );
    }
  } else {
    entry = IVA_BY_POSITIVE_RATE[String(rate)];
    if (!entry) {
      throw new FiscalValidationError(
        rate === 0
          ? 'No se pudo consultar el catálogo de impuestos y una línea tiene IVA 0%: sin él no se sabe si es 0%, exento o no objeto de IVA. Reintenta cuando tax-service responda.'
          : `No se pudo consultar el catálogo de impuestos y la tarifa ${rate}% no es una tarifa de IVA conocida`,
      );
    }
  }

  if (entry.tarifa !== null && entry.tarifa !== rate) {
    throw new FiscalValidationError(
      `El IVA "${tax.catalogCode ?? rate}" dice ${entry.tarifa}% pero la línea se calculó con ${rate}%`,
    );
  }

  return { codigo: SRI_TAX_CODE_IVA, codigoPorcentaje: entry.codigoPorcentaje, tarifa: rate };
}

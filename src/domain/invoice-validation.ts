import type { InvoiceIssuedPayload } from './types.js';
import { FiscalValidationError } from './errors.js';

/** Identificación genérica de consumidor final en el SRI. */
export const CONSUMIDOR_FINAL_ID = '9999999999999';

/**
 * Tope de una factura a consumidor final. Por encima el SRI exige identificar
 * al comprador y rechaza el comprobante.
 */
export const CONSUMIDOR_FINAL_MAX_CENTS = 50_00;

/** Tolerancia de redondeo, en centavos, al recalcular una multiplicación. */
const ROUNDING_TOLERANCE_CENTS = 1;

/**
 * Comprueba que la factura cuadra **antes** de firmarla y mandarla.
 *
 * Billing ya calcula los totales, pero el SRI rechaza por cualquier descuadre y
 * lo hace después de un viaje de red y con un mensaje genérico. Aquí se vuelve
 * a sumar todo con lo que de verdad va a ir en el XML y se dice qué no cuadra.
 *
 * Detecta, por ejemplo, el caso de productos con precio con IVA incluido: la
 * línea llega con el IVA dentro del subtotal y la base imponible no coincide
 * con el precio sin impuestos, así que el impuesto se estaría cobrando dos veces.
 */
export function validateInvoiceForSri(payload: InvoiceIssuedPayload): void {
  const problems: string[] = [];

  if (!payload.issuerSnapshot) {
    problems.push('La factura no trae los datos del emisor');
  } else {
    if (!/^\d{13}$/.test(payload.issuerSnapshot.taxId ?? '')) {
      problems.push(`El RUC del emisor debe tener 13 dígitos (tiene "${payload.issuerSnapshot.taxId}")`);
    }
    if (!payload.issuerSnapshot.legalName?.trim()) problems.push('Falta la razón social del emisor');
  }

  if (!/^\d{9}$/.test(payload.sequentialNumber ?? '')) {
    problems.push(`El secuencial debe tener 9 dígitos (llegó "${payload.sequentialNumber}")`);
  }

  if (!payload.lines?.length) {
    problems.push('La factura no tiene líneas');
  }

  let linesSubtotal = 0;
  let taxesTotal = 0;

  payload.lines?.forEach((line, i) => {
    const n = `Línea ${i + 1}`;
    linesSubtotal += line.subtotalCents;

    if (!(line.quantity > 0)) problems.push(`${n}: la cantidad debe ser mayor que cero`);
    if (line.unitPriceCents < 0) problems.push(`${n}: el precio unitario no puede ser negativo`);
    if (line.discountCents < 0) problems.push(`${n}: el descuento no puede ser negativo`);
    if (!line.description?.trim()) problems.push(`${n}: falta la descripción`);
    if ((line.description ?? '').length > 300) problems.push(`${n}: la descripción pasa de 300 caracteres`);

    const expectedSubtotal = Math.round(line.quantity * line.unitPriceCents) - line.discountCents;
    if (Math.abs(expectedSubtotal - line.subtotalCents) > ROUNDING_TOLERANCE_CENTS) {
      problems.push(
        `${n}: el subtotal ${cents(line.subtotalCents)} no es cantidad × precio − descuento (${cents(expectedSubtotal)})`,
      );
    }

    if (!line.taxes?.length) {
      problems.push(`${n}: no tiene impuestos; el SRI exige al menos uno por línea (IVA 0% o no objeto si aplica)`);
    }

    for (const tax of line.taxes ?? []) {
      taxesTotal += tax.amountCents;
      const rate = Number.parseFloat(tax.rateSnapshot);

      if (tax.kind === 'vat' && tax.baseCents !== line.subtotalCents) {
        problems.push(
          `${n}: la base del IVA (${cents(tax.baseCents)}) no coincide con el precio sin impuestos (${cents(line.subtotalCents)}); ` +
            'suele pasar cuando el precio del producto ya incluye IVA',
        );
      }
      if (Number.isFinite(rate)) {
        const expectedAmount = Math.round((tax.baseCents * rate) / 100);
        if (Math.abs(expectedAmount - tax.amountCents) > ROUNDING_TOLERANCE_CENTS) {
          problems.push(
            `${n}: el impuesto ${cents(tax.amountCents)} no es el ${rate}% de ${cents(tax.baseCents)} (${cents(expectedAmount)})`,
          );
        }
      }
    }
  });

  if (payload.lines?.length) {
    if (linesSubtotal !== payload.subtotalCents) {
      problems.push(`La suma de las líneas (${cents(linesSubtotal)}) no coincide con el subtotal (${cents(payload.subtotalCents)})`);
    }
    if (taxesTotal !== payload.taxTotalCents) {
      problems.push(`La suma de impuestos (${cents(taxesTotal)}) no coincide con el total de impuestos (${cents(payload.taxTotalCents)})`);
    }
    if (payload.subtotalCents + payload.taxTotalCents !== payload.totalCents) {
      problems.push(
        `El total (${cents(payload.totalCents)}) no es subtotal + impuestos (${cents(payload.subtotalCents + payload.taxTotalCents)})`,
      );
    }
  }

  if (payload.currencyCode && payload.currencyCode !== 'USD') {
    problems.push(`El SRI solo admite dólares y la factura está en ${payload.currencyCode}`);
  }

  const identification = payload.customerSnapshot?.identification ?? CONSUMIDOR_FINAL_ID;
  if (identification === CONSUMIDOR_FINAL_ID && payload.totalCents > CONSUMIDOR_FINAL_MAX_CENTS) {
    problems.push(
      `Una factura a consumidor final no puede pasar de ${cents(CONSUMIDOR_FINAL_MAX_CENTS)} (esta es de ${cents(payload.totalCents)}); hay que identificar al comprador`,
    );
  }

  if (problems.length) throw new FiscalValidationError(problems);
}

function cents(value: number): string {
  return `$${(value / 100).toFixed(2)}`;
}

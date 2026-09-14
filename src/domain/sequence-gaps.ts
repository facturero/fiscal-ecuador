/**
 * Huecos en la numeración de facturas ante el SRI.
 *
 * billing asigna los secuenciales con bloqueo de fila, así que no los salta. Si
 * aquí falta un número entre dos que sí llegaron, un evento
 * `billing.invoice.issued` se perdió o nunca se procesó: hay una factura emitida
 * en el sistema que el SRI no conoce. Se calcula bajo demanda y no al procesar
 * cada factura porque los eventos pueden llegar desordenados y un hueco de un
 * segundo no es un problema.
 */

export interface SeriesGaps {
  /** `estab-ptoEmi`, p. ej. `001-001`. */
  series: string;
  first: number;
  last: number;
  count: number;
  /** Secuenciales que faltan entre el primero y el último recibidos, hasta `limit`. */
  missing: number[];
  /** Total de faltantes, aunque `missing` venga recortado. */
  missingCount: number;
}

const NUMBER_RE = /^(\d{3})-(\d{3})-(\d{9})$/;

export function findSequenceGaps(numbers: string[], limit = 100): SeriesGaps[] {
  const bySeries = new Map<string, Set<number>>();
  for (const number of numbers) {
    const match = NUMBER_RE.exec(number);
    if (!match) continue;
    const series = `${match[1]}-${match[2]}`;
    const set = bySeries.get(series) ?? new Set<number>();
    set.add(Number(match[3]));
    bySeries.set(series, set);
  }

  const result: SeriesGaps[] = [];
  for (const [series, set] of [...bySeries.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const sorted = [...set].sort((a, b) => a - b);
    const first = sorted[0];
    const last = sorted[sorted.length - 1];
    const missing: number[] = [];
    let missingCount = 0;
    for (let i = 1; i < sorted.length; i++) {
      for (let n = sorted[i - 1] + 1; n < sorted[i]; n++) {
        missingCount++;
        if (missing.length < limit) missing.push(n);
      }
    }
    result.push({ series, first, last, count: sorted.length, missing, missingCount });
  }
  return result;
}

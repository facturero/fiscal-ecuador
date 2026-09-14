import { describe, expect, it } from 'vitest';
import { findSequenceGaps } from '../domain/sequence-gaps.js';

const n = (series: string, seq: number) => `${series}-${String(seq).padStart(9, '0')}`;

describe('Huecos en los secuenciales', () => {
  it('sin huecos no reporta faltantes', () => {
    expect(findSequenceGaps([n('001-001', 1), n('001-001', 2), n('001-001', 3)])).toEqual([
      { series: '001-001', first: 1, last: 3, count: 3, missing: [], missingCount: 0 },
    ]);
  });

  it('encuentra los números que faltan entre el primero y el último, sin importar el orden de llegada', () => {
    const [gaps] = findSequenceGaps([n('001-001', 7), n('001-001', 2), n('001-001', 5)]);
    expect(gaps).toMatchObject({ first: 2, last: 7, count: 3, missing: [3, 4, 6], missingCount: 3 });
  });

  it('cada establecimiento y punto de emisión es una serie independiente', () => {
    const gaps = findSequenceGaps([n('001-001', 1), n('001-001', 3), n('002-001', 1), n('001-002', 10), n('001-002', 11)]);
    expect(gaps.map((g) => [g.series, g.missing])).toEqual([
      ['001-001', [2]],
      ['001-002', []],
      ['002-001', []],
    ]);
  });

  it('un número repetido no cuenta dos veces', () => {
    expect(findSequenceGaps([n('001-001', 1), n('001-001', 1), n('001-001', 2)])[0].count).toBe(2);
  });

  it('recorta la lista pero da el total', () => {
    const [gaps] = findSequenceGaps([n('001-001', 1), n('001-001', 1000)], 5);
    expect(gaps.missing).toEqual([2, 3, 4, 5, 6]);
    expect(gaps.missingCount).toBe(998);
  });

  it('ignora números con formato raro en vez de romper', () => {
    expect(findSequenceGaps(['borrador', '001-001-12', n('001-001', 4)])).toEqual([
      { series: '001-001', first: 4, last: 4, count: 1, missing: [], missingCount: 0 },
    ]);
  });
});

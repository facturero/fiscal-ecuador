import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { columns, connect, createDatabase, dropDatabase, indexes, sequelizeCli } from './db.js';

const PREVIOUS = '20260905000000-align-processed-events.cjs';
const NEW = '20260913120000-fiscal-robustness.cjs';
const CREDIT_NOTES = '20260913220000-credit-notes.cjs';

function legacyRow(overrides: Record<string, unknown> = {}) {
  const now = new Date();
  return {
    id: randomUUID(),
    organization_id: 'org-legacy',
    billing_invoice_id: randomUUID(),
    number: `001-001-${String(Math.floor(Math.random() * 1e9)).padStart(9, '0')}`,
    access_key: String(Math.floor(Math.random() * 1e15)).padStart(49, '7'),
    status: 'sent',
    retry_count: 3,
    last_error: null,
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

async function insert(database: string, row: Record<string, unknown>): Promise<void> {
  const conn = await connect(database);
  try {
    const keys = Object.keys(row);
    await conn.query(
      `INSERT INTO fiscal_invoices (${keys.map((k) => `\`${k}\``).join(',')}) VALUES (${keys.map(() => '?').join(',')})`,
      Object.values(row),
    );
  } finally {
    await conn.end();
  }
}

async function query<T>(database: string, sql: string, params: unknown[] = []): Promise<T[]> {
  const conn = await connect(database);
  try {
    const [rows] = await conn.query(sql, params);
    return rows as T[];
  } finally {
    await conn.end();
  }
}

/**
 * La migración nueva, contra MySQL real, en el mismo camino que seguiría
 * producción: una base en la versión anterior, con datos, que se migra.
 */
describe('Migración 20260913120000-fiscal-robustness', () => {
  const db = `fiscal_it_mig_${Date.now()}`;
  const legacy = [legacyRow(), legacyRow({ status: 'error', last_error: 'Sin certificado activo' })];

  beforeAll(async () => {
    await createDatabase(db);
    await sequelizeCli(db, 'db:migrate', ['--to', PREVIOUS]);
    for (const row of legacy) await insert(db, row);
    await sequelizeCli(db, 'db:migrate');
  });

  afterAll(async () => {
    await dropDatabase(db);
  });

  it('queda registrada como aplicada', async () => {
    const applied = await query<{ name: string }>(db, 'SELECT name FROM SequelizeMeta ORDER BY name');
    expect(applied.map((r) => r.name)).toContain(NEW);
  });

  it('añade las columnas nuevas y deja access_key admitiendo NULL', async () => {
    const cols = await columns(db, 'fiscal_invoices');
    expect(cols.access_key.IS_NULLABLE).toBe('YES');
    expect(cols.authorized_xml_file_id).toMatchObject({ IS_NULLABLE: 'YES', COLUMN_TYPE: 'char(36)' });
    expect(cols.next_check_at.IS_NULLABLE).toBe('YES');
    expect(cols.billing_voided_at.IS_NULLABLE).toBe('YES');
  });

  it('crea los índices y conserva el único de access_key', async () => {
    const idx = await indexes(db, 'fiscal_invoices');
    const byColumns = (cols: string[]) => idx.find((i) => i.columns.join(',') === cols.join(','));
    // credit-notes (20260913220000) sustituyó el UNIQUE (organization_id, number)
    // por (organization_id, document_type, number): factura y nota de crédito
    // comparten serie en la misma organización, así que sin el tipo de documento
    // el secuencial reutilizado no se podía distinguir.
    expect(byColumns(['organization_id', 'document_type', 'number'])?.unique).toBe(true);
    expect(byColumns(['status', 'next_check_at'])).toBeDefined();
    expect(byColumns(['organization_id', 'created_at'])).toBeDefined();
    expect(byColumns(['access_key'])?.unique).toBe(true);
  });

  it('no pierde ni altera las filas que ya había', async () => {
    const rows = await query<Record<string, unknown>>(db, 'SELECT * FROM fiscal_invoices ORDER BY created_at');
    expect(rows).toHaveLength(2);
    for (const original of legacy) {
      const row = rows.find((r) => r.id === original.id)!;
      expect(row).toMatchObject({
        access_key: original.access_key,
        status: original.status,
        retry_count: original.retry_count,
        next_check_at: null,
        billing_voided_at: null,
        authorized_xml_file_id: null,
      });
    }
  });

  it('admite varias facturas sin clave de acceso (NULL no choca con el único)', async () => {
    await insert(db, legacyRow({ access_key: null, status: 'error', number: '001-001-900000001' }));
    await insert(db, legacyRow({ access_key: null, status: 'error', number: '001-001-900000002' }));
    const [{ n }] = await query<{ n: number }>(db, 'SELECT COUNT(*) n FROM fiscal_invoices WHERE access_key IS NULL');
    expect(Number(n)).toBe(2);
  });

  it('rechaza el mismo número dos veces en la misma organización, pero no en otra', async () => {
    await insert(db, legacyRow({ number: '001-001-000000777' }));
    await expect(insert(db, legacyRow({ number: '001-001-000000777' }))).rejects.toThrow(/Duplicate entry/);
    await expect(insert(db, legacyRow({ number: '001-001-000000777', organization_id: 'otra-org' }))).resolves.toBeUndefined();
  });

  it('se puede deshacer y volver a aplicar cuando no hay claves NULL', async () => {
    await query(db, 'DELETE FROM fiscal_invoices WHERE access_key IS NULL');
    // El undo debe seguir el orden inverso del encadenado: credit-notes primero
    // (su down recupera el índice que fiscal-robustness intenta quitar en el
    // suyo) y después fiscal-robustness. Un undo a secas solo desharía la última.
    await sequelizeCli(db, 'db:migrate:undo', ['--name', CREDIT_NOTES]);
    await sequelizeCli(db, 'db:migrate:undo', ['--name', NEW]);

    const reverted = await columns(db, 'fiscal_invoices');
    expect(reverted.access_key.IS_NULLABLE).toBe('NO');
    expect(reverted.next_check_at).toBeUndefined();

    await sequelizeCli(db, 'db:migrate');
    expect((await columns(db, 'fiscal_invoices')).access_key.IS_NULLABLE).toBe('YES');
  });

  it('volver a correr migrate no hace nada (idempotente)', async () => {
    const out = await sequelizeCli(db, 'db:migrate');
    expect(out).toMatch(/No migrations were executed/);
  });
});

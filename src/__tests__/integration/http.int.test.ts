import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';

const { sequelize } = await import('../../infrastructure/persistence/sequelize.js');
const { FiscalInvoiceModel } = await import('../../infrastructure/persistence/models.js');
const { createApp } = await import('../../interface/http/app.js');

afterAll(async () => {
  await sequelize.close();
});

describe('Reintento fiscal: permisos y sus efectos, contra MySQL', () => {
  const billingInvoiceId = randomUUID();
  const retried: string[] = [];
  const app = createApp({
    corsOrigin: '*',
    documents: { upload: async () => 'x', download: async () => Buffer.from('') },
    onRetry: async (id) => { retried.push(id); return null; },
  });

  beforeAll(async () => {
    expect(sequelize.getDatabaseName()).toMatch(/^fiscal_it_/);
    const now = new Date();
    await FiscalInvoiceModel.create({
      id: randomUUID(), organization_id: 'org-http', billing_invoice_id: billingInvoiceId, number: '001-001-000000321',
      access_key: null, status: 'error', retry_count: 0, last_error: 'Sin certificado', created_at: now, updated_at: now,
    } as never);
  });

  afterAll(async () => {
    await FiscalInvoiceModel.destroy({ where: { billing_invoice_id: billingInvoiceId } });
  });

  const retry = (permissions: string, org = 'org-http') => app.fetch(new Request(`http://localhost/fiscal-invoices/${billingInvoiceId}/retry`, {
    method: 'POST',
    headers: { 'X-Organization-Id': org, 'X-Permissions': permissions },
  }));

  it.each(['invoice:authorize', 'fiscal:manage'])('con %s se reintenta', async (permission) => {
    const before = retried.length;
    const res = await retry(`invoice:read,${permission}`);
    expect(res.status).toBe(200);
    expect(retried.length).toBe(before + 1);
  });

  it('otra organización no la ve aunque tenga el permiso', async () => {
    const res = await retry('invoice:authorize', 'otra-org');
    expect(res.status).toBe(404);
  });
});

describe('GET /fiscal-invoices/sequence-gaps contra MySQL', () => {
  const org = `org-gaps-${Date.now()}`;
  const app = createApp({ corsOrigin: '*', documents: { upload: async () => 'x', download: async () => Buffer.from('') } });

  beforeAll(async () => {
    const now = new Date();
    for (const number of ['001-001-000000001', '001-001-000000002', '001-001-000000005', '002-001-000000001']) {
      await FiscalInvoiceModel.create({
        id: randomUUID(), organization_id: org, billing_invoice_id: randomUUID(), number,
        access_key: null, status: 'sent', retry_count: 0, created_at: now, updated_at: now,
      } as never);
    }
    // Otra organización con la misma serie no mezcla sus números.
    await FiscalInvoiceModel.create({
      id: randomUUID(), organization_id: `${org}-otra`, billing_invoice_id: randomUUID(), number: '001-001-000000003',
      access_key: null, status: 'sent', retry_count: 0, created_at: now, updated_at: now,
    } as never);
  });

  const get = (permissions = 'fiscal:read') => app.fetch(new Request('http://localhost/fiscal-invoices/sequence-gaps', {
    headers: { 'X-Organization-Id': org, 'X-Permissions': permissions },
  }));

  it('reporta los números que faltan por serie, solo de la organización', async () => {
    const res = await get();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.hasGaps).toBe(true);
    expect(body.series).toEqual([
      { series: '001-001', first: 1, last: 5, count: 3, missing: [3, 4], missingCount: 2 },
      { series: '002-001', first: 1, last: 1, count: 1, missing: [], missingCount: 0 },
    ]);
  });

  it('exige fiscal:read', async () => {
    expect((await get('invoice:read')).status).toBe(403);
  });
});

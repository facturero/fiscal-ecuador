import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sampleInvoice } from '../fixtures.js';

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
      { series: '01|001-001-', first: 1, last: 5, count: 3, missing: [3, 4], missingCount: 2 },
      { series: '01|002-001-', first: 1, last: 1, count: 1, missing: [], missingCount: 0 },
    ]);
  });

  it('exige fiscal:read', async () => {
    expect((await get('invoice:read')).status).toBe(403);
  });
});

describe('GET /fiscal-invoices/:id/ride contra MySQL', () => {
  const org = `org-ride-${Date.now()}`;
  const app = createApp({ corsOrigin: '*', documents: { upload: async () => 'x', download: async () => Buffer.from('') } });
  const accessKey = '0102202601092438363100110010010000000012345678917';
  let pendingId = '';
  let rideId = '';

  beforeAll(async () => {
    const now = new Date();
    const pending = await FiscalInvoiceModel.create({
      id: randomUUID(), organization_id: org, billing_invoice_id: randomUUID(), number: '001-001-000000900',
      access_key: null, status: 'pending', retry_count: 0, created_at: now, updated_at: now,
    } as never);
    const ride = await FiscalInvoiceModel.create({
      id: randomUUID(), organization_id: org, billing_invoice_id: randomUUID(), number: '001-001-000000901',
      access_key: accessKey, status: 'authorized', authorization_number: accessKey,
      authorization_date: new Date('2026-02-02T15:30:00.000Z'), original_payload: sampleInvoice(),
      retry_count: 0, created_at: now, updated_at: now,
    } as never);
    pendingId = pending.id;
    rideId = ride.id;
  });

  afterAll(async () => {
    await FiscalInvoiceModel.destroy({ where: { organization_id: org } });
  });

  const get = (id: string, permissions = 'fiscal:read', orgId = org) =>
    app.fetch(new Request(`http://localhost/fiscal-invoices/${id}/ride`, {
      headers: { 'X-Organization-Id': orgId, 'X-Permissions': permissions },
    }));

  it('una factura sin autorizar responde 404 (NotReadyError), no un PDF', async () => {
    const res = await get(pendingId);
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe('NotReadyError');
  });

  it('una autorizada devuelve el RIDE como PDF descargable', async () => {
    const res = await get(rideId);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/pdf');
    expect(res.headers.get('content-disposition')).toContain('ride-001-001-000000901.pdf');
    const buf = Buffer.from(await res.arrayBuffer());
    expect(buf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  });

  it('otra organización no la ve aunque tenga el permiso', async () => {
    expect((await get(rideId, 'fiscal:read', 'otra-org')).status).toBe(404);
  });
});

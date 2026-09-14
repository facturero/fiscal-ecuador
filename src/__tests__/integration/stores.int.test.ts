import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { FiscalInvoiceRecord } from '../../application/ports.js';
import type { SriReceptionResponse } from '../../infrastructure/http/sri-client.js';
import { sampleInvoice, TAX_CODES } from '../fixtures.js';

// Los módulos de persistencia leen la configuración al importarse: se cargan
// después de que vitest haya puesto DB_NAME apuntando a la base desechable.
const { sequelize } = await import('../../infrastructure/persistence/sequelize.js');
const { CertificateModel, FiscalInvoiceModel, OutboxModel } = await import('../../infrastructure/persistence/models.js');
const { SequelizeCertificateStore, SequelizeFiscalInvoiceStore } = await import('../../infrastructure/persistence/stores.js');
const { FiscalInvoiceProcessor, RETRY_POLICY } = await import('../../application/fiscal-processor.js');

function record(overrides: Partial<FiscalInvoiceRecord> = {}): FiscalInvoiceRecord {
  const now = new Date('2026-09-13T17:00:00Z');
  return {
    id: randomUUID(),
    organization_id: 'org-it',
    billing_invoice_id: randomUUID(),
    document_type: '01',
    number: `001-001-${String(Math.floor(Math.random() * 1e9)).padStart(9, '0')}`,
    access_key: null,
    status: 'pending',
    authorization_number: null,
    authorization_date: null,
    sri_response: null,
    signed_xml_file_id: null,
    authorized_xml_file_id: null,
    retry_count: 0,
    last_error: null,
    original_payload: null,
    next_check_at: null,
    billing_voided_at: null,
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

afterAll(async () => {
  await sequelize.close();
});

describe('Repositorios Sequelize contra MySQL', () => {
  const store = new SequelizeFiscalInvoiceStore();
  const certificates = new SequelizeCertificateStore();

  beforeAll(async () => {
    expect(sequelize.getDatabaseName()).toMatch(/^fiscal_it_/);
    await sequelize.authenticate();
  });

  beforeEach(async () => {
    await OutboxModel.destroy({ where: {} });
    await FiscalInvoiceModel.destroy({ where: {} });
    await CertificateModel.destroy({ where: {} });
  });

  it('guarda el registro y su evento juntos, con el payload que consume el resto del sistema', async () => {
    const payload = sampleInvoice({ userId: 'user-1' });
    const r = record({ status: 'sent', original_payload: payload, billing_invoice_id: payload.invoiceId, number: payload.number });
    await store.save(r, { type: 'sent', message: 'Enviada', requiresAttention: false });

    const found = await store.findByBillingInvoiceId(payload.invoiceId);
    expect(found).toMatchObject({ id: r.id, status: 'sent', number: payload.number });
    expect(found?.original_payload?.invoiceId).toBe(payload.invoiceId);

    const events = await OutboxModel.findAll();
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('fiscal.ec.invoice.sent');
    expect(events[0].processed_at).toBeNull();
    expect(events[0].payload).toEqual({
      fiscalInvoiceId: r.id,
      billingInvoiceId: payload.invoiceId,
      invoiceId: payload.invoiceId,
      organizationId: 'org-it',
      number: payload.number,
      status: 'sent',
      type: 'sent',
      message: 'Enviada',
      requiresAttention: false,
      userId: 'user-1',
    });
  });

  it('solo lo que requiere atención genera además el aviso para la campana', async () => {
    const payload = sampleInvoice({ userId: 'user-1' });
    const r = record({ status: 'rejected', original_payload: payload, billing_invoice_id: payload.invoiceId, number: payload.number });
    await store.save(r, { type: 'rejected', message: '[39] FIRMA INVALIDA', requiresAttention: true });

    const types = (await OutboxModel.findAll()).map((e) => e.type).sort();
    expect(types).toEqual(['fiscal.ec.invoice.attention_required', 'fiscal.ec.invoice.rejected']);
    const attention = (await OutboxModel.findAll()).find((e) => e.type === 'fiscal.ec.invoice.attention_required')!;
    expect(attention.payload).toMatchObject({ invoiceId: payload.invoiceId, type: 'rejected', userId: 'user-1', message: '[39] FIRMA INVALIDA' });
  });

  it('guardar dos veces actualiza la misma fila (upsert) y no duplica', async () => {
    const r = record();
    await store.save(r);
    r.status = 'error';
    r.retry_count = 2;
    r.next_check_at = new Date('2026-09-13T17:05:00Z');
    await store.save(r);

    expect(await FiscalInvoiceModel.count()).toBe(1);
    expect(await store.findByBillingInvoiceId(r.billing_invoice_id)).toMatchObject({ status: 'error', retry_count: 2 });
  });

  it('si el evento no se puede escribir, el cambio de estado tampoco queda', async () => {
    const r = record({ status: 'pending' });
    await store.save(r);
    r.status = 'authorized';
    const tooLong = 'x'.repeat(200); // OutboxModel.type es VARCHAR(100)
    await expect(store.save(r, { type: tooLong as never, message: 'm', requiresAttention: false })).rejects.toThrow();

    expect((await store.findByBillingInvoiceId(r.billing_invoice_id))?.status).toBe('pending');
    expect(await OutboxModel.count()).toBe(0);
  });

  it('un número repetido falla y NO pisa la factura que ya lo tenía', async () => {
    const first = record({ number: '001-001-000000001', status: 'authorized' });
    await store.save(first);
    const intruder = record({ number: '001-001-000000001', status: 'error' });

    await expect(store.save(intruder, { type: 'error', message: 'x', requiresAttention: false })).rejects.toThrow();

    // Con `upsert` esta fila desaparecía, reemplazada por la del intruso.
    const kept = await store.findByBillingInvoiceId(first.billing_invoice_id);
    expect(kept).toMatchObject({ id: first.id, status: 'authorized' });
    expect(await store.findByBillingInvoiceId(intruder.billing_invoice_id)).toBeNull();
    expect(await OutboxModel.count()).toBe(0);

    await expect(store.save(record({ number: '001-001-000000001', organization_id: 'otra' }))).resolves.toBeUndefined();
  });

  it('guardar sin cambios reales no intenta insertar otra vez', async () => {
    const r = record();
    await store.save(r);
    await expect(store.save({ ...r })).resolves.toBeUndefined();
    expect(await FiscalInvoiceModel.count()).toBe(1);
  });

  it('findOtherWithNumber encuentra otra factura con el número, no la misma', async () => {
    const r = record({ number: '001-001-000000002' });
    await store.save(r);
    expect(await store.findOtherWithNumber('org-it', r.number, '01', r.billing_invoice_id)).toBeNull();
    expect((await store.findOtherWithNumber('org-it', r.number, '01', 'otra-factura'))?.id).toBe(r.id);
    // La nota de crédito 001-001-000000002 comparte número con la factura: es otra serie.
    expect(await store.findOtherWithNumber('org-it', r.number, '04', 'otra-factura')).toBeNull();
  });

  it('findDue devuelve solo las vencidas del estado pedido, la más atrasada primero', async () => {
    const now = new Date('2026-09-13T18:00:00Z');
    const late = record({ status: 'sent', next_check_at: new Date('2026-09-13T17:00:00Z') });
    const later = record({ status: 'sent', next_check_at: new Date('2026-09-13T17:30:00Z') });
    const future = record({ status: 'sent', next_check_at: new Date('2026-09-13T19:00:00Z') });
    const noCheck = record({ status: 'sent', next_check_at: null });
    const otherStatus = record({ status: 'error', next_check_at: new Date('2026-09-13T16:00:00Z') });
    for (const r of [later, future, noCheck, otherStatus, late]) await store.save(r);

    expect((await store.findDue('sent', now, 10)).map((r) => r.id)).toEqual([late.id, later.id]);
    expect((await store.findDue('sent', now, 1)).map((r) => r.id)).toEqual([late.id]);
  });

  it('findStalePending ignora las anuladas y las recientes', async () => {
    const old = record({ status: 'pending', updated_at: new Date('2026-09-13T16:00:00Z') });
    const recent = record({ status: 'pending', updated_at: new Date('2026-09-13T17:59:00Z') });
    const voided = record({ status: 'pending', updated_at: new Date('2026-09-13T16:00:00Z'), billing_voided_at: new Date() });
    for (const r of [old, recent, voided]) await store.save(r);

    expect((await store.findStalePending(new Date('2026-09-13T17:50:00Z'), 10)).map((r) => r.id)).toEqual([old.id]);
  });

  it('certificados: lista solo los activos de la organización y marca vencidos', async () => {
    const base = { organization_id: 'org-it', alias: 'c', p12_file_id: randomUUID(), password_encrypted: 'x' };
    await CertificateModel.bulkCreate([
      { ...base, id: 'c-activo', valid_from: '2026-01-01', valid_until: '2027-01-01', status: 'active', created_at: new Date('2026-02-01') },
      { ...base, id: 'c-nuevo', valid_from: '2026-01-01', valid_until: '2026-09-01', status: 'active', created_at: new Date('2026-03-01') },
      { ...base, id: 'c-revocado', valid_from: '2026-01-01', valid_until: '2027-01-01', status: 'revoked', created_at: new Date() },
      { ...base, id: 'c-otra-org', organization_id: 'otra', valid_from: '2026-01-01', valid_until: '2027-01-01', status: 'active', created_at: new Date() },
    ]);

    const active = await certificates.listActive('org-it');
    expect(active.map((c) => c.id)).toEqual(['c-nuevo', 'c-activo']);
    expect(active[0]).toMatchObject({ validFrom: '2026-01-01', validUntil: '2026-09-01' });

    await certificates.markExpired(['c-nuevo', 'c-revocado']);
    const statuses = Object.fromEntries((await CertificateModel.findAll()).map((c) => [c.id, c.status]));
    expect(statuses).toMatchObject({ 'c-nuevo': 'expired', 'c-revocado': 'revoked', 'c-activo': 'active' });
  });
});

describe('Procesador completo sobre MySQL (SRI y documentos simulados)', () => {
  beforeEach(async () => {
    await OutboxModel.destroy({ where: {} });
    await FiscalInvoiceModel.destroy({ where: {} });
    await CertificateModel.destroy({ where: {} });
    await CertificateModel.create({
      id: 'cert-it', organization_id: 'org-1', alias: 'firma', p12_file_id: 'p12', password_encrypted: 'x',
      valid_from: '2026-01-01', valid_until: '2027-01-01', status: 'active', created_at: new Date(),
    });
  });

  function processorWith(reception: Array<SriReceptionResponse | Error>, now: () => Date) {
    return new FiscalInvoiceProcessor({
      store: new SequelizeFiscalInvoiceStore(),
      certificates: new SequelizeCertificateStore(),
      documents: { upload: async () => randomUUID(), download: async () => Buffer.from('p12') },
      catalogs: {
        taxCodesById: async () => TAX_CODES,
        identificationTypeCode: async () => 'RUC',
        issuerProfile: async () => ({}),
      },
      sri: {
        send: async () => {
          const next = reception.shift()!;
          if (next instanceof Error) throw next;
          return next;
        },
        query: async () => ({ estado: 'AUTORIZADO', numeroAutorizacion: 'AUT', xmlAutorizado: '<ok/>' }),
      },
      signer: { sign: (xml) => ({ signedXml: xml }) },
      decryptPassword: () => 'clave',
      environment: 'pruebas',
      now,
      log: { log: () => {}, warn: () => {}, error: () => {} },
    });
  }

  it('fallo del SRI → reintento automático → autorizada, con la misma clave y un evento por paso', async () => {
    const { SriUnavailableError } = await import('../../infrastructure/http/sri-client.js');
    let now = new Date('2026-09-13T17:30:00Z');
    const processor = processorWith([new SriUnavailableError('caído'), { estado: 'RECIBIDA' }], () => now);

    const payload = sampleInvoice();
    const first = await processor.processIssued(payload);
    expect(first?.status).toBe('error');

    now = new Date(now.getTime() + RETRY_POLICY.baseDelayMs);
    await processor.runDueWork();
    now = new Date(now.getTime() + RETRY_POLICY.firstAuthorizationCheckMs);
    await processor.runDueWork();

    const row = await FiscalInvoiceModel.findOne({ where: { billing_invoice_id: payload.invoiceId } });
    expect(row?.status).toBe('authorized');
    expect(row?.access_key).toBe(first?.access_key);
    expect(row?.authorized_xml_file_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(await FiscalInvoiceModel.count()).toBe(1);

    // Sin orden: `occurred_at` es DATETIME de segundo y aquí los tres caen en el
    // mismo. En la vida real los separa el backoff (≥ 15 s).
    // El error de red se reintenta solo: no genera aviso de atención.
    const events = await OutboxModel.findAll();
    expect(events.map((e) => e.type).sort()).toEqual(
      ['fiscal.ec.invoice.authorized', 'fiscal.ec.invoice.error', 'fiscal.ec.invoice.sent'],
    );
  });

  it('un certificado vencido en la base se marca como expired', async () => {
    await CertificateModel.update({ valid_until: '2026-09-01' }, { where: { id: 'cert-it' } });
    const processor = processorWith([], () => new Date('2026-09-13T17:30:00Z'));

    const result = await processor.processIssued(sampleInvoice());
    expect(result?.last_error).toMatch(/venció/);
    expect((await CertificateModel.findByPk('cert-it'))?.status).toBe('expired');
  });
});

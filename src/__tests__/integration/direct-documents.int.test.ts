import { afterAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sampleWithholding } from '../fixtures.js';
import { columns, indexes } from './db.js';

// Los módulos de persistencia leen la configuración al importarse: se cargan después de que vitest ponga DB_NAME.
const { sequelize } = await import('../../infrastructure/persistence/sequelize.js');
const { FiscalInvoiceModel, FiscalSequenceModel, OutboxModel } = await import('../../infrastructure/persistence/models.js');
const { SequelizeDirectDocumentStore, SequelizeFiscalInvoiceStore } = await import('../../infrastructure/persistence/stores.js');
const { FiscalInvoiceProcessor } = await import('../../application/fiscal-processor.js');
const { DirectDocumentIssuer } = await import('../../application/direct-document-issuer.js');
const { createApp } = await import('../../interface/http/app.js');

afterAll(async () => {
  await sequelize.close();
});

const now = () => new Date('2026-10-14T17:30:00Z');
const EST = randomUUID();
const PT = randomUUID();

function pipeline(sri: { reception?: 'RECIBIDA' | 'DEVUELTA' } = {}) {
  const sent: string[] = [];
  const processor = new FiscalInvoiceProcessor({
    store: new SequelizeFiscalInvoiceStore(),
    certificates: {
      listActive: async () => [{ id: 'cert-it', p12FileId: 'file', passwordEncrypted: 'enc', validFrom: '2026-01-01', validUntil: '2027-01-01', status: 'active' as const, createdAt: new Date('2026-01-01') }],
      markExpired: async () => {},
    },
    documents: { upload: async () => randomUUID(), download: async () => Buffer.from('p12') },
    catalogs: { taxCodesById: async () => ({}), identificationTypeCode: async () => 'RUC', issuerProfile: async () => ({}) },
    sri: {
      send: async (xml) => { sent.push(xml); return { estado: sri.reception ?? 'RECIBIDA' }; },
      query: async () => ({ estado: 'AUTORIZADO', numeroAutorizacion: 'AUT-77', fechaAutorizacion: '2026-10-14T12:31:00-05:00', xmlAutorizado: '<autorizacion/>' }),
    },
    signer: { sign: (xml) => ({ signedXml: xml }) },
    decryptPassword: () => 'clave',
    environment: 'pruebas',
    now,
    log: { log: () => {}, warn: () => {}, error: () => {} },
  });
  const issuer = new DirectDocumentIssuer({
    issuers: {
      resolve: async () => ({
        legalName: 'Comercial Ejemplo S.A.', tradeName: null, taxId: '1792175606001',
        establishmentCode: '001', emissionPointCode: '001', address: 'Av. Amazonas N34-12, Quito',
      }),
    },
    store: new SequelizeDirectDocumentStore(),
    processor,
    now,
  });
  return { processor, issuer, sent, app: createApp({ corsOrigin: '*', documents: { upload: async () => 'x', download: async () => Buffer.from('') }, issuer }) };
}

const withholdingBody = (over: Record<string, unknown> = {}) => ({
  establishmentId: EST,
  emissionPointId: PT,
  subject: { identificationType: 'RUC', identification: '1790012345001', businessName: 'Proveedor Andino', relatedParty: false },
  support: {
    number: '002-003-000004567',
    issueDate: '2026-10-12',
    totalWithoutTaxes: '100.00',
    total: '115.00',
    taxes: [{ code: '2', percentageCode: '4', rate: 15, base: '100.00', amount: '15.00' }],
  },
  withholdings: [
    { tax: 'income', retentionCode: '312', base: '100.00', ratePercent: 1 },
    { tax: 'vat', retentionCode: '1', base: '15.00', ratePercent: 30 },
  ],
  ...over,
});

const post = (app: ReturnType<typeof createApp>, path: string, body: unknown, org: string, permissions: string) =>
  app.fetch(new Request(`http://localhost${path}`, {
    method: 'POST',
    headers: { 'X-Organization-Id': org, 'X-Permissions': permissions, 'X-User-Id': 'user-it', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }));

describe('migración de comprobantes propios de fiscal', () => {
  it('añade `source` a fiscal_invoices y crea la serie con su índice único', async () => {
    const db = sequelize.getDatabaseName();
    expect(db).toMatch(/^fiscal_it_/);
    const cols = await columns(db, 'fiscal_invoices');
    expect(cols.source).toMatchObject({ IS_NULLABLE: 'NO' });
    const seqCols = await columns(db, 'fiscal_sequences');
    expect(Object.keys(seqCols).sort()).toEqual(['current_value', 'document_type', 'emission_point_code', 'establishment_code', 'id', 'organization_id', 'updated_at']);
    const idx = await indexes(db, 'fiscal_sequences');
    expect(idx.find((i) => i.name === 'fiscal_sequences_series_unique')).toMatchObject({
      unique: true,
      columns: ['organization_id', 'establishment_code', 'emission_point_code', 'document_type'],
    });
  });
});

describe('SequelizeDirectDocumentStore contra MySQL', () => {
  const store = new SequelizeDirectDocumentStore();
  const build = (org: string, documentType: '06' | '07', emissionPointCode = '001') => (sequentialNumber: string) => {
    const id = randomUUID();
    const t = now();
    return {
      id, organization_id: org, billing_invoice_id: id, document_type: documentType, source: 'fiscal' as const,
      number: `001-${emissionPointCode}-${sequentialNumber}`, access_key: null, status: 'pending' as const, authorization_number: null,
      authorization_date: null, sri_response: null, signed_xml_file_id: null, authorized_xml_file_id: null,
      retry_count: 0, last_error: null, original_payload: null, next_check_at: null, billing_voided_at: null,
      created_at: t, updated_at: t,
    };
  };

  it('30 emisiones simultáneas de una serie nueva dan 30 números distintos y seguidos, sin interbloqueos', async () => {
    const org = `org-conc-${Date.now()}`;
    const results = await Promise.all(Array.from({ length: 30 }, () => store.createNumbered({
      organizationId: org, establishmentCode: '001', emissionPointCode: '001', documentType: '07', build: build(org, '07'),
    })));
    const numbers = results.map((r) => r.number).sort();
    expect(numbers).toEqual(Array.from({ length: 30 }, (_, i) => `001-001-${String(i + 1).padStart(9, '0')}`));
    expect(await FiscalInvoiceModel.count({ where: { organization_id: org } })).toBe(30);
    const counter = await FiscalSequenceModel.findOne({ where: { organization_id: org } });
    expect(counter?.current_value).toBe(30);
  });

  it('cada serie (tipo, punto, organización) lleva su propia cuenta', async () => {
    const org = `org-series-${Date.now()}`;
    const make = (documentType: '06' | '07', emissionPointCode = '001', organizationId = org) =>
      store.createNumbered({ organizationId, establishmentCode: '001', emissionPointCode, documentType, build: build(organizationId, documentType, emissionPointCode) });
    const numbers = [
      (await make('07')).number, (await make('07')).number, (await make('06')).number,
      (await make('07', '002')).number, (await make('07', '001', `${org}-otra`)).number,
    ];
    expect(numbers).toEqual(['001-001-000000001', '001-001-000000002', '001-001-000000001', '001-002-000000001', '001-001-000000001']);
  });

  it('si el alta falla, el número no se quema', async () => {
    const org = `org-rollback-${Date.now()}`;
    const params = { organizationId: org, establishmentCode: '001', emissionPointCode: '001', documentType: '07' as const };
    await expect(store.createNumbered({ ...params, build: () => { throw new Error('payload inválido'); } })).rejects.toThrow('payload inválido');
    const first = await store.createNumbered({ ...params, build: build(org, '07') });
    expect(first.number).toBe('001-001-000000001');
  });
});

describe('Emisión por HTTP, de punta a punta contra MySQL', () => {
  it('retención: 201, registro numerado y firmado, listado filtrado por tipo y detalle con el comprobante completo', async () => {
    const org = `org-ret-${Date.now()}`;
    const { app, sent } = pipeline();
    const res = await post(app, '/fiscal/withholdings', withholdingBody(), org, 'withholding:issue');
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toMatchObject({ document_type: '07', source: 'fiscal', number: '001-001-000000001', status: 'sent' });
    expect(body.payload.totalWithheldCents).toBe(5_50);
    expect(body.summary).toMatchObject({ kind: 'withholding', subject_name: 'Proveedor Andino', total_withheld_cents: 5_50, fiscal_period: '10/2026' });
    expect(sent[0]).toContain('<valorRetenido>4.50</valorRetenido>');

    const row = await FiscalInvoiceModel.findOne({ where: { organization_id: org } });
    expect(row).toMatchObject({ source: 'fiscal', document_type: '07', billing_invoice_id: row!.id });

    const list = await app.fetch(new Request('http://localhost/fiscal-invoices?document_type=07&source=fiscal', { headers: { 'X-Organization-Id': org, 'X-Permissions': 'fiscal:read' } }));
    const page = await list.json();
    expect(page.total).toBe(1);
    expect(page.items[0].payload).toBeUndefined();
    expect(page.items[0].summary.kind).toBe('withholding');

    const other = await app.fetch(new Request('http://localhost/fiscal-invoices?document_type=06', { headers: { 'X-Organization-Id': org, 'X-Permissions': 'fiscal:read' } }));
    expect((await other.json()).total).toBe(0);

    const detail = await app.fetch(new Request(`http://localhost/fiscal-invoices/${row!.id}`, { headers: { 'X-Organization-Id': org, 'X-Permissions': 'fiscal:read' } }));
    expect((await detail.json()).payload.support.number).toBe('002-003-000004567');
  });

  it('guía de remisión: 201 con su serie propia', async () => {
    const org = `org-guia-${Date.now()}`;
    const { app } = pipeline();
    const res = await post(app, '/fiscal/delivery-guides', {
      establishmentId: EST, emissionPointId: PT,
      carrier: { identificationType: 'RUC', identification: '1791234567001', businessName: 'Transportes Rápido', plate: 'pba-1234' },
      transportStart: '2026-10-15', transportEnd: '2026-10-16',
      recipients: [{ identification: '0992512549001', businessName: 'Farmacia La Salud', address: 'Guayaquil', reason: 'Venta', items: [{ description: 'Paracetamol', quantity: 20 }] }],
    }, org, 'delivery_guide:issue');
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ document_type: '06', number: '001-001-000000001', summary: { kind: 'delivery_guide', plate: 'PBA-1234', recipients_count: 1 } });
  });

  it('permisos: sin el permiso de emitir responde 403 y no crea nada', async () => {
    const org = `org-perm-${Date.now()}`;
    const { app } = pipeline();
    expect((await post(app, '/fiscal/withholdings', withholdingBody(), org, 'fiscal:read,invoice:issue')).status).toBe(403);
    expect((await post(app, '/fiscal/delivery-guides', {}, org, 'withholding:issue')).status).toBe(403);
    expect(await FiscalInvoiceModel.count({ where: { organization_id: org } })).toBe(0);
  });

  it('datos mal formados: 400 con el campo; datos que no cuadran: 422 con el motivo; ninguno consume número', async () => {
    const org = `org-val-${Date.now()}`;
    const { app } = pipeline();
    const bad = await post(app, '/fiscal/withholdings', withholdingBody({ support: { ...withholdingBody().support, total: '115,00' } }), org, 'withholding:issue');
    expect(bad.status).toBe(400);
    expect((await bad.json()).message).toMatch(/support\.total/);

    const mismatch = await post(app, '/fiscal/withholdings', withholdingBody({ withholdings: [{ tax: 'income', retentionCode: '312', base: '500.00', ratePercent: 1 }] }), org, 'withholding:issue');
    expect(mismatch.status).toBe(422);
    expect((await mismatch.json()).message).toMatch(/supera el subtotal/);
    expect(await FiscalInvoiceModel.count({ where: { organization_id: org } })).toBe(0);

    const ok = await post(app, '/fiscal/withholdings', withholdingBody(), org, 'withholding:issue');
    expect((await ok.json()).number).toBe('001-001-000000001');
  });

  it('el RIDE de una retención autorizada se genera como PDF', async () => {
    const org = `org-ride-${Date.now()}`;
    const { app, processor } = pipeline();
    const created = await (await post(app, '/fiscal/withholdings', withholdingBody(), org, 'withholding:issue')).json();
    const record = await new SequelizeFiscalInvoiceStore().findByBillingInvoiceId(created.billing_invoice_id);
    await processor.checkAuthorization(record!);

    const res = await app.fetch(new Request(`http://localhost/fiscal-invoices/${created.id}/ride`, { headers: { 'X-Organization-Id': org, 'X-Permissions': 'fiscal:read' } }));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/pdf');
    expect(Buffer.from(await res.arrayBuffer()).subarray(0, 5).toString()).toBe('%PDF-');
  });
});

describe('Evento contable de la retención autorizada', () => {
  it('al autorizarse se publica fiscal.ec.withholding.issued con lo retenido por impuesto; no antes', async () => {
    const org = `org-evt-${Date.now()}`;
    const { app, processor } = pipeline();
    const created = await (await post(app, '/fiscal/withholdings', withholdingBody(), org, 'withholding:issue')).json();

    const outboxFor = () => OutboxModel.findAll({ where: { aggregate_id: created.id } });
    expect((await outboxFor()).map((o) => o.type)).toEqual(['fiscal.ec.invoice.sent']);

    const record = await new SequelizeFiscalInvoiceStore().findByBillingInvoiceId(created.billing_invoice_id);
    await processor.checkAuthorization(record!);

    const types = (await outboxFor()).map((o) => o.type).sort();
    expect(types).toEqual(['fiscal.ec.invoice.authorized', 'fiscal.ec.invoice.sent', 'fiscal.ec.withholding.issued']);
    const event = (await outboxFor()).find((o) => o.type === 'fiscal.ec.withholding.issued')!;
    expect(event.payload).toMatchObject({
      withholdingId: created.id,
      organizationId: org,
      number: '001-001-000000001',
      incomeTaxWithheldCents: 1_00,
      vatWithheldCents: 4_50,
      isdWithheldCents: 0,
      totalWithheldCents: 5_50,
      supplier: { identification: '1790012345001', businessName: 'Proveedor Andino' },
      userId: 'user-it',
    });
    // Nada de datos de contacto del proveedor en el evento.
    expect(JSON.stringify(event.payload)).not.toContain('@');
  });

  it('una factura autorizada NO publica ese evento', async () => {
    const store = new SequelizeFiscalInvoiceStore();
    const id = randomUUID();
    const t = now();
    const payload = sampleWithholding({ invoiceId: id });
    await store.save({
      id, organization_id: 'org-noevt', billing_invoice_id: id, document_type: '01', source: 'billing', number: '001-001-000009001',
      access_key: null, status: 'authorized', authorization_number: 'A', authorization_date: t, sri_response: null, signed_xml_file_id: null,
      authorized_xml_file_id: null, retry_count: 0, last_error: null, original_payload: payload, next_check_at: null, billing_voided_at: null,
      created_at: t, updated_at: t,
    }, { type: 'authorized', message: 'ok', requiresAttention: false });
    expect((await OutboxModel.findAll({ where: { aggregate_id: id } })).map((o) => o.type)).toEqual(['fiscal.ec.invoice.authorized']);
  });
});

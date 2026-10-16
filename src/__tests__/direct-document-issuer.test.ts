import { describe, expect, it } from 'vitest';
import { DirectDocumentIssuer, type DeliveryGuideInput, type WithholdingInput } from '../application/direct-document-issuer.js';
import { RETRY_POLICY } from '../application/fiscal-processor.js';
import type { DirectDocumentStore, FiscalInvoiceRecord, IssuerDirectory } from '../application/ports.js';
import { FiscalValidationError } from '../domain/errors.js';
import type { DeliveryGuidePayload, WithholdingPayload } from '../domain/direct-documents.js';
import { SriUnavailableError } from '../infrastructure/http/sri-client.js';
import { setup } from './processor-harness.js';

/** El contador por serie, como lo lleva la tabla `fiscal_sequences`. */
class MemoryDirectStore implements DirectDocumentStore {
  counters = new Map<string, number>();
  constructor(private readonly records: Map<string, FiscalInvoiceRecord>) {}

  async createNumbered(input: Parameters<DirectDocumentStore['createNumbered']>[0]) {
    const key = [input.organizationId, input.establishmentCode, input.emissionPointCode, input.documentType].join('|');
    const next = (this.counters.get(key) ?? 0) + 1;
    const record = input.build(String(next).padStart(9, '0'));
    this.counters.set(key, next);
    this.records.set(record.id, structuredClone(record));
    return record;
  }
}

const issuers: IssuerDirectory = {
  async resolve(_org, establishmentId, emissionPointId) {
    if (establishmentId === 'est-roto') throw new FiscalValidationError('El establecimiento elegido no existe');
    return {
      legalName: 'Comercial Ejemplo S.A.',
      tradeName: 'Ejemplo',
      taxId: '1792175606001',
      establishmentCode: establishmentId === 'est-2' ? '002' : '001',
      emissionPointCode: emissionPointId === 'pt-2' ? '002' : '001',
      address: establishmentId === 'est-sin-dir' ? null : 'Av. Amazonas N34-12, Quito',
    };
  },
};

function build(options: Parameters<typeof setup>[0] = {}) {
  const t = setup(options);
  const direct = new MemoryDirectStore(t.store.records);
  const issuer = new DirectDocumentIssuer({
    issuers,
    store: direct,
    processor: t.processor,
    now: () => t.now,
    newId: (() => { let n = 0; return () => `direct-${++n}`; })(),
  });
  return { ...t, direct, issuer };
}

const ctx = { organizationId: 'org-1', userId: 'user-1' };

const withholdingInput = (over: Partial<WithholdingInput> = {}): WithholdingInput => ({
  establishmentId: 'est-1',
  emissionPointId: 'pt-1',
  subject: { identificationType: 'RUC', identification: '1790012345001', businessName: 'Proveedor Andino', email: 'ventas@andino.ec', phone: null, relatedParty: false },
  support: {
    number: '002-003-000004567',
    issueDate: '2026-09-12',
    authorizationNumber: '1209202601179001234500120020030000045671234567815',
    totalWithoutTaxesCents: 100_00,
    totalCents: 115_00,
    taxes: [{ code: '2', percentageCode: '4', rate: 15, baseCents: 100_00, amountCents: 15_00 }],
  },
  withholdings: [
    { tax: 'income', retentionCode: '312', baseCents: 100_00, ratePercent: 1 },
    { tax: 'vat', retentionCode: '1', baseCents: 15_00, ratePercent: 30 },
  ],
  ...over,
});

const guideInput = (over: Partial<DeliveryGuideInput> = {}): DeliveryGuideInput => ({
  establishmentId: 'est-1',
  emissionPointId: 'pt-1',
  carrier: { identificationType: 'RUC', identification: '1791234567001', businessName: 'Transportes Rápido S.A.', plate: 'pba-1234' },
  transportStart: '2026-09-14',
  transportEnd: '2026-09-15',
  recipients: [{
    identification: '0992512549001',
    businessName: 'Farmacia La Salud',
    address: 'Av. 9 de Octubre 100, Guayaquil',
    reason: 'Venta',
    items: [{ description: 'Paracetamol 500mg', quantity: 20 }],
  }],
  ...over,
});

describe('Retención', () => {
  it('numera en su propia serie, calcula lo retenido y lo envía al SRI firmado', async () => {
    const t = build();
    const record = await t.issuer.issueWithholding(ctx, withholdingInput());

    expect(record).toMatchObject({ document_type: '07', source: 'fiscal', number: '001-001-000000001', status: 'sent' });
    // La clave lleva el tipo de comprobante (posiciones 9 y 10) y el secuencial de la serie.
    expect(record.access_key!.slice(8, 10)).toBe('07');
    expect(record.access_key).toContain('000000001');
    expect(record.billing_invoice_id).toBe(record.id);

    const payload = record.original_payload as WithholdingPayload;
    expect(payload).toMatchObject({ documentTypeCode: '07', number: '001-001-000000001', userId: 'user-1', fiscalPeriod: '09/2026', totalWithheldCents: 5_50 });
    expect(payload.withholdings.map((w) => w.amountCents)).toEqual([1_00, 4_50]);
    expect(payload.issueDate).toBe(t.now.toISOString());

    expect(t.sent).toHaveLength(1);
    expect(t.sent[0]).toContain('<comprobanteRetencion id="comprobante" version="2.0.0">');
    expect(t.sent[0]).toContain('<codDoc>07</codDoc>');
    expect(t.sent[0]).toContain('<ds:Signature/>');
    expect(t.uploads).toEqual([{ category: 'comprobante-firmado', resourceType: 'fiscal_invoice', originalName: 'retencion-001-001-000000001-firmado.xml' }]);
    expect(t.store.eventTypes()).toEqual(['sent']);
  });

  it('el número sigue por serie: otro punto de emisión empieza de nuevo y las retenciones no tocan la serie de las guías', async () => {
    const t = build();
    const a = await t.issuer.issueWithholding(ctx, withholdingInput());
    const b = await t.issuer.issueWithholding(ctx, withholdingInput());
    const c = await t.issuer.issueWithholding(ctx, withholdingInput({ emissionPointId: 'pt-2' }));
    const guide = await t.issuer.issueDeliveryGuide(ctx, guideInput());

    expect([a.number, b.number, c.number, guide.number]).toEqual(['001-001-000000001', '001-001-000000002', '001-002-000000001', '001-001-000000001']);
    expect(new Set([a.access_key, b.access_key, c.access_key, guide.access_key]).size).toBe(4);
  });

  it('lo que no cuadra se rechaza antes de reservar número: no se quema el secuencial', async () => {
    const t = build();
    await expect(t.issuer.issueWithholding(ctx, withholdingInput({ withholdings: [{ tax: 'income', retentionCode: '312', baseCents: 200_00, ratePercent: 1 }] }))).rejects.toThrow(/supera el subtotal/);
    await expect(t.issuer.issueWithholding(ctx, withholdingInput({ support: { ...withholdingInput().support, number: '1-2-3' } }))).rejects.toThrow(/000-000-000000000/);
    await expect(t.issuer.issueWithholding(ctx, withholdingInput({ support: { ...withholdingInput().support, issueDate: '2026-09-14' } }))).rejects.toThrow(/futura/);
    await expect(t.issuer.issueWithholding(ctx, withholdingInput({ subject: { ...withholdingInput().subject, identification: '123' } }))).rejects.toThrow(/RUC/);
    expect(t.store.records.size).toBe(0);

    const ok = await t.issuer.issueWithholding(ctx, withholdingInput());
    expect(ok.number).toBe('001-001-000000001');
  });

  it('si el emisor no se puede resolver no se emite nada', async () => {
    const t = build();
    await expect(t.issuer.issueWithholding(ctx, withholdingInput({ establishmentId: 'est-roto' }))).rejects.toThrow(/no existe/);
    expect(t.store.records.size).toBe(0);
  });

  it('una devolución del SRI deja la retención rechazada con el motivo', async () => {
    const t = build({ reception: [{ estado: 'DEVUELTA', mensajes: [{ identificador: '35', mensaje: 'ARCHIVO NO CUMPLE ESTRUCTURA XML', tipo: 'ERROR' }] }] });
    const record = await t.issuer.issueWithholding(ctx, withholdingInput());
    expect(record.status).toBe('rejected');
    expect(record.last_error).toMatch(/ESTRUCTURA XML/);
    expect(t.store.eventTypes()).toEqual(['rejected']);
  });

  it('si el SRI no responde queda en error y la reconciliación lo reintenta por el camino de las retenciones', async () => {
    const t = build({ reception: [new SriUnavailableError('SRI fuera de servicio'), { estado: 'RECIBIDA' }] });
    const record = await t.issuer.issueWithholding(ctx, withholdingInput());
    expect(record.status).toBe('error');
    expect(record.retry_count).toBe(1);

    t.advance(10 * 60_000);
    const done = await t.processor.runDueWork();
    expect(done.retries).toBe(1);
    const retried = t.store.only();
    expect(retried).toMatchObject({ status: 'sent', source: 'fiscal', document_type: '07' });
    // Misma clave de acceso: reenviar no crea otro comprobante.
    expect(retried.access_key).toBe(record.access_key);
    expect(t.sent[1]).toContain('<comprobanteRetencion');
  });

  it('el reintento manual de una retención en error reinicia la cuenta', async () => {
    const t = build({ reception: [new Error('socket hang up'), { estado: 'RECIBIDA' }] });
    const record = await t.issuer.issueWithholding(ctx, withholdingInput());
    expect(record.status).toBe('error');
    const retried = await t.processor.retry(t.store.only(), { manual: true });
    expect(retried?.status).toBe('sent');
    expect(retried?.retry_count).toBe(0);
  });

  it('autorizada: queda con su número de autorización y publica el evento de autorización', async () => {
    const t = build({ authorization: [{ estado: 'AUTORIZADO', numeroAutorizacion: 'AUT-7', fechaAutorizacion: '2026-09-13T12:31:00-05:00', xmlAutorizado: '<autorizacion/>' }] });
    const record = await t.issuer.issueWithholding(ctx, withholdingInput());
    t.advance(RETRY_POLICY.firstAuthorizationCheckMs + 1000);
    await t.processor.runDueWork();
    expect(t.store.only()).toMatchObject({ status: 'authorized', authorization_number: 'AUT-7' });
    expect(t.store.eventTypes()).toEqual(['sent', 'authorized']);
    expect(t.uploads.at(-1)!.originalName).toBe(`retencion-${record.number}-autorizado.xml`);
  });
});

describe('Guía de remisión', () => {
  it('numera, normaliza la placa y la envía firmada', async () => {
    const t = build();
    const record = await t.issuer.issueDeliveryGuide(ctx, guideInput());

    expect(record).toMatchObject({ document_type: '06', source: 'fiscal', number: '001-001-000000001', status: 'sent' });
    expect(record.access_key!.slice(8, 10)).toBe('06');
    const payload = record.original_payload as DeliveryGuidePayload;
    expect(payload.carrier.plate).toBe('PBA-1234');
    // Sin dirección de partida se usa la del establecimiento.
    expect(payload.originAddress).toBe('Av. Amazonas N34-12, Quito');
    expect(t.sent[0]).toContain('<guiaRemision id="comprobante" version="1.1.0">');
    expect(t.uploads[0]!.originalName).toBe('guia-remision-001-001-000000001-firmado.xml');
  });

  it.each([
    ['un traslado que ya empezó', { transportStart: '2026-09-12' }, /antes de la fecha de emisión/],
    ['un fin anterior al inicio', { transportEnd: '2026-09-13' }, /fin del traslado/],
    ['sin destinatarios', { recipients: [] }, /al menos un destinatario/],
    ['sin placa', { carrier: { ...guideInput().carrier, plate: '  ' } }, /placa/],
    ['una cantidad en cero', { recipients: [{ ...guideInput().recipients[0]!, items: [{ description: 'Caja', quantity: 0 }] }] }, /mayor que cero/],
    ['un destinatario sin mercadería', { recipients: [{ ...guideInput().recipients[0]!, items: [] }] }, /ninguna mercadería/],
    ['un sustento mal formado', { recipients: [{ ...guideInput().recipients[0]!, support: { documentCode: '01', number: 'abc', issueDate: '2026-09-12' } }] }, /000-000-000000000/],
  ])('rechaza %s sin quemar número', async (_name, over, message) => {
    const t = build();
    await expect(t.issuer.issueDeliveryGuide(ctx, guideInput(over))).rejects.toThrow(message);
    expect(t.store.records.size).toBe(0);
  });

  it('sin dirección de partida ni dirección del establecimiento no se emite', async () => {
    const t = build();
    await expect(t.issuer.issueDeliveryGuide(ctx, guideInput({ establishmentId: 'est-sin-dir' }))).rejects.toThrow(/dirección de partida/);
    const ok = await t.issuer.issueDeliveryGuide(ctx, guideInput({ establishmentId: 'est-sin-dir', originAddress: 'Bodega norte' }));
    expect((ok.original_payload as DeliveryGuidePayload).originAddress).toBe('Bodega norte');
  });
});

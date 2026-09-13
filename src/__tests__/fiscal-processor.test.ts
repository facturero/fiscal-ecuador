import { beforeEach, describe, expect, it } from 'vitest';
import { FiscalInvoiceProcessor, RETRY_POLICY, backoffDelayMs } from '../application/fiscal-processor.js';
import type {
  FiscalEvent,
  FiscalInvoiceRecord,
  FiscalInvoiceStore,
  FiscalStatus,
  SigningCertificate,
} from '../application/ports.js';
import type { SriAuthorizationResponse, SriReceptionResponse } from '../infrastructure/http/sri-client.js';
import { SriUnavailableError } from '../infrastructure/http/sri-client.js';
import { sampleInvoice, TAX_CODES } from './fixtures.js';

class MemoryStore implements FiscalInvoiceStore {
  records = new Map<string, FiscalInvoiceRecord>();
  events: Array<{ id: string; event: FiscalEvent }> = [];

  async findByBillingInvoiceId(id: string) {
    const r = [...this.records.values()].find((x) => x.billing_invoice_id === id);
    return r ? structuredClone(r) : null;
  }
  async findOtherWithNumber(org: string, number: string, billingId: string) {
    return [...this.records.values()].find((x) => x.organization_id === org && x.number === number && x.billing_invoice_id !== billingId) ?? null;
  }
  async save(record: FiscalInvoiceRecord, event?: FiscalEvent) {
    this.records.set(record.id, structuredClone(record));
    if (event) this.events.push({ id: record.id, event });
  }
  async findDue(status: FiscalStatus, now: Date) {
    return [...this.records.values()]
      .filter((r) => r.status === status && r.next_check_at && r.next_check_at <= now)
      .map((r) => structuredClone(r));
  }
  async findStalePending(before: Date) {
    return [...this.records.values()]
      .filter((r) => r.status === 'pending' && r.updated_at < before && !r.billing_voided_at)
      .map((r) => structuredClone(r));
  }
  only(): FiscalInvoiceRecord {
    return [...this.records.values()][0];
  }
  eventTypes(): string[] {
    return this.events.map((e) => e.event.type);
  }
}

const RECIBIDA: SriReceptionResponse = { estado: 'RECIBIDA' };

function certificate(overrides: Partial<SigningCertificate> = {}): SigningCertificate {
  return {
    id: 'cert-1', p12FileId: 'file-p12', passwordEncrypted: 'enc', validFrom: '2026-01-01', validUntil: '2027-01-01',
    status: 'active', createdAt: new Date('2026-01-01'), ...overrides,
  };
}

function setup(options: {
  certificates?: SigningCertificate[];
  reception?: Array<SriReceptionResponse | Error>;
  authorization?: Array<SriAuthorizationResponse | Error>;
  taxCodes?: Record<string, string> | undefined;
} = {}) {
  let now = new Date('2026-09-13T17:30:00Z');
  const store = new MemoryStore();
  const sent: string[] = [];
  const queried: string[] = [];
  const uploads: Array<{ category: string; resourceType: string }> = [];
  const expired: string[] = [];
  const reception = options.reception ?? [RECIBIDA];
  const authorization = options.authorization ?? [];
  let ids = 0;

  const processor = new FiscalInvoiceProcessor({
    store,
    certificates: {
      listActive: async () => options.certificates ?? [certificate()],
      markExpired: async (list) => { expired.push(...list); },
    },
    documents: {
      upload: async (p) => { uploads.push({ category: p.category, resourceType: p.resourceType }); return `file-${uploads.length}`; },
      download: async () => Buffer.from('p12'),
    },
    catalogs: {
      taxCodesById: async () => ('taxCodes' in options ? options.taxCodes : TAX_CODES),
      identificationTypeCode: async () => 'RUC',
      issuerProfile: async () => ({ obligadoContabilidad: 'SI' }),
    },
    sri: {
      send: async (xml) => {
        sent.push(xml);
        const next = reception.length > 1 ? reception.shift()! : reception[0];
        if (next instanceof Error) throw next;
        return next;
      },
      query: async (key) => {
        queried.push(key);
        const next = authorization.shift() ?? { estado: 'EN PROCESAMIENTO' as const };
        if (next instanceof Error) throw next;
        return next;
      },
    },
    signer: { sign: (xml) => ({ signedXml: xml.replace('</factura>', '<ds:Signature/></factura>') }) },
    decryptPassword: () => 'clave',
    environment: 'pruebas',
    now: () => now,
    newId: () => `fiscal-${++ids}`,
    log: { log: () => {}, warn: () => {}, error: () => {} },
  });

  return {
    processor, store, sent, queried, uploads, expired,
    advance(ms: number) { now = new Date(now.getTime() + ms); },
    get now() { return now; },
  };
}

describe('Emisión', () => {
  it('firma, envía y deja la factura en espera de autorización', async () => {
    const t = setup();
    const record = await t.processor.processIssued(sampleInvoice());

    expect(record?.status).toBe('sent');
    expect(record?.access_key).toMatch(/^\d{49}$/);
    expect(t.sent).toHaveLength(1);
    expect(t.sent[0]).toContain('<ds:Signature/>');
    expect(t.uploads).toEqual([{ category: 'comprobante-firmado', resourceType: 'fiscal_invoice' }]);
    expect(record?.next_check_at?.getTime()).toBe(t.now.getTime() + RETRY_POLICY.firstAuthorizationCheckMs);
    expect(t.store.eventTypes()).toEqual(['sent']);
  });

  it('no procesa facturas de otro país', async () => {
    const t = setup();
    expect(await t.processor.processIssued(sampleInvoice({ countryCode: 'CO' }))).toBeNull();
    expect(t.store.records.size).toBe(0);
  });

  it('una factura ya enviada no se reenvía', async () => {
    const t = setup();
    await t.processor.processIssued(sampleInvoice());
    await t.processor.processIssued(sampleInvoice());
    expect(t.sent).toHaveLength(1);
  });

  it('DEVUELTA queda rechazada con el mensaje del SRI y pide atención', async () => {
    const t = setup({ reception: [{ estado: 'DEVUELTA', mensajes: [{ identificador: '35', mensaje: 'ARCHIVO NO CUMPLE ESTRUCTURA XML' }] }] });
    const record = await t.processor.processIssued(sampleInvoice());
    expect(record?.status).toBe('rejected');
    expect(record?.last_error).toBe('[35] ARCHIVO NO CUMPLE ESTRUCTURA XML');
    expect(t.store.events.at(-1)?.event.requiresAttention).toBe(true);
  });

  it('"clave ya registrada" se trata como recibida y se pasa a consultar la autorización', async () => {
    const t = setup({ reception: [{ estado: 'DEVUELTA', mensajes: [{ identificador: '43', mensaje: 'CLAVE ACCESO REGISTRADA' }] }] });
    expect((await t.processor.processIssued(sampleInvoice()))?.status).toBe('sent');
  });

  it('una factura que no cuadra no llega al SRI', async () => {
    const t = setup();
    const record = await t.processor.processIssued(sampleInvoice({ totalCents: 99_99 }));
    expect(record?.status).toBe('error');
    expect(record?.last_error).toMatch(/El total/);
    expect(record?.next_check_at).toBeNull();
    expect(t.sent).toHaveLength(0);
  });

  it('un número de factura repetido en la organización se rechaza', async () => {
    const t = setup();
    await t.processor.processIssued(sampleInvoice());
    const record = await t.processor.processIssued(sampleInvoice({ invoiceId: 'otra-factura-de-billing' }));
    expect(record?.status).toBe('error');
    expect(record?.last_error).toMatch(/secuencial se reutilizó/);
    expect(t.sent).toHaveLength(1);
  });
});

describe('Tipo de identificación del comprador', () => {
  it('usa el código que trae la factura, sin depender de que el id exista en tax-service', async () => {
    const t = setup();
    const payload = sampleInvoice();
    payload.customerSnapshot = {
      ...payload.customerSnapshot!,
      identification: '1712345678',
      identificationTypeId: 'id-de-customer-service',
      identificationTypeCode: 'PASAPORTE',
    };

    await t.processor.processIssued(payload);

    // Con 10 dígitos, adivinar daría 05 (cédula).
    expect(t.sent[0]).toContain('<tipoIdentificacionComprador>06</tipoIdentificacionComprador>');
  });

  it('una factura antigua sin código cae al catálogo por id', async () => {
    const t = setup();
    const payload = sampleInvoice();
    delete payload.customerSnapshot!.identificationTypeCode;
    await t.processor.processIssued(payload);
    expect(t.sent[0]).toContain('<tipoIdentificacionComprador>04</tipoIdentificacionComprador>');
  });
});

describe('Certificados', () => {
  it('no firma con un certificado vencido y lo marca como vencido', async () => {
    const t = setup({ certificates: [certificate({ id: 'viejo', validUntil: '2026-09-12' })] });
    const record = await t.processor.processIssued(sampleInvoice());
    expect(record?.status).toBe('error');
    expect(record?.last_error).toMatch(/venció el 2026-09-12/);
    expect(t.expired).toEqual(['viejo']);
    expect(t.sent).toHaveLength(0);
  });

  it('elige el vigente aunque haya uno vencido más nuevo', async () => {
    const t = setup({
      certificates: [certificate({ id: 'nuevo-vencido', validUntil: '2026-09-01' }), certificate({ id: 'vigente' })],
    });
    expect((await t.processor.processIssued(sampleInvoice()))?.status).toBe('sent');
    expect(t.expired).toEqual(['nuevo-vencido']);
  });

  it('sin certificado el error menciona el certificado (lo comprueban los e2e)', async () => {
    const t = setup({ certificates: [] });
    expect((await t.processor.processIssued(sampleInvoice()))?.last_error).toMatch(/certificado/);
  });
});

describe('Reintentos ante fallos del SRI', () => {
  it('un fallo de red se reintenta solo, con backoff, y conserva la clave de acceso', async () => {
    const t = setup({ reception: [new SriUnavailableError('SRI recepción: sin respuesta en 30 s'), RECIBIDA] });
    const first = await t.processor.processIssued(sampleInvoice());

    expect(first?.status).toBe('error');
    expect(first?.retry_count).toBe(1);
    expect(first?.next_check_at?.getTime()).toBe(t.now.getTime() + backoffDelayMs(0));
    expect(t.store.events.at(-1)?.event.requiresAttention).toBe(false);

    t.advance(backoffDelayMs(0));
    await t.processor.runDueWork();

    const after = t.store.only();
    expect(after.status).toBe('sent');
    expect(after.access_key).toBe(first?.access_key);
    expect(t.sent).toHaveLength(2);
  });

  it('antes de su hora no se reintenta', async () => {
    const t = setup({ reception: [new SriUnavailableError('caído')] });
    await t.processor.processIssued(sampleInvoice());
    t.advance(backoffDelayMs(0) - 1);
    await t.processor.runDueWork();
    expect(t.sent).toHaveLength(1);
  });

  it('tras el máximo de intentos deja de reintentar y pide atención', async () => {
    const t = setup({ reception: [new SriUnavailableError('caído')] });
    await t.processor.processIssued(sampleInvoice());
    for (let i = 0; i < RETRY_POLICY.maxDeliveryAttempts; i++) {
      t.advance(RETRY_POLICY.maxDelayMs);
      await t.processor.runDueWork();
    }
    const record = t.store.only();
    expect(record.retry_count).toBe(RETRY_POLICY.maxDeliveryAttempts);
    expect(record.next_check_at).toBeNull();
    expect(record.last_error).toMatch(/se dejó de reintentar/);
    expect(t.store.events.at(-1)?.event.requiresAttention).toBe(true);
  });

  it('el reintento manual reinicia la cuenta', async () => {
    const t = setup({ certificates: [] });
    await t.processor.processIssued(sampleInvoice());
    const record = t.store.only();
    record.retry_count = 7;
    await t.store.save(record);

    const retried = await t.processor.processIssued(sampleInvoice(), { manual: true });
    expect(retried?.retry_count).toBe(0);
  });

  it('un envío que se quedó a medias (proceso muerto) se retoma', async () => {
    const t = setup();
    const record = await t.processor.processIssued(sampleInvoice());
    record!.status = 'pending';
    record!.next_check_at = null;
    await t.store.save(record!);

    t.advance(RETRY_POLICY.stalePendingMs + 1);
    await t.processor.runDueWork();
    expect(t.store.only().status).toBe('sent');
  });
});

describe('Autorización', () => {
  const authorized: SriAuthorizationResponse = {
    estado: 'AUTORIZADO',
    numeroAutorizacion: 'AUT-1',
    fechaAutorizacion: '2026-09-13T12:31:00-05:00',
    xmlAutorizado: '<autorizacion>xml oficial</autorizacion>',
  };

  it('guarda el XML autorizado como archivo y no dentro de la respuesta', async () => {
    const t = setup({ authorization: [authorized] });
    await t.processor.processIssued(sampleInvoice());
    t.advance(RETRY_POLICY.firstAuthorizationCheckMs);
    await t.processor.runDueWork();

    const record = t.store.only();
    expect(record.status).toBe('authorized');
    expect(record.authorization_number).toBe('AUT-1');
    expect(record.authorized_xml_file_id).toBe('file-2');
    expect(t.uploads.at(-1)).toEqual({ category: 'comprobante-autorizado', resourceType: 'fiscal_invoice' });
    expect(record.sri_response).not.toHaveProperty('xmlAutorizado');
    expect(t.store.eventTypes()).toEqual(['sent', 'authorized']);
  });

  it('EN PROCESAMIENTO espacia las consultas cada vez más', async () => {
    const t = setup({ authorization: [{ estado: 'EN PROCESAMIENTO' }, { estado: 'EN PROCESAMIENTO' }] });
    await t.processor.processIssued(sampleInvoice());

    t.advance(RETRY_POLICY.firstAuthorizationCheckMs);
    await t.processor.runDueWork();
    const first = t.store.only().next_check_at!.getTime() - t.now.getTime();

    t.advance(first);
    await t.processor.runDueWork();
    const second = t.store.only().next_check_at!.getTime() - t.now.getTime();

    expect(first).toBe(backoffDelayMs(1));
    expect(second).toBe(backoffDelayMs(2));
    expect(second).toBeGreaterThan(first);
  });

  it('un SOAP Fault al consultar no rechaza la factura: se vuelve a consultar', async () => {
    const t = setup({ authorization: [new SriUnavailableError('SRI autorización: SOAP Fault (x)'), authorized] });
    await t.processor.processIssued(sampleInvoice());
    t.advance(RETRY_POLICY.firstAuthorizationCheckMs);
    await t.processor.runDueWork();
    expect(t.store.only().status).toBe('sent');

    t.advance(RETRY_POLICY.maxDelayMs);
    await t.processor.runDueWork();
    expect(t.store.only().status).toBe('authorized');
  });

  it('NO AUTORIZADO queda rechazada', async () => {
    const t = setup({ authorization: [{ estado: 'NO AUTORIZADO', mensajes: [{ identificador: '39', mensaje: 'FIRMA INVALIDA' }] }] });
    await t.processor.processIssued(sampleInvoice());
    t.advance(RETRY_POLICY.firstAuthorizationCheckMs);
    await t.processor.runDueWork();
    expect(t.store.only()).toMatchObject({ status: 'rejected', last_error: '[39] FIRMA INVALIDA' });
  });
});

describe('Anulación en billing', () => {
  const voided = { invoiceId: sampleInvoice().invoiceId, number: '001-001-000000123', organizationId: 'org-1', voidedAt: '2026-09-13T18:00:00Z' };

  it('si ya estaba autorizada avisa de que hace falta nota de crédito', async () => {
    const t = setup({ authorization: [{ estado: 'AUTORIZADO', numeroAutorizacion: 'A' }] });
    await t.processor.processIssued(sampleInvoice());
    t.advance(RETRY_POLICY.firstAuthorizationCheckMs);
    await t.processor.runDueWork();

    await t.processor.processVoided(voided);
    const last = t.store.events.at(-1)!.event;
    expect(last.type).toBe('void_requires_action');
    expect(last.requiresAttention).toBe(true);
    expect(last.message).toMatch(/nota de crédito/);
  });

  it('si estaba en error ya no se reintenta ni se envía', async () => {
    const t = setup({ reception: [new SriUnavailableError('caído'), RECIBIDA] });
    await t.processor.processIssued(sampleInvoice());
    await t.processor.processVoided(voided);

    t.advance(RETRY_POLICY.maxDelayMs);
    await t.processor.runDueWork();
    expect(t.sent).toHaveLength(1);
    expect(t.store.only().next_check_at).toBeNull();
    expect(await t.processor.processIssued(sampleInvoice())).toMatchObject({ status: 'error' });
    expect(t.sent).toHaveLength(1);
  });

  it('es idempotente', async () => {
    const t = setup();
    await t.processor.processIssued(sampleInvoice());
    await t.processor.processVoided(voided);
    await t.processor.processVoided(voided);
    expect(t.store.eventTypes().filter((x) => x === 'void_requires_action')).toHaveLength(1);
  });
});

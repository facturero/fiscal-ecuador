import { FiscalInvoiceProcessor } from '../application/fiscal-processor.js';
import type {
  FiscalEvent,
  FiscalInvoiceRecord,
  FiscalInvoiceStore,
  FiscalStatus,
  SigningCertificate,
} from '../application/ports.js';
import type { SriAuthorizationResponse, SriReceptionResponse } from '../infrastructure/http/sri-client.js';
import { TAX_CODES } from './fixtures.js';

/** Dobles en memoria del procesador fiscal, compartidos por las pruebas que lo ejercitan de punta a punta. */
export class MemoryStore implements FiscalInvoiceStore {
  records = new Map<string, FiscalInvoiceRecord>();
  events: Array<{ id: string; event: FiscalEvent }> = [];

  async findByBillingInvoiceId(id: string) {
    const r = [...this.records.values()].find((x) => x.billing_invoice_id === id);
    return r ? structuredClone(r) : null;
  }
  async findOtherWithNumber(org: string, number: string, documentType: string, billingId: string) {
    return [...this.records.values()]
      .find((x) => x.organization_id === org && x.document_type === documentType && x.number === number && x.billing_invoice_id !== billingId) ?? null;
  }
  async findLatestBefore(org: string, number: string, documentType: string) {
    const prefix = number.slice(0, 8);
    const list = [...this.records.values()]
      .filter((x) => x.organization_id === org && x.document_type === documentType && x.number.startsWith(prefix) && x.number < number);
    if (!list.length) return null;
    list.sort((a, b) => (a.number < b.number ? -1 : a.number > b.number ? 1 : 0));
    return structuredClone(list[list.length - 1]);
  }
  async findBetween(org: string, fromNumber: string, toNumber: string, documentType: string) {
    const prefix = fromNumber.slice(0, 8);
    return [...this.records.values()]
      .filter((x) => x.organization_id === org && x.document_type === documentType && x.number.startsWith(prefix) && x.number > fromNumber && x.number < toNumber)
      .map((x) => structuredClone(x));
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

export const RECIBIDA: SriReceptionResponse = { estado: 'RECIBIDA' };

export function certificate(overrides: Partial<SigningCertificate> = {}): SigningCertificate {
  return {
    id: 'cert-1', p12FileId: 'file-p12', passwordEncrypted: 'enc', validFrom: '2026-01-01', validUntil: '2027-01-01',
    status: 'active', createdAt: new Date('2026-01-01'), ...overrides,
  };
}

export function setup(options: {
  certificates?: SigningCertificate[];
  reception?: Array<SriReceptionResponse | Error>;
  authorization?: Array<SriAuthorizationResponse | Error>;
  taxCodes?: Record<string, string> | undefined;
} = {}) {
  let now = new Date('2026-09-13T17:30:00Z');
  const store = new MemoryStore();
  const sent: string[] = [];
  const queried: string[] = [];
  const uploads: Array<{ category: string; resourceType: string; originalName: string }> = [];
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
      upload: async (p) => { uploads.push({ category: p.category, resourceType: p.resourceType, originalName: p.originalName }); return `file-${uploads.length}`; },
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
    signer: { sign: (xml) => ({ signedXml: xml.replace(/<\/[A-Za-z_][\w.-]*>$/, '<ds:Signature/></comprobante>') }) },
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


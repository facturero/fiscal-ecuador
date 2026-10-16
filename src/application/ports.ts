import type { InvoiceIssuedPayload } from '../domain/types.js';
import type { DirectDocumentType, DirectIssuerSnapshot, DirectPayload } from '../domain/direct-documents.js';
import type { IssuerFiscalProfile } from '../domain/invoice-xml-builder.js';
import type { SriAuthorizationResponse, SriReceptionResponse } from '../infrastructure/http/sri-client.js';

/** Lo que se guarda en `original_payload`: el evento de billing, o el comprobante que fiscal emitió directamente. */
export type StoredPayload = InvoiceIssuedPayload | DirectPayload;

/** De dónde viene el comprobante: un evento de billing, o una emisión directa en fiscal (retención, guía). */
export type FiscalSource = 'billing' | 'fiscal';

export type FiscalStatus = 'pending' | 'sent' | 'authorized' | 'rejected' | 'error';

export interface FiscalInvoiceRecord {
  id: string;
  organization_id: string;
  billing_invoice_id: string;
  /** Código SRI del comprobante ('01' factura, '04' nota de crédito, '05' nota de débito, '06' guía, '07' retención). */
  document_type: string;
  source: FiscalSource;
  number: string;
  access_key: string | null;
  status: FiscalStatus;
  authorization_number: string | null;
  authorization_date: Date | null;
  sri_response: unknown | null;
  signed_xml_file_id: string | null;
  authorized_xml_file_id: string | null;
  retry_count: number;
  last_error: string | null;
  original_payload: StoredPayload | null;
  next_check_at: Date | null;
  billing_voided_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

/** Lo que se publica en el outbox como `fiscal.ec.invoice.<type>`. */
export interface FiscalEvent {
  type: FiscalStatus | 'void_requires_action' | 'sequence_gap';
  message: string;
  /** Nadie lo va a arreglar solo: hace falta una persona. */
  requiresAttention: boolean;
}

export interface FiscalInvoiceStore {
  findByBillingInvoiceId(billingInvoiceId: string): Promise<FiscalInvoiceRecord | null>;
  /** Otra factura de billing con el mismo número y tipo de documento en la organización. */
  findOtherWithNumber(organizationId: string, number: string, documentType: string, billingInvoiceId: string): Promise<FiscalInvoiceRecord | null>;
  /** La factura del mismo establecimiento/punto y tipo con el número inmediatamente anterior. */
  findLatestBefore(organizationId: string, number: string, documentType: string): Promise<FiscalInvoiceRecord | null>;
  /** Las facturas del mismo establecimiento/punto y tipo entre dos números, excluidos ambos. */
  findBetween(organizationId: string, fromNumber: string, toNumber: string, documentType: string): Promise<FiscalInvoiceRecord[]>;
  /** Guarda el registro y, en la misma transacción, su evento. */
  save(record: FiscalInvoiceRecord, event?: FiscalEvent): Promise<void>;
  findDue(status: FiscalStatus, now: Date, limit: number): Promise<FiscalInvoiceRecord[]>;
  findStalePending(updatedBefore: Date, limit: number): Promise<FiscalInvoiceRecord[]>;
}

/** Emisión de comprobantes propios de fiscal: reserva el número y crea el registro de forma atómica. */
export interface DirectDocumentStore {
  /**
   * Reserva el siguiente secuencial de la serie (organización + establecimiento + punto + tipo) y crea el registro con él, todo en una
   * transacción: si algo falla no queda un número quemado ni un registro sin número. `build` recibe los 9 dígitos del secuencial.
   */
  createNumbered(input: {
    organizationId: string;
    establishmentCode: string;
    emissionPointCode: string;
    documentType: DirectDocumentType;
    build(sequentialNumber: string): FiscalInvoiceRecord;
  }): Promise<FiscalInvoiceRecord>;
}

export interface SigningCertificate {
  id: string;
  p12FileId: string;
  passwordEncrypted: string;
  validFrom: string;
  validUntil: string;
  status: 'active' | 'expired' | 'revoked';
  createdAt: Date;
}

export interface CertificateStore {
  /** Certificados en estado `active` de la organización, del más nuevo al más viejo. */
  listActive(organizationId: string): Promise<SigningCertificate[]>;
  markExpired(ids: string[]): Promise<void>;
}

export interface DocumentStore {
  upload(params: {
    resourceType: 'fiscal_invoice' | 'fiscal_certificate';
    /** document-service solo sirve el archivo a esta organización. */
    organizationId: string;
    resourceId: string;
    category: string;
    originalName: string;
    mimeType: string;
    buffer: Buffer;
  }): Promise<string>;
  download(fileId: string): Promise<Buffer>;
}

export interface FiscalCatalogs {
  /** id de tarifa → código de catálogo. `undefined` si tax-service no respondió. */
  taxCodesById(countryCode: string): Promise<Record<string, string> | undefined>;
  identificationTypeCode(countryCode: string, identificationTypeId: string): Promise<string | undefined>;
  issuerProfile(organizationId: string): Promise<IssuerFiscalProfile>;
}

/**
 * Quién emite y desde dónde: la razón social y el RUC de la organización, y los códigos de establecimiento y punto de emisión
 * elegidos. Billing los resuelve al emitir facturas; los comprobantes propios de fiscal los piden aquí. Lanza
 * `FiscalValidationError` si falta algo (organización sin RUC, establecimiento o punto inexistente o inactivo).
 */
export interface IssuerDirectory {
  resolve(organizationId: string, establishmentId: string, emissionPointId: string): Promise<DirectIssuerSnapshot>;
}

export interface SriGateway {
  send(signedXml: string): Promise<SriReceptionResponse>;
  query(accessKey: string): Promise<SriAuthorizationResponse>;
}

export interface XmlSigner {
  sign(unsignedXml: string, p12: Buffer, password: string): { signedXml: string };
}

export interface FiscalProcessorDeps {
  store: FiscalInvoiceStore;
  certificates: CertificateStore;
  documents: DocumentStore;
  catalogs: FiscalCatalogs;
  sri: SriGateway;
  signer: XmlSigner;
  decryptPassword(encrypted: string): string;
  environment: 'pruebas' | 'produccion';
  now?: () => Date;
  newId?: () => string;
  log?: Pick<Console, 'log' | 'warn' | 'error'>;
}

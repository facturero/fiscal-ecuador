import type { InvoiceIssuedPayload } from '../domain/types.js';
import type { IssuerFiscalProfile } from '../domain/invoice-xml-builder.js';
import type { SriAuthorizationResponse, SriReceptionResponse } from '../infrastructure/http/sri-client.js';

export type FiscalStatus = 'pending' | 'sent' | 'authorized' | 'rejected' | 'error';

export interface FiscalInvoiceRecord {
  id: string;
  organization_id: string;
  billing_invoice_id: string;
  /** Código SRI del comprobante ('01' factura, '04' nota de crédito). */
  document_type: string;
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
  original_payload: InvoiceIssuedPayload | null;
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

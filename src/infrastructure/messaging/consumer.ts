import { InboxConsumer, EventHandler } from '@facturero/outbox-relay';
import { FiscalInvoiceProcessor } from '../../application/fiscal-processor.js';
import type { InvoiceIssuedPayload, InvoiceVoidedPayload } from '../../domain/types.js';
import { signXmlWithP12 } from '../../domain/xml-signer.js';
import { decryptPassword } from '../crypto/certificate-crypto.js';
import { HttpDocumentStorage } from '../http/document-storage.js';
import { HttpFiscalCatalogs } from '../http/fiscal-catalogs.js';
import { querySriAuthorization, sendToSriReception } from '../http/sri-client.js';
import { SequelizeCertificateStore, SequelizeFiscalInvoiceStore } from '../persistence/stores.js';
import { sequelize } from '../persistence/sequelize.js';
import { config } from '../config.js';

export const fiscalInvoiceStore = new SequelizeFiscalInvoiceStore();

export const processor = new FiscalInvoiceProcessor({
  store: fiscalInvoiceStore,
  certificates: new SequelizeCertificateStore(),
  documents: new HttpDocumentStorage(config.DOCUMENT_SERVICE_URL, config.INTERNAL_SERVICE_SECRET),
  catalogs: new HttpFiscalCatalogs(config.TAX_SERVICE_URL, config.ORG_SERVICE_URL),
  sri: {
    send: (signedXml) => sendToSriReception(signedXml, config.SRI_RECEPTION_URL, config.SRI_TIMEOUT_MS),
    query: (accessKey) => querySriAuthorization(accessKey, config.SRI_AUTHORIZATION_URL, config.SRI_TIMEOUT_MS),
  },
  signer: { sign: signXmlWithP12 },
  decryptPassword: (encrypted) => decryptPassword(encrypted, config.CERTIFICATE_MASTER_KEY),
  environment: config.SRI_ENVIRONMENT,
});

export const invoiceIssuedHandler: EventHandler = {
  eventType: 'billing.invoice.issued',
  async handle(payload: unknown): Promise<void> {
    await processor.processIssued(payload as InvoiceIssuedPayload);
  },
};

export const invoiceVoidedHandler: EventHandler = {
  eventType: 'billing.invoice.voided',
  async handle(payload: unknown): Promise<void> {
    await processor.processVoided(payload as InvoiceVoidedPayload);
  },
};

const RECONCILIATION_INTERVAL_MS = 60_000;

/**
 * Cada minuto, lo que toque según `next_check_at`. El intervalo es el grano
 * fino; el ritmo real lo marca el backoff de cada factura. `running` evita que
 * una pasada lenta (el SRI tardando) se solape con la siguiente.
 */
export function reconciliationJob(): NodeJS.Timeout {
  console.log(`[fiscal-ecuador] Job de reconciliación cada ${RECONCILIATION_INTERVAL_MS / 1000} s`);
  let running = false;
  return setInterval(async () => {
    if (running) return;
    running = true;
    try {
      const done = await processor.runDueWork();
      if (done.authorizations || done.retries || done.stale) {
        console.log(`[fiscal-ecuador] Reconciliación: ${done.authorizations} consultas, ${done.retries} reintentos, ${done.stale} envíos a medias`);
      }
    } catch (err) {
      console.error('[fiscal-ecuador] Error en job de reconciliación:', err);
    } finally {
      running = false;
    }
  }, RECONCILIATION_INTERVAL_MS);
}

export async function startConsumers(): Promise<void> {
  if (!config.RABBITMQ_URL) {
    console.log('[fiscal-ecuador] RABBITMQ_URL no configurado, consumidores desactivados.');
    return;
  }

  try {
    const consumer = new InboxConsumer({
      sequelize,
      rabbitmqUrl: config.RABBITMQ_URL,
      exchange: 'crm.events',
      queue: 'fiscal-ecuador.invoices',
      bindings: ['billing.invoice.issued', 'billing.invoice.voided'],
      handlers: [invoiceIssuedHandler, invoiceVoidedHandler],
    });
    await consumer.start();
    console.log('[fiscal-ecuador] Consumidor de RabbitMQ iniciado.');
  } catch (err) {
    console.error('[fiscal-ecuador] Error al conectar consumidor con RabbitMQ:', err);
  }
}

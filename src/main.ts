import { serve } from '@hono/node-server';
import { config } from './infrastructure/config.js';
import { sequelize } from './infrastructure/persistence/sequelize.js';
import './infrastructure/persistence/models.js';
import { createApp } from './interface/http/app.js';
import { OutboxRelay } from '@facturero/outbox-relay';
import { startConsumers, reconciliationJob, processor, fiscalInvoiceStore } from './infrastructure/messaging/consumer.js';
import { HttpDocumentStorage } from './infrastructure/http/document-storage.js';

async function main(): Promise<void> {
  console.log('[fiscal-ecuador] config resuelta:', JSON.stringify({
    PORT: config.PORT,
    DB_HOST: config.DB_HOST,
    DB_NAME: config.DB_NAME,
    SRI_ENVIRONMENT: config.SRI_ENVIRONMENT,
    SRI_RECEPTION_URL: config.SRI_RECEPTION_URL,
    SRI_AUTHORIZATION_URL: config.SRI_AUTHORIZATION_URL,
    RABBITMQ_URL: config.RABBITMQ_URL || '(no configurado)',
  }));

  await sequelize.authenticate();
  await sequelize.sync();

  let relay: OutboxRelay | undefined;
  const app = createApp({
    corsOrigin: config.CORS_ORIGIN,
    documents: new HttpDocumentStorage(config.DOCUMENT_SERVICE_URL, config.INTERNAL_SERVICE_SECRET),
    onRetry: async (billingInvoiceId: string) => {
      const record = await fiscalInvoiceStore.findByBillingInvoiceId(billingInvoiceId);
      if (!record?.original_payload) {
        throw Object.assign(new Error('La factura no guarda los datos originales y no se puede reintentar'), {
          statusCode: 409,
          name: 'ConflictError',
        });
      }
      return processor.processIssued(record.original_payload, { manual: true });
    },
  });

  serve({ fetch: app.fetch, port: config.PORT });
  console.log(`[fiscal-ecuador] corriendo en puerto ${config.PORT}`);

  if (config.RABBITMQ_URL) {
    relay = new OutboxRelay({
      sequelize,
      rabbitmqUrl: config.RABBITMQ_URL,
      exchange: 'crm.events',
    });
    await relay.start();
    fiscalInvoiceStore.setOnCommit((tx) => relay?.attachToTransaction(tx));
    console.log('[fiscal-ecuador] OutboxRelay iniciado.');
  } else {
    console.log('[fiscal-ecuador] RABBITMQ_URL no configurado, outbox relay desactivado.');
  }

  await startConsumers();
  reconciliationJob();
}

main().catch((err) => {
  console.error('[fiscal-ecuador] error al iniciar:', err);
  process.exit(1);
});

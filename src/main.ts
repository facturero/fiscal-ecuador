import { serve } from '@hono/node-server';
import { config } from './infrastructure/config.js';
import { sequelize } from './infrastructure/persistence/sequelize.js';
import './infrastructure/persistence/models.js';
import { createApp } from './interface/http/app.js';
import { FiscalInvoiceModel } from './infrastructure/persistence/models.js';
import { OutboxRelay } from './infrastructure/messaging/relay.js';
import { startConsumers, reconciliationJob, reprocessInvoice } from './infrastructure/messaging/consumer.js';

async function main(): Promise<void> {
  console.log('[fiscal-ecuador] config resuelta:', JSON.stringify({
    PORT: config.PORT,
    DB_HOST: config.DB_HOST,
    DB_NAME: config.DB_NAME,
    SRI_ENVIRONMENT: config.SRI_ENVIRONMENT,
    RABBITMQ_URL: config.RABBITMQ_URL || '(no configurado)',
  }));

  await sequelize.authenticate();
  await sequelize.sync();

  const app = createApp({
    corsOrigin: config.CORS_ORIGIN,
    onRetry: async (billingInvoiceId: string) => {
      const invoice = await FiscalInvoiceModel.findOne({ where: { billing_invoice_id: billingInvoiceId } });
      if (!invoice || invoice.status !== 'error') return;
      const payload = invoice.original_payload as any;
      if (!payload) {
        console.error(`[fiscal-ecuador] No hay original_payload para ${billingInvoiceId}, no se puede reintentar`);
        return;
      }
      await reprocessInvoice(payload);
    },
  });

  serve({ fetch: app.fetch, port: config.PORT });
  console.log(`[fiscal-ecuador] corriendo en puerto ${config.PORT}`);

  if (config.RABBITMQ_URL) {
    const relay = new OutboxRelay();
    await relay.start(config.RABBITMQ_URL);
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

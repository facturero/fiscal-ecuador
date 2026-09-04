import { randomUUID } from 'node:crypto';
import { InboxConsumer, EventHandler } from '@facturero/outbox-relay';
import { FiscalInvoiceModel, CertificateModel, OutboxModel } from '../persistence/models.js';
import { HttpDocumentStorage } from '../http/document-storage.js';
import { sendToSriReception, querySriAuthorization } from '../http/sri-client.js';
import { buildAccessKey } from '../../domain/access-key.js';
import { buildInvoiceXml } from '../../domain/invoice-xml-builder.js';
import { signXmlWithP12, validateP12Password, extractP12Validity } from '../../domain/xml-signer.js';
import { decryptPassword, encryptPassword } from '../crypto/certificate-crypto.js';
import { HttpTaxRateCatalog } from '../http/tax-rate-catalog.js';
import { HttpIdentificationTypeCatalog } from '../http/identification-type-catalog.js';
import { HttpOrganizationCatalog } from '../http/organization-catalog.js';
import type { InvoiceIssuedPayload } from '../../domain/types.js';
import { config } from '../config.js';
import { sequelize } from '../persistence/sequelize.js';

const documentStorage = new HttpDocumentStorage(config.DOCUMENT_SERVICE_URL, config.INTERNAL_SERVICE_SECRET);
const taxRateCatalog = new HttpTaxRateCatalog(config.TAX_SERVICE_URL);
const identificationTypeCatalog = new HttpIdentificationTypeCatalog(config.TAX_SERVICE_URL);
const organizationCatalog = new HttpOrganizationCatalog(config.ORG_SERVICE_URL);

export async function reprocessInvoice(payload: InvoiceIssuedPayload): Promise<void> {
  await handleInvoiceIssuedCore(payload);
}

export const invoiceIssuedHandler: EventHandler = {
  eventType: 'billing.invoice.issued',
  async handle(payload: unknown): Promise<void> {
    await handleInvoiceIssuedCore(payload as InvoiceIssuedPayload);
  },
};

/**
 * Escribe el evento fiscal en el outbox DENTRO de la misma transacción que la
 * mutación de negocio, para que no queden eventos huérfanos si el proceso
 * muere entre ambas escrituras.
 */
async function publishFiscalEventInTx(
  fiscalInvoiceId: string,
  status: string,
  message: string,
  tx: unknown,
): Promise<void> {
  await OutboxModel.create(
    {
      id: randomUUID(),
      aggregate_type: 'fiscal_invoice',
      aggregate_id: fiscalInvoiceId,
      type: `fiscal.ec.invoice.${status}`,
      payload: { fiscalInvoiceId, status, message },
      occurred_at: new Date(),
      processed_at: null,
    },
    { transaction: tx as never },
  );
}

async function handleInvoiceIssuedCore(payload: InvoiceIssuedPayload): Promise<void> {
  if (payload.countryCode !== 'EC') {
    console.log(`[fiscal-ecuador] País ${payload.countryCode} ignorado, no es EC`);
    return;
  }

  console.log(`[fiscal-ecuador] Procesando factura ${payload.number} de org ${payload.organizationId}`);

  const existingInvoice = await FiscalInvoiceModel.findOne({ where: { billing_invoice_id: payload.invoiceId } });
  if (existingInvoice && existingInvoice.status !== 'error') {
    console.log(`[fiscal-ecuador] Factura ${payload.number} ya procesada (status=${existingInvoice.status}), skip`);
    return;
  }
  if (existingInvoice && existingInvoice.status === 'error') {
    console.log(`[fiscal-ecuador] Reintentando factura ${payload.number} (id=${existingInvoice.id}), se borra el intento anterior`);
    await existingInvoice.destroy();
  }

  const certificate = await CertificateModel.findOne({
    where: { organization_id: payload.organizationId, status: 'active' },
    order: [['created_at', 'DESC']],
  });

  if (!certificate) {
    console.log(`[fiscal-ecuador] Sin certificado activo para org ${payload.organizationId}, factura queda en error`);
    await sequelize.transaction(async (tx) => {
      const fiscalId = randomUUID();
      await FiscalInvoiceModel.create({
        id: fiscalId,
        organization_id: payload.organizationId,
        billing_invoice_id: payload.invoiceId,
        number: payload.number,
        access_key: '',
        status: 'error',
        retry_count: 0,
        last_error: 'Sin certificado activo',
        original_payload: payload,
        created_at: new Date(),
        updated_at: new Date(),
      }, { transaction: tx });
      await publishFiscalEventInTx(fiscalId, 'error', 'Sin certificado activo', tx);
    });
    return;
  }

  let p12Buffer: Buffer;
  try {
    p12Buffer = await documentStorage.downloadFile(certificate.p12_file_id);
    if (p12Buffer.length === 0) throw new Error('Buffer vacío');
    console.log(`[fiscal-ecuador] .p12 descargado (${p12Buffer.length} bytes)`);
  } catch (downloadErr: any) {
    console.error(`[fiscal-ecuador] Error descargando .p12:`, downloadErr);
    await sequelize.transaction(async (tx) => {
      const fiscalId = randomUUID();
      await FiscalInvoiceModel.create({
        id: fiscalId,
        organization_id: payload.organizationId,
        billing_invoice_id: payload.invoiceId,
        number: payload.number,
        access_key: '',
        status: 'error',
        retry_count: 0,
        last_error: `No se pudo leer el certificado: ${downloadErr.message}`,
        original_payload: payload,
        created_at: new Date(),
        updated_at: new Date(),
      }, { transaction: tx });
      await publishFiscalEventInTx(fiscalId, 'error', 'Error descargando certificado', tx);
    });
    return;
  }

  let certPassword: string;
  try {
    certPassword = decryptPassword(certificate.password_encrypted, config.CERTIFICATE_MASTER_KEY);
  } catch (decryptErr: any) {
    console.error(`[fiscal-ecuador] Error descifrando contraseña del certificado:`, decryptErr);
    await sequelize.transaction(async (tx) => {
      const fiscalId = randomUUID();
      await FiscalInvoiceModel.create({
        id: fiscalId,
        organization_id: payload.organizationId,
        billing_invoice_id: payload.invoiceId,
        number: payload.number,
        access_key: '',
        status: 'error',
        retry_count: 0,
        last_error: 'Error descifrando contraseña del certificado',
        original_payload: payload,
        created_at: new Date(),
        updated_at: new Date(),
      }, { transaction: tx });
      await publishFiscalEventInTx(fiscalId, 'error', 'Error de descifrado', tx);
    });
    return;
  }

  const issuer = payload.issuerSnapshot!;
  const establishmentCode = issuer.establishmentCode ?? '001';
  const emissionPointCode = issuer.emissionPointCode ?? '001';

  const accessKey = buildAccessKey({
    issueDate: new Date(),
    documentTypeCode: '01',
    issuerRuc: issuer.taxId,
    environment: config.SRI_ENVIRONMENT,
    establishmentCode,
    emissionPointCode,
    sequentialNumber: payload.sequentialNumber,
  });

  console.log(`[fiscal-ecuador] Clave de acceso generada: ${accessKey}`);

  let taxCodeById: Record<string, string> | undefined;
  try {
    const taxRates = await taxRateCatalog.findByCountry('EC');
    taxCodeById = Object.fromEntries(
      taxRates.filter(r => r.id).map(r => [r.id, r.code])
    );
  } catch {
    console.warn('[fiscal-ecuador] No se pudo obtener catálogo de tarifas, usando fallback');
  }

  let identificationTypeCode: string | undefined;
  try {
    const identTypes = await identificationTypeCatalog.findByCountry('EC');
    const customerIdentTypeId = payload.customerSnapshot?.identificationTypeId;
    if (customerIdentTypeId) {
      const found = identTypes.find(t => t.id === customerIdentTypeId);
      identificationTypeCode = found?.code ?? undefined;
    }
  } catch {
    console.warn('[fiscal-ecuador] No se pudo obtener catálogo de identificación, usando fallback');
  }

  let obligadoContabilidad: string | undefined;
  try {
    const org = await organizationCatalog.getOrganization(payload.organizationId);
    if (org?.settings && typeof org.settings.obligadoContabilidad === 'boolean') {
      obligadoContabilidad = org.settings.obligadoContabilidad ? 'SI' : 'NO';
    }
  } catch {
    console.warn('[fiscal-ecuador] No se pudo obtener org, usando default obligadoContabilidad');
  }

  const unsignedXml = buildInvoiceXml({
    payload,
    accessKey,
    environment: config.SRI_ENVIRONMENT,
    establishmentCode,
    emissionPointCode,
    sequentialNumber: payload.sequentialNumber,
    taxCodeById,
    identificationTypeCode,
    obligadoContabilidad,
  });

  console.log(`[fiscal-ecuador] XML unsigned generado (${unsignedXml.length} chars)`);

  let signedXml: string;
  let certSerial: string;
  try {
    const result = signXmlWithP12(unsignedXml, p12Buffer, certPassword);
    signedXml = result.signedXml;
    certSerial = result.certificateSerial;
    console.log(`[fiscal-ecuador] XML firmado correctamente, serial=${certSerial}`);
  } catch (signErr: any) {
    console.error(`[fiscal-ecuador] Error firmando XML:`, signErr);
    await sequelize.transaction(async (tx) => {
      const fiscalId = randomUUID();
      await FiscalInvoiceModel.create({
        id: fiscalId,
        organization_id: payload.organizationId,
        billing_invoice_id: payload.invoiceId,
        number: payload.number,
        access_key: accessKey,
        status: 'error',
        retry_count: 0,
        last_error: `Error de firma: ${signErr.message}`,
        original_payload: payload,
        created_at: new Date(),
        updated_at: new Date(),
      }, { transaction: tx });
      await publishFiscalEventInTx(fiscalId, 'error', `Error de firma: ${signErr.message}`, tx);
    });
    return;
  }

  let signedFileId = '';
  try {
    signedFileId = await documentStorage.upload({
      resourceId: payload.invoiceId,
      category: 'comprobante-firmado',
      originalName: `factura-${payload.number}-firmado.xml`,
      mimeType: 'application/xml',
      buffer: Buffer.from(signedXml, 'utf-8'),
    });
    console.log(`[fiscal-ecuador] XML firmado subido a document-service, fileId=${signedFileId}`);
  } catch (uploadErr: any) {
    console.error(`[fiscal-ecuador] Error subiendo XML firmado:`, uploadErr);
  }

  const fiscalId = randomUUID();
  await FiscalInvoiceModel.create({
    id: fiscalId,
    organization_id: payload.organizationId,
    billing_invoice_id: payload.invoiceId,
    number: payload.number,
    access_key: accessKey,
    status: 'pending',
    signed_xml_file_id: signedFileId || null,
    retry_count: 0,
    original_payload: payload,
    created_at: new Date(),
    updated_at: new Date(),
  });

  console.log(`[fiscal-ecuador] Factura fiscal ${fiscalId} creada en estado pending`);

  try {
    const reception = await sendToSriReception(signedXml, config.SRI_RECEPTION_URL);
    console.log(`[fiscal-ecuador] Respuesta recepción SRI: ${reception.estado}`);

    if (reception.estado === 'RECIBIDA') {
      await sequelize.transaction(async (tx) => {
        await FiscalInvoiceModel.update(
          { status: 'sent', updated_at: new Date(), sri_response: reception as any },
          { where: { id: fiscalId }, transaction: tx },
        );
        await publishFiscalEventInTx(fiscalId, 'sent', 'Enviado al SRI, esperando autorización', tx);
      });
      console.log(`[fiscal-ecuador] Factura ${fiscalId} enviada al SRI, esperando autorización`);
    } else {
      await sequelize.transaction(async (tx) => {
        await FiscalInvoiceModel.update(
          {
            status: 'rejected',
            updated_at: new Date(),
            sri_response: reception as any,
            last_error: reception.mensajes?.map((m: any) => m.mensaje).join('; ') ?? 'Rechazada por SRI',
          },
          { where: { id: fiscalId }, transaction: tx },
        );
        await publishFiscalEventInTx(
          fiscalId,
          'rejected',
          reception.mensajes?.map((m: any) => m.mensaje).join('; ') ?? 'Rechazada por SRI',
          tx,
        );
      });
      console.log(`[fiscal-ecuador] Factura ${fiscalId} rechazada por SRI en recepción`);
    }
  } catch (sriErr: any) {
    console.error(`[fiscal-ecuador] Error enviando a SRI:`, sriErr);
    await sequelize.transaction(async (tx) => {
      await FiscalInvoiceModel.update(
        { status: 'error', updated_at: new Date(), last_error: `Error SRI recepción: ${sriErr.message}` },
        { where: { id: fiscalId }, transaction: tx },
      );
      await publishFiscalEventInTx(fiscalId, 'error', `Error SRI recepción: ${sriErr.message}`, tx);
    });
  }
}

export async function reconciliationJob(): Promise<void> {
  console.log('[fiscal-ecuador] Iniciando job de reconciliación (cada 2 min)');

  setInterval(async () => {
    try {
      const pendingInvoices = await FiscalInvoiceModel.findAll({ where: { status: 'sent' }, limit: 10 });

      for (const invoice of pendingInvoices) {
        try {
          const auth = await querySriAuthorization(invoice.access_key, config.SRI_AUTHORIZATION_URL);
          console.log(`[fiscal-ecuador] Auth para ${invoice.access_key}: ${auth.estado}`);

          if (auth.estado === 'AUTORIZADO') {
            await sequelize.transaction(async (tx) => {
              await FiscalInvoiceModel.update(
                {
                  status: 'authorized',
                  authorization_number: auth.numeroAutorizacion ?? null,
                  authorization_date: auth.fechaAutorizacion ? new Date(auth.fechaAutorizacion) : null,
                  sri_response: auth as any,
                  updated_at: new Date(),
                },
                { where: { id: invoice.id }, transaction: tx },
              );
              await publishFiscalEventInTx(invoice.id, 'authorized', `Autorizado #${auth.numeroAutorizacion}`, tx);
            });
            console.log(`[fiscal-ecuador] Factura ${invoice.id} AUTORIZADA, #${auth.numeroAutorizacion}`);
          } else if (auth.estado === 'NO AUTORIZADO') {
            await sequelize.transaction(async (tx) => {
              await FiscalInvoiceModel.update(
                {
                  status: 'rejected',
                  sri_response: auth as any,
                  last_error: auth.mensajes?.map((m: any) => m.mensaje).join('; ') ?? 'No autorizada',
                  updated_at: new Date(),
                },
                { where: { id: invoice.id }, transaction: tx },
              );
              await publishFiscalEventInTx(invoice.id, 'rejected', auth.mensajes?.map((m: any) => m.mensaje).join('; ') ?? 'No autorizada', tx);
            });
            console.log(`[fiscal-ecuador] Factura ${invoice.id} NO AUTORIZADA`);
          }
        } catch (queryErr: any) {
          console.error(`[fiscal-ecuador] Error consultando auth para ${invoice.access_key}:`, queryErr.message);
        }
      }

      const stuckInvoices = await FiscalInvoiceModel.findAll({
        where: { status: 'sent' },
        order: [['updated_at', 'ASC']],
        limit: 5,
      });
      for (const inv of stuckInvoices) {
        if (inv.retry_count >= 30) {
          await sequelize.transaction(async (tx) => {
            await FiscalInvoiceModel.update(
              { status: 'error', last_error: 'Excedido límite de reintentos de reconciliación', updated_at: new Date() },
              { where: { id: inv.id }, transaction: tx },
            );
            await publishFiscalEventInTx(inv.id, 'error', 'Excedido límite de reintentos', tx);
          });
          console.error(`[fiscal-ecuador] ALERTA: Factura ${inv.id} excedió 30 intentos de reconciliación`);
        } else {
          await FiscalInvoiceModel.update(
            { retry_count: inv.retry_count + 1 },
            { where: { id: inv.id } },
          );
        }
      }
    } catch (err) {
      console.error('[fiscal-ecuador] Error en job de reconciliación:', err);
    }
  }, 120_000);
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
      bindings: ['billing.invoice.issued'],
      handlers: [invoiceIssuedHandler],
    });
    await consumer.start();
    console.log('[fiscal-ecuador] Consumidor de RabbitMQ iniciado.');
  } catch (err) {
    console.error('[fiscal-ecuador] Error al conectar consumidor con RabbitMQ:', err);
  }
}

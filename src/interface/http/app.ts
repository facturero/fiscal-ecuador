import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import { requireOrganization, requirePermission, errorHandler, ContextVariables } from './middlewares.js';
import { FiscalInvoiceModel, CertificateModel } from '../../infrastructure/persistence/models.js';
import { HttpDocumentStorage } from '../../infrastructure/http/document-storage.js';
import { config } from '../../infrastructure/config.js';
import { validateP12Password, extractP12Validity } from '../../domain/xml-signer.js';
import { encryptPassword } from '../../infrastructure/crypto/certificate-crypto.js';

type Vars = { Variables: ContextVariables };

const documentStorage = new HttpDocumentStorage(config.DOCUMENT_SERVICE_URL, config.INTERNAL_SERVICE_SECRET);

export interface AppDependencies {
  corsOrigin: string;
  onRetry?: (billingInvoiceId: string) => Promise<void>;
}

function toCertificateDTO(cert: CertificateModel) {
  return {
    id: cert.id,
    alias: cert.alias,
    valid_from: cert.valid_from,
    valid_until: cert.valid_until,
    status: cert.status,
    created_at: cert.created_at,
  };
}

export function healthRoutes(): Hono {
  const r = new Hono();
  r.get('/health', (c) => c.json({ status: 'ok' }));
  return r;
}

export function fiscalRoutes(deps: AppDependencies): Hono<Vars> {
  const r = new Hono<Vars>();

  r.get('/fiscal-invoices/:billingInvoiceId',
    requireOrganization(),
    requirePermission('fiscal:read'),
    async (c) => {
      const orgId = c.get('organizationId');
      const { billingInvoiceId } = c.req.param();
      const invoice = await FiscalInvoiceModel.findOne({
        where: { billing_invoice_id: billingInvoiceId, organization_id: orgId },
      });
      if (!invoice) return c.json({ code: 'NotFoundError', message: 'Factura fiscal no encontrada' }, 404);
      return c.json(invoice);
    },
  );

  r.get('/fiscal-invoices/:id/xml',
    requireOrganization(),
    requirePermission('fiscal:read'),
    async (c) => {
      const orgId = c.get('organizationId');
      const { id } = c.req.param();
      const invoice = await FiscalInvoiceModel.findOne({
        where: { id, organization_id: orgId },
      });
      if (!invoice) return c.json({ code: 'NotFoundError', message: 'Factura fiscal no encontrada' }, 404);
      if (!invoice.signed_xml_file_id) return c.json({ code: 'NotReadyError', message: 'XML aún no disponible' }, 404);
      return c.json({ fileId: invoice.signed_xml_file_id });
    },
  );

  r.post('/fiscal-invoices/:billingInvoiceId/retry',
    requireOrganization(),
    requirePermission('fiscal:manage'),
    async (c) => {
      const orgId = c.get('organizationId');
      const { billingInvoiceId } = c.req.param();
      const invoice = await FiscalInvoiceModel.findOne({
        where: { billing_invoice_id: billingInvoiceId, organization_id: orgId },
      });
      if (!invoice) return c.json({ code: 'NotFoundError', message: 'Factura fiscal no encontrada' }, 404);
      if (invoice.status !== 'error') return c.json({ code: 'BadRequestError', message: 'Solo se pueden reintentar facturas en estado error' }, 400);

      if (deps.onRetry) {
        await deps.onRetry(billingInvoiceId);
        return c.json({ message: 'Factura encolada para reintento', id: invoice.id });
      }

      await invoice.update({ status: 'pending', retry_count: 0, last_error: null, updated_at: new Date() });
      return c.json({ message: 'Factura marcada para reintento', id: invoice.id });
    },
  );

  r.get('/certificates',
    requireOrganization(),
    requirePermission('fiscal:manage'),
    async (c) => {
      const orgId = c.get('organizationId');
      const certs = await CertificateModel.findAll({ where: { organization_id: orgId } });
      return c.json(certs.map(toCertificateDTO));
    },
  );

  r.post('/certificates',
    requireOrganization(),
    requirePermission('fiscal:manage'),
    async (c) => {
      const orgId = c.get('organizationId');

      let body: Record<string, any>;
      let file: File | undefined;
      let password: string | undefined;
      let alias: string | undefined;

      const contentType = c.req.header('content-type') || '';
      if (contentType.includes('multipart/form-data')) {
        body = await c.req.parseBody() as Record<string, any>;
        file = body['file'] as File | undefined;
        password = body['password'] as string | undefined;
        alias = (body['alias'] as string) || 'Certificado';
      } else {
        body = await c.req.json() as Record<string, any>;
        password = body['password'] as string | undefined;
        alias = (body['alias'] as string) || 'Certificado';
        return c.json({ code: 'BadRequestError', message: 'Debe enviar el archivo .p12 como multipart/form-data' }, 400);
      }

      if (!file || !password) {
        return c.json({ code: 'BadRequestError', message: 'Falta el archivo .p12 o la contraseña' }, 400);
      }

      const buffer = Buffer.from(await file.arrayBuffer());

      try {
        validateP12Password(buffer, password);
      } catch {
        return c.json({ code: 'BadRequestError', message: 'La contraseña no corresponde al certificado, o el archivo no es un .p12 válido' }, 400);
      }

      let validFrom: string;
      let validUntil: string;
      try {
        const validity = extractP12Validity(buffer, password);
        validFrom = validity.validFrom;
        validUntil = validity.validUntil;
      } catch {
        return c.json({ code: 'BadRequestError', message: 'No se pudieron extraer las fechas del certificado' }, 400);
      }

      let uploadedFileId: string;
      try {
        uploadedFileId = await documentStorage.upload({
          resourceId: orgId,
          category: 'certificado',
          originalName: file.name,
          mimeType: 'application/x-pkcs12',
          buffer,
        });
      } catch (uploadErr: any) {
        return c.json({ code: 'UploadError', message: `Error subiendo certificado: ${uploadErr.message}` }, 500);
      }

      const encryptedPassword = encryptPassword(password, config.CERTIFICATE_MASTER_KEY);

      const cert = await CertificateModel.create({
        id: randomUUID(),
        organization_id: orgId,
        alias,
        p12_file_id: uploadedFileId,
        password_encrypted: encryptedPassword,
        valid_from: validFrom,
        valid_until: validUntil,
        status: 'active',
        created_at: new Date(),
      });

      return c.json(toCertificateDTO(cert), 201);
    },
  );

  r.delete('/certificates/:id',
    requireOrganization(),
    requirePermission('fiscal:manage'),
    async (c) => {
      const orgId = c.get('organizationId');
      const { id } = c.req.param();
      const cert = await CertificateModel.findOne({ where: { id, organization_id: orgId } });
      if (!cert) return c.json({ code: 'NotFoundError', message: 'Certificado no encontrado' }, 404);
      await cert.update({ status: 'revoked' });
      return c.json({ message: 'Certificado revocado' });
    },
  );

  return r;
}

export function createApp(deps: AppDependencies): Hono {
  const app = new Hono();

  app.use('*', errorHandler());

  app.route('/', healthRoutes());
  app.route('/', fiscalRoutes(deps));

  return app;
}

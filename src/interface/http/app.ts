import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import type { WhereOptions } from 'sequelize';
import { requireOrganization, requirePermission, requireAnyPermission, errorHandler, ContextVariables } from './middlewares.js';
import { FiscalInvoiceModel, CertificateModel } from '../../infrastructure/persistence/models.js';
import { config } from '../../infrastructure/config.js';
import { validateP12Password, extractP12Validity } from '../../domain/xml-signer.js';
import { ecuadorToday } from '../../domain/ecuador-time.js';
import { findSequenceGaps } from '../../domain/sequence-gaps.js';
import { encryptPassword } from '../../infrastructure/crypto/certificate-crypto.js';
import type { DocumentStore, FiscalInvoiceRecord } from '../../application/ports.js';

type Vars = { Variables: ContextVariables };

export interface AppDependencies {
  corsOrigin: string;
  documents: DocumentStore;
  /** Reprocesa una factura en error a partir de los datos que guardó. */
  onRetry?: (billingInvoiceId: string) => Promise<FiscalInvoiceRecord | null>;
}

const STATUSES = ['pending', 'sent', 'authorized', 'rejected', 'error'] as const;

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

/**
 * Lo que ve la interfaz de una factura fiscal. Antes se devolvía la fila entera,
 * incluido `original_payload` (la factura completa con datos del cliente) y la
 * respuesta cruda del SRI. Los nombres siguen en snake_case porque es lo que ya
 * consumen el frontend y los tests e2e.
 */
function toFiscalInvoiceDTO(invoice: FiscalInvoiceModel | FiscalInvoiceRecord) {
  const sri = (invoice.sri_response ?? null) as { mensajes?: unknown[]; xmlAutorizado?: string } | null;
  return {
    id: invoice.id,
    billing_invoice_id: invoice.billing_invoice_id,
    number: invoice.number,
    access_key: invoice.access_key,
    status: invoice.status,
    authorization_number: invoice.authorization_number,
    authorization_date: invoice.authorization_date,
    last_error: invoice.last_error,
    retry_count: invoice.retry_count,
    next_check_at: invoice.next_check_at,
    billing_voided_at: invoice.billing_voided_at,
    sri_messages: sri?.mensajes ?? [],
    has_signed_xml: Boolean(invoice.signed_xml_file_id),
    has_authorized_xml: Boolean(invoice.authorized_xml_file_id || sri?.xmlAutorizado),
    created_at: invoice.created_at,
    updated_at: invoice.updated_at,
  };
}

export function healthRoutes(): Hono {
  const r = new Hono();
  r.get('/health', (c) => c.json({ status: 'ok' }));
  return r;
}

export function fiscalRoutes(deps: AppDependencies): Hono<Vars> {
  const r = new Hono<Vars>();

  /** Listado paginado, para ver de un vistazo qué está pendiente o en error. */
  r.get('/fiscal-invoices',
    requireOrganization(),
    requirePermission('fiscal:read'),
    async (c) => {
      const orgId = c.get('organizationId');
      const status = c.req.query('status');
      const page = Math.max(1, Number.parseInt(c.req.query('page') ?? '1', 10) || 1);
      const pageSize = Math.min(100, Math.max(1, Number.parseInt(c.req.query('pageSize') ?? '20', 10) || 20));

      if (status && !(STATUSES as readonly string[]).includes(status)) {
        return c.json({ code: 'BadRequestError', message: `Estado desconocido: ${status}` }, 400);
      }

      const where: WhereOptions = { organization_id: orgId, ...(status ? { status } : {}) };
      const { rows, count } = await FiscalInvoiceModel.findAndCountAll({
        where,
        order: [['created_at', 'DESC']],
        limit: pageSize,
        offset: (page - 1) * pageSize,
      });
      return c.json({ items: rows.map(toFiscalInvoiceDTO), total: count, page, pageSize });
    },
  );

  /**
   * Huecos en la numeración que llegó a fiscal: facturas emitidas en billing
   * cuyo evento no se procesó, así que el SRI no las conoce. Ver domain/sequence-gaps.ts.
   * Va antes de `/:billingInvoiceId` para que no la capture esa ruta.
   */
  r.get('/fiscal-invoices/sequence-gaps',
    requireOrganization(),
    requirePermission('fiscal:read'),
    async (c) => {
      const rows = await FiscalInvoiceModel.findAll({
        where: { organization_id: c.get('organizationId') },
        attributes: ['number', 'document_type'],
        raw: true,
      });
      // Las series de facturas (01) y de notas de crédito (04) comparten el
      // formato de número pero son cuentas distintas en billing: se agrupan por
      // tipo para no reportar falsos huecos donde conviven ambas numeraciones.
      const series = findSequenceGaps(
        rows.map((r) => ({ number: r.number, series: `${r.document_type}|${r.number.slice(0, 8)}` })),
      );
      return c.json({ series, hasGaps: series.some((s) => s.missingCount > 0) });
    },
  );

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
      return c.json(toFiscalInvoiceDTO(invoice));
    },
  );

  /**
   * Qué XML hay. Si el SRI ya autorizó, es el autorizado (el comprobante legal);
   * antes siempre se devolvía el firmado aquí, que no lleva la autorización.
   */
  r.get('/fiscal-invoices/:id/xml',
    requireOrganization(),
    requirePermission('fiscal:read'),
    async (c) => {
      const invoice = await findOwned(c.req.param('id'), c.get('organizationId'));
      if (!invoice) return c.json({ code: 'NotFoundError', message: 'Factura fiscal no encontrada' }, 404);
      if (invoice.authorized_xml_file_id) return c.json({ fileId: invoice.authorized_xml_file_id, kind: 'authorized' });
      if (invoice.signed_xml_file_id) return c.json({ fileId: invoice.signed_xml_file_id, kind: 'signed' });
      return c.json({ code: 'NotReadyError', message: 'XML aún no disponible' }, 404);
    },
  );

  /** El XML como archivo descargable, autorizado si existe. */
  r.get('/fiscal-invoices/:id/xml/download',
    requireOrganization(),
    requirePermission('fiscal:read'),
    async (c) => {
      const invoice = await findOwned(c.req.param('id'), c.get('organizationId'));
      if (!invoice) return c.json({ code: 'NotFoundError', message: 'Factura fiscal no encontrada' }, 404);

      const sri = (invoice.sri_response ?? null) as { xmlAutorizado?: string } | null;
      let body: Buffer;
      let kind: 'autorizado' | 'firmado';
      if (invoice.authorized_xml_file_id) {
        body = await deps.documents.download(invoice.authorized_xml_file_id);
        kind = 'autorizado';
      } else if (sri?.xmlAutorizado) {
        // El SRI autorizó pero no se pudo guardar como archivo: vive en la respuesta.
        body = Buffer.from(sri.xmlAutorizado, 'utf-8');
        kind = 'autorizado';
      } else if (invoice.signed_xml_file_id) {
        body = await deps.documents.download(invoice.signed_xml_file_id);
        kind = 'firmado';
      } else {
        return c.json({ code: 'NotReadyError', message: 'XML aún no disponible' }, 404);
      }

      const filename = `factura-${invoice.number}-${kind}.xml`;
      return new Response(new Uint8Array(body), {
        headers: {
          'Content-Type': 'application/xml; charset=utf-8',
          'Content-Disposition': `attachment; filename="${filename}"`,
        },
      });
    },
  );

  // `invoice:authorize` es el permiso de "mandar al SRI para autorizar", que es
  // lo que hace un reintento. `fiscal:manage` se sigue aceptando (lo tenía antes)
  // pero además deja tocar el certificado de firma, así que no debería hacer
  // falta para reenviar una factura. FACTURACION-BRECHAS.md #33.
  r.post('/fiscal-invoices/:billingInvoiceId/retry',
    requireOrganization(),
    requireAnyPermission('invoice:authorize', 'fiscal:manage'),
    async (c) => {
      const orgId = c.get('organizationId');
      const { billingInvoiceId } = c.req.param();
      const invoice = await FiscalInvoiceModel.findOne({
        where: { billing_invoice_id: billingInvoiceId, organization_id: orgId },
      });
      if (!invoice) return c.json({ code: 'NotFoundError', message: 'Factura fiscal no encontrada' }, 404);
      if (invoice.status !== 'error') {
        return c.json({ code: 'BadRequestError', message: 'Solo se pueden reintentar facturas en estado error' }, 400);
      }
      if (invoice.billing_voided_at) {
        return c.json({ code: 'BadRequestError', message: 'La factura está anulada: no se envía al SRI' }, 400);
      }
      if (!deps.onRetry) {
        return c.json({ code: 'NotImplementedError', message: 'El reintento no está disponible' }, 501);
      }

      const result = await deps.onRetry(billingInvoiceId);
      return c.json({
        message: result?.status === 'error' ? 'Se reintentó y sigue en error' : 'Factura reintentada',
        id: invoice.id,
        invoice: result ? toFiscalInvoiceDTO(result) : null,
      });
    },
  );

  r.get('/certificates',
    requireOrganization(),
    requirePermission('fiscal:manage'),
    async (c) => {
      const orgId = c.get('organizationId');
      const certs = await CertificateModel.findAll({ where: { organization_id: orgId }, order: [['created_at', 'DESC']] });
      return c.json(certs.map(toCertificateDTO));
    },
  );

  r.get('/certificates/:id',
    requireOrganization(),
    requirePermission('fiscal:manage'),
    async (c) => {
      const cert = await CertificateModel.findOne({ where: { id: c.req.param('id'), organization_id: c.get('organizationId') } });
      if (!cert) return c.json({ code: 'NotFoundError', message: 'Certificado no encontrado' }, 404);
      return c.json(toCertificateDTO(cert));
    },
  );

  r.post('/certificates',
    requireOrganization(),
    requirePermission('fiscal:manage'),
    async (c) => {
      const orgId = c.get('organizationId');

      const contentType = c.req.header('content-type') || '';
      if (!contentType.includes('multipart/form-data')) {
        return c.json({ code: 'BadRequestError', message: 'Debe enviar el archivo .p12 como multipart/form-data' }, 400);
      }
      const body = await c.req.parseBody() as Record<string, unknown>;
      const file = body['file'] as File | undefined;
      const password = body['password'] as string | undefined;
      const alias = (body['alias'] as string) || 'Certificado';

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
        ({ validFrom, validUntil } = extractP12Validity(buffer, password));
      } catch {
        return c.json({ code: 'BadRequestError', message: 'No se pudieron extraer las fechas del certificado' }, 400);
      }

      // Antes se aceptaba un .p12 vencido: quedaba "activo" y cada factura
      // acababa rechazada por el SRI.
      const today = ecuadorToday();
      if (validUntil < today) {
        return c.json({ code: 'BadRequestError', message: `El certificado venció el ${validUntil}` }, 400);
      }
      if (validFrom > today) {
        return c.json({ code: 'BadRequestError', message: `El certificado no es válido hasta el ${validFrom}` }, 400);
      }

      let uploadedFileId: string;
      try {
        uploadedFileId = await deps.documents.upload({
          resourceType: 'fiscal_certificate',
          organizationId: orgId,
          resourceId: orgId,
          category: 'certificado',
          originalName: file.name,
          mimeType: 'application/x-pkcs12',
          buffer,
        });
      } catch (uploadErr) {
        return c.json({ code: 'UploadError', message: `Error subiendo certificado: ${(uploadErr as Error).message}` }, 500);
      }

      const cert = await CertificateModel.create({
        id: randomUUID(),
        organization_id: orgId,
        alias,
        p12_file_id: uploadedFileId,
        password_encrypted: encryptPassword(password, config.CERTIFICATE_MASTER_KEY),
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

async function findOwned(id: string, organizationId: string): Promise<FiscalInvoiceModel | null> {
  return FiscalInvoiceModel.findOne({ where: { id, organization_id: organizationId } });
}

export function createApp(deps: AppDependencies): Hono {
  const app = new Hono();

  app.use('*', errorHandler());

  app.route('/', healthRoutes());
  app.route('/', fiscalRoutes(deps));

  return app;
}

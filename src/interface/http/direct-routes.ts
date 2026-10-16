import { Hono } from 'hono';
import { z } from 'zod';
import { requireOrganization, requirePermission, requireAnyPermission, type ContextVariables } from './middlewares.js';
import type { DirectDocumentIssuer, DeliveryGuideInput, WithholdingInput } from '../../application/direct-document-issuer.js';
import { FiscalValidationError } from '../../domain/errors.js';
import {
  DOCUMENT_NUMBER,
  ISO_DAY,
  SUPPORT_CODES,
  VAT_PERCENTAGE_CODES,
  WITHHOLDING_CODE_SUGGESTIONS,
} from '../../domain/direct-documents.js';
import type { FiscalInvoiceRecord } from '../../application/ports.js';

type Vars = { Variables: ContextVariables };

/** `"100.50"` → 10050. Solo importes con hasta dos decimales: lo demás se rechaza, no se redondea. */
const money = z
  .string()
  .regex(/^\d{1,12}(\.\d{1,2})?$/, 'El importe debe tener hasta dos decimales (p. ej. 100.50)')
  .transform((value) => Math.round(Number(value) * 100));

const text = (max: number) => z.string().trim().min(1).max(max);
const optionalText = (max: number) => z.string().trim().max(max).nullish().transform((v) => v || null);

export const withholdingSchema = z.object({
  establishmentId: z.string().uuid(),
  emissionPointId: z.string().uuid(),
  subject: z.object({
    identificationType: z.enum(['RUC', 'CEDULA', 'PASAPORTE']),
    identification: text(20),
    businessName: text(300),
    email: z.string().trim().email().max(300).nullish().transform((v) => v || null),
    phone: optionalText(20),
    relatedParty: z.boolean().default(false),
  }),
  fiscalPeriod: z.string().regex(/^(0[1-9]|1[0-2])\/20\d\d$/, 'El periodo fiscal debe ser MM/AAAA').optional(),
  support: z.object({
    supportCode: z.string().regex(/^\d{2}$/).default('01'),
    documentCode: z.string().regex(/^\d{1,3}$/).default('01'),
    number: z.string().regex(DOCUMENT_NUMBER, 'El número del comprobante debe ser 000-000-000000000'),
    issueDate: z.string().regex(ISO_DAY, 'La fecha debe ser AAAA-MM-DD'),
    authorizationNumber: z.string().trim().regex(/^\d{10,49}$/, 'La autorización debe tener de 10 a 49 dígitos').nullish().transform((v) => v || null),
    totalWithoutTaxes: money,
    total: money,
    paymentMethodCode: z.string().regex(/^\d{2}$/).default('20'),
    taxes: z
      .array(
        z.object({
          code: z.enum(['2', '3', '5']),
          percentageCode: z.string().regex(/^\d{1,4}$/),
          rate: z.number().min(0).max(100),
          base: money,
          amount: money,
        }),
      )
      .min(1)
      .max(20),
  }),
  withholdings: z
    .array(
      z.object({
        tax: z.enum(['income', 'vat', 'isd']),
        retentionCode: z.string().trim().regex(/^[A-Za-z0-9]{1,5}$/, 'El código de retención debe tener de 1 a 5 caracteres'),
        base: money,
        ratePercent: z.number(),
      }),
    )
    .min(1)
    .max(30),
});

const partyIdentification = z.enum(['RUC', 'CEDULA', 'PASAPORTE', 'EXTERIOR']);

export const deliveryGuideSchema = z.object({
  establishmentId: z.string().uuid(),
  emissionPointId: z.string().uuid(),
  originAddress: optionalText(300),
  carrier: z.object({
    identificationType: partyIdentification,
    identification: text(20),
    businessName: text(300),
    plate: text(20),
    rise: optionalText(40),
  }),
  transportStart: z.string().regex(ISO_DAY, 'La fecha debe ser AAAA-MM-DD'),
  transportEnd: z.string().regex(ISO_DAY, 'La fecha debe ser AAAA-MM-DD'),
  recipients: z
    .array(
      z.object({
        identification: text(20),
        businessName: text(300),
        address: text(300),
        reason: text(300),
        route: optionalText(300),
        destinationEstablishmentCode: z.string().regex(/^\d{3}$/).nullish().transform((v) => v || null),
        customsDocument: optionalText(20),
        support: z
          .object({
            documentCode: z.string().regex(/^\d{2}$/).default('01'),
            number: z.string().regex(DOCUMENT_NUMBER, 'El número del comprobante debe ser 000-000-000000000'),
            issueDate: z.string().regex(ISO_DAY, 'La fecha debe ser AAAA-MM-DD'),
            authorizationNumber: z.string().trim().regex(/^\d{10,49}$/, 'La autorización debe tener de 10 a 49 dígitos').nullish().transform((v) => v || null),
          })
          .nullish()
          .transform((v) => v ?? null),
        items: z
          .array(
            z.object({
              internalCode: optionalText(25),
              additionalCode: optionalText(25),
              description: text(300),
              quantity: z.number().positive().max(999_999_999_999),
            }),
          )
          .min(1)
          .max(200),
      }),
    )
    .min(1)
    .max(50),
});

function toWithholdingInput(body: z.infer<typeof withholdingSchema>): WithholdingInput {
  return {
    establishmentId: body.establishmentId,
    emissionPointId: body.emissionPointId,
    subject: body.subject,
    fiscalPeriod: body.fiscalPeriod,
    support: {
      supportCode: body.support.supportCode,
      documentCode: body.support.documentCode,
      number: body.support.number,
      issueDate: body.support.issueDate,
      authorizationNumber: body.support.authorizationNumber,
      totalWithoutTaxesCents: body.support.totalWithoutTaxes,
      totalCents: body.support.total,
      paymentMethodCode: body.support.paymentMethodCode,
      taxes: body.support.taxes.map((t) => ({ code: t.code, percentageCode: t.percentageCode, rate: t.rate, baseCents: t.base, amountCents: t.amount })),
    },
    withholdings: body.withholdings.map((w) => ({ tax: w.tax, retentionCode: w.retentionCode, baseCents: w.base, ratePercent: w.ratePercent })),
  };
}

export interface DirectRoutesDeps {
  issuer: DirectDocumentIssuer;
  /** Cómo se serializa el registro; lo aporta `app.ts` para no duplicar el DTO. */
  toDto: (record: FiscalInvoiceRecord) => unknown;
}

/** Un dato mal puesto es un 422 con lo que falta; el resto de errores sigue su camino al manejador general. */
async function respond(c: { json: (body: unknown, status?: 201 | 400 | 422) => Response }, work: () => Promise<unknown>): Promise<Response> {
  try {
    return c.json(await work(), 201);
  } catch (err) {
    if (err instanceof FiscalValidationError) {
      return c.json({ code: 'ValidationError', message: err.message, problems: err.problems }, 422);
    }
    throw err;
  }
}

function invalid(c: { json: (body: unknown, status: 400) => Response }, error: z.ZodError): Response {
  return c.json(
    {
      code: 'BadRequestError',
      message: error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
      problems: error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    },
    400,
  );
}

export function directRoutes(deps: DirectRoutesDeps): Hono<Vars> {
  const r = new Hono<Vars>();

  /** Catálogos de apoyo para los formularios: códigos de retención, de sustento y de porcentaje de IVA. */
  r.get('/fiscal/withholding-codes',
    requireOrganization(),
    requireAnyPermission('fiscal:read', 'withholding:issue'),
    (c) => c.json({
      withholdingCodes: WITHHOLDING_CODE_SUGGESTIONS,
      supportCodes: SUPPORT_CODES,
      vatPercentageCodes: VAT_PERCENTAGE_CODES,
    }),
  );

  r.post('/fiscal/withholdings',
    requireOrganization(),
    requirePermission('withholding:issue'),
    async (c) => {
      const parsed = withholdingSchema.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) return invalid(c, parsed.error);
      return respond(c, async () =>
        deps.toDto(await deps.issuer.issueWithholding({ organizationId: c.get('organizationId'), userId: c.get('userId') || undefined }, toWithholdingInput(parsed.data))),
      );
    },
  );

  r.post('/fiscal/delivery-guides',
    requireOrganization(),
    requirePermission('delivery_guide:issue'),
    async (c) => {
      const parsed = deliveryGuideSchema.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) return invalid(c, parsed.error);
      const input: DeliveryGuideInput = parsed.data;
      return respond(c, async () =>
        deps.toDto(await deps.issuer.issueDeliveryGuide({ organizationId: c.get('organizationId'), userId: c.get('userId') || undefined }, input)),
      );
    },
  );

  return r;
}

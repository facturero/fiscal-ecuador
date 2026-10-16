import { FiscalValidationError } from './errors.js';

/**
 * Comprobantes que este servicio emite DIRECTAMENTE, sin pasar por billing: el comprobante de retención (07) y la guía de remisión
 * (06). Billing no los conoce (no son ventas), así que fiscal es su dueño: numera su propia serie, guarda sus datos en
 * `original_payload` y los lleva por el mismo camino hacia el SRI que las facturas (firma, recepción, autorización).
 */
export type DirectDocumentType = '06' | '07';

export function isDirectDocumentType(code: string | null | undefined): code is DirectDocumentType {
  return code === '06' || code === '07';
}

/** Identificación de una persona o empresa en un comprobante (Tabla 6 del SRI). */
export type PartyIdentificationType = 'RUC' | 'CEDULA' | 'PASAPORTE' | 'EXTERIOR';

export const PARTY_ID_CODES: Record<PartyIdentificationType, string> = {
  RUC: '04',
  CEDULA: '05',
  PASAPORTE: '06',
  EXTERIOR: '08',
};

export interface DirectIssuerSnapshot {
  legalName: string;
  tradeName?: string | null;
  taxId: string;
  establishmentCode: string;
  emissionPointCode: string;
  /** Dirección del establecimiento. */
  address?: string | null;
}

export interface DirectDocumentBase {
  /** Id propio del comprobante: es también el `billing_invoice_id` de su registro fiscal. */
  invoiceId: string;
  documentTypeCode: DirectDocumentType;
  organizationId: string;
  userId?: string;
  countryCode: 'EC';
  /** `ddd-ddd-ddddddddd`. */
  number: string;
  sequentialNumber: string;
  establishmentId: string;
  emissionPointId: string;
  /** Momento de emisión (ISO). */
  issueDate: string;
  issuerSnapshot: DirectIssuerSnapshot;
}

// ── Comprobante de retención ────────────────────────────────────────────────

/** Qué impuesto se retiene: renta (código SRI 1), IVA (2) o ISD (6). */
export type WithholdingTax = 'income' | 'vat' | 'isd';

export const WITHHOLDING_TAX_CODES: Record<WithholdingTax, '1' | '2' | '6'> = { income: '1', vat: '2', isd: '6' };

export interface WithholdingLine {
  tax: WithholdingTax;
  /** Código de la tabla de retenciones del SRI (303, 304, 9, 10…). */
  retentionCode: string;
  baseCents: number;
  /** Porcentaje a retener, con hasta dos decimales. */
  ratePercent: number;
  /** `base × porcentaje`, calculado aquí; nunca lo manda el cliente. */
  amountCents: number;
}

/** Un impuesto del comprobante de sustento (IVA, ICE o IRBPNR), tal como figura en la factura del proveedor. */
export interface SupportTax {
  /** Tabla 16: 2 IVA, 3 ICE, 5 IRBPNR. */
  code: '2' | '3' | '5';
  /** Tabla 17 (para IVA): 0, 2, 3, 4, 5, 6, 7, 8, 10. */
  percentageCode: string;
  rate: number;
  baseCents: number;
  amountCents: number;
}

export interface WithholdingPayload extends DirectDocumentBase {
  documentTypeCode: '07';
  /** El sujeto retenido: el proveedor al que se le retiene. */
  subject: {
    identificationType: Exclude<PartyIdentificationType, 'EXTERIOR'>;
    identification: string;
    businessName: string;
    email?: string | null;
    phone?: string | null;
    relatedParty: boolean;
  };
  /** `MM/AAAA`. */
  fiscalPeriod: string;
  support: {
    /** Tabla 5 (`codSustento`): para qué sirve la compra en las declaraciones. */
    supportCode: string;
    /** Tabla 4: tipo del comprobante de la compra (01 factura, 03 liquidación de compra, 41 reembolso…). */
    documentCode: string;
    /** `ddd-ddd-ddddddddd`. */
    number: string;
    /** `AAAA-MM-DD`: fecha del comprobante del proveedor (fecha de calendario, sin hora). */
    issueDate: string;
    authorizationNumber?: string | null;
    totalWithoutTaxesCents: number;
    totalCents: number;
    /** Tabla 24. */
    paymentMethodCode: string;
    taxes: SupportTax[];
  };
  withholdings: WithholdingLine[];
  totalWithheldCents: number;
}

// ── Guía de remisión ────────────────────────────────────────────────────────

export interface GuideItem {
  internalCode?: string | null;
  additionalCode?: string | null;
  description: string;
  quantity: number;
}

export interface GuideRecipient {
  identification: string;
  businessName: string;
  address: string;
  /** Motivo del traslado: venta, consignación, devolución, traslado entre bodegas… */
  reason: string;
  route?: string | null;
  /** Código (3 dígitos) del establecimiento de destino cuando es traslado entre establecimientos propios. */
  destinationEstablishmentCode?: string | null;
  customsDocument?: string | null;
  /** El comprobante que sustenta el traslado (normalmente la factura). */
  support?: {
    documentCode: string;
    number: string;
    /** `AAAA-MM-DD`. */
    issueDate: string;
    authorizationNumber?: string | null;
  } | null;
  items: GuideItem[];
}

export interface DeliveryGuidePayload extends DirectDocumentBase {
  documentTypeCode: '06';
  originAddress: string;
  carrier: {
    identificationType: PartyIdentificationType;
    identification: string;
    businessName: string;
    plate: string;
    rise?: string | null;
  };
  /** `AAAA-MM-DD`. */
  transportStart: string;
  transportEnd: string;
  recipients: GuideRecipient[];
}

export type DirectPayload = WithholdingPayload | DeliveryGuidePayload;

// ── Cálculos y validaciones compartidas ─────────────────────────────────────

/** `base × porcentaje / 100` en centavos, redondeo hacia arriba en la mitad. Con enteros: sin errores de coma flotante. */
export function withheldAmountCents(baseCents: number, ratePercent: number): number {
  const rateHundredths = Math.round(ratePercent * 100);
  return Math.floor((baseCents * rateHundredths + 5000) / 10000);
}

/** El esquema acepta `porcentajeRetener` con 3 dígitos como máximo (10, 2.75, 100), sin contar ceros finales. */
export function validateRate(ratePercent: number): string | null {
  if (!Number.isFinite(ratePercent) || ratePercent < 0 || ratePercent > 100) return 'el porcentaje debe estar entre 0 y 100';
  if (Math.abs(ratePercent * 100 - Math.round(ratePercent * 100)) > 1e-9) return 'el porcentaje admite hasta dos decimales';
  const digits = ratePercent.toFixed(2).replace(/\.?0+$/, '').replace('.', '').replace(/^0+/, '');
  if (digits.length > 3) return 'el SRI admite como máximo tres cifras en el porcentaje (p. ej. 10, 2.75, 100)';
  return null;
}

/** `ddd-ddd-ddddddddd`. */
export const DOCUMENT_NUMBER = /^\d{3}-\d{3}-\d{9}$/;
export const ISO_DAY = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

/** `AAAA-MM-DD` → `dd/mm/aaaa` sin pasar por `Date`: una fecha de calendario no debe moverse por la zona horaria. */
export function sriDateFromIsoDay(day: string): string {
  if (!ISO_DAY.test(day)) throw new FiscalValidationError(`Fecha inválida: "${day}" (se espera AAAA-MM-DD)`);
  const [y, m, d] = day.split('-');
  if (Number(y) < 2000 || Number(y) > 2099) throw new FiscalValidationError(`Año fuera de rango para el SRI: ${y}`);
  return `${d}/${m}/${y}`;
}

/**
 * Catálogo de retenciones de uso corriente, para que la pantalla sugiera el código y el porcentaje. Es una AYUDA, no una regla:
 * la tabla oficial del SRI cambia por resolución y el sistema no impide usar otro código o porcentaje (el SRI lo valida al
 * recibir). Los porcentajes de IVA son los de la tabla vigente de retención de IVA (10, 20, 30, 50, 70 y 100 %).
 */
export interface WithholdingCodeSuggestion {
  tax: WithholdingTax;
  code: string;
  description: string;
  ratePercent: number;
}

export const WITHHOLDING_CODE_SUGGESTIONS: readonly WithholdingCodeSuggestion[] = [
  { tax: 'income', code: '303', description: 'Honorarios profesionales y demás pagos por servicios relacionados con el título profesional', ratePercent: 10 },
  { tax: 'income', code: '304', description: 'Servicios predomina el intelecto no relacionados con el título profesional', ratePercent: 8 },
  { tax: 'income', code: '307', description: 'Servicios predomina la mano de obra', ratePercent: 2 },
  { tax: 'income', code: '308', description: 'Servicios entre sociedades', ratePercent: 2 },
  { tax: 'income', code: '309', description: 'Servicios de publicidad y comunicación', ratePercent: 1 },
  { tax: 'income', code: '310', description: 'Servicio de transporte privado de pasajeros o transporte público o privado de carga', ratePercent: 1 },
  { tax: 'income', code: '312', description: 'Transferencia de bienes muebles de naturaleza corporal', ratePercent: 1 },
  { tax: 'income', code: '320', description: 'Arrendamiento de bienes inmuebles', ratePercent: 8 },
  { tax: 'income', code: '322', description: 'Seguros y reaseguros (primas y cesiones)', ratePercent: 1 },
  { tax: 'income', code: '343', description: 'Otras retenciones aplicables el 1 %', ratePercent: 1 },
  { tax: 'income', code: '344', description: 'Otras retenciones aplicables el 2 %', ratePercent: 2 },
  { tax: 'income', code: '332', description: 'Pagos que no están sujetos a retención', ratePercent: 0 },
  { tax: 'vat', code: '9', description: 'Retención del 10 % del IVA', ratePercent: 10 },
  { tax: 'vat', code: '10', description: 'Retención del 20 % del IVA', ratePercent: 20 },
  { tax: 'vat', code: '1', description: 'Retención del 30 % del IVA', ratePercent: 30 },
  { tax: 'vat', code: '11', description: 'Retención del 50 % del IVA', ratePercent: 50 },
  { tax: 'vat', code: '2', description: 'Retención del 70 % del IVA', ratePercent: 70 },
  { tax: 'vat', code: '3', description: 'Retención del 100 % del IVA', ratePercent: 100 },
  { tax: 'vat', code: '7', description: 'Retención del 0 % del IVA', ratePercent: 0 },
  { tax: 'isd', code: '4580', description: 'Impuesto a la salida de divisas', ratePercent: 5 },
];

/** Tabla 5 (`codSustento`): la razón tributaria de la compra. */
export const SUPPORT_CODES: ReadonlyArray<{ code: string; description: string }> = [
  { code: '01', description: 'Crédito tributario para declaración de IVA (servicios y bienes distintos de inventarios y activos fijos)' },
  { code: '02', description: 'Costo o gasto para declaración de IR (servicios y bienes distintos de inventarios y activos fijos)' },
  { code: '03', description: 'Activo fijo: crédito tributario para declaración de IVA' },
  { code: '04', description: 'Activo fijo: costo o gasto para declaración de IR' },
  { code: '06', description: 'Inventario: crédito tributario para declaración de IVA' },
  { code: '07', description: 'Inventario: costo o gasto para declaración de IR' },
  { code: '00', description: 'Casos especiales cuyo sustento no aplica a las opciones anteriores' },
];

/** Tabla 17: código de porcentaje del IVA → tarifa. Lo que el sistema ofrece al registrar la compra. */
export const VAT_PERCENTAGE_CODES: ReadonlyArray<{ percentageCode: string; rate: number; description: string }> = [
  { percentageCode: '0', rate: 0, description: 'IVA 0 %' },
  { percentageCode: '2', rate: 12, description: 'IVA 12 %' },
  { percentageCode: '3', rate: 14, description: 'IVA 14 %' },
  { percentageCode: '4', rate: 15, description: 'IVA 15 %' },
  { percentageCode: '5', rate: 5, description: 'IVA 5 %' },
  { percentageCode: '10', rate: 13, description: 'IVA 13 %' },
  { percentageCode: '6', rate: 0, description: 'No objeto de IVA' },
  { percentageCode: '7', rate: 0, description: 'Exento de IVA' },
];

export function validateDocumentNumber(value: string, what: string): void {
  if (!DOCUMENT_NUMBER.test(value)) {
    throw new FiscalValidationError(`${what}: "${value}" no tiene el formato 000-000-000000000`);
  }
}

/** Valida y completa los importes de una retención: calcula cada valor retenido y el total. Lanza si algo no cuadra. */
export function computeWithholdings(
  support: WithholdingPayload['support'],
  lines: Array<Pick<WithholdingLine, 'tax' | 'retentionCode' | 'baseCents' | 'ratePercent'>>,
): { withholdings: WithholdingLine[]; totalWithheldCents: number } {
  const problems: string[] = [];
  const vatAmount = support.taxes.filter((t) => t.code === '2').reduce((sum, t) => sum + t.amountCents, 0);
  const taxesAmount = support.taxes.reduce((sum, t) => sum + t.amountCents, 0);

  if (support.totalWithoutTaxesCents < 0 || support.totalCents < 0) problems.push('Los importes del comprobante de sustento no pueden ser negativos');
  if (support.totalCents !== support.totalWithoutTaxesCents + taxesAmount) {
    problems.push(
      `El total del comprobante de sustento (${(support.totalCents / 100).toFixed(2)}) no es subtotal más impuestos ` +
        `(${((support.totalWithoutTaxesCents + taxesAmount) / 100).toFixed(2)})`,
    );
  }
  if (!lines.length) problems.push('Una retención necesita al menos un impuesto retenido');

  const withholdings: WithholdingLine[] = lines.map((line, i) => {
    const where = `Retención ${i + 1} (${line.retentionCode})`;
    if (!/^[A-Za-z0-9]{1,5}$/.test(line.retentionCode)) problems.push(`${where}: el código de retención debe tener de 1 a 5 caracteres`);
    if (!Number.isInteger(line.baseCents) || line.baseCents < 0) problems.push(`${where}: la base imponible debe ser un importe positivo`);
    const rateProblem = validateRate(line.ratePercent);
    if (rateProblem) problems.push(`${where}: ${rateProblem}`);

    // No se puede retener sobre más de lo que tiene el comprobante: la renta sobre el subtotal, el IVA sobre el IVA y el
    // ISD sobre el total pagado.
    const ceiling = line.tax === 'income' ? support.totalWithoutTaxesCents : line.tax === 'vat' ? vatAmount : support.totalCents;
    if (line.baseCents > ceiling) {
      problems.push(
        `${where}: la base (${(line.baseCents / 100).toFixed(2)}) supera ${line.tax === 'income' ? 'el subtotal' : line.tax === 'vat' ? 'el IVA' : 'el total'} ` +
          `del comprobante (${(ceiling / 100).toFixed(2)})`,
      );
    }
    return { ...line, amountCents: withheldAmountCents(line.baseCents, line.ratePercent) };
  });

  if (problems.length) throw new FiscalValidationError(problems);
  return { withholdings, totalWithheldCents: withholdings.reduce((sum, l) => sum + l.amountCents, 0) };
}

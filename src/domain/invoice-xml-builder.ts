import type { InvoiceIssuedPayload } from './types.js';
import { FiscalValidationError } from './errors.js';
import { sriDate } from './ecuador-time.js';
import { CONSUMIDOR_FINAL_ID } from './invoice-validation.js';
import { resolveTax, type ResolvedTax } from './sri-tax-codes.js';

/** Tabla 6 del SRI: tipo de identificación del comprador. */
const SRI_ID_TYPE_MAP: Record<string, string> = {
  RUC: '04',
  CEDULA: '05',
  PASAPORTE: '06',
  CONSUMIDOR_FINAL: '07',
  EXTERIOR: '08',
};

/** Tabla 24: "sin utilización del sistema financiero". Ver `paymentMethodCode`. */
const DEFAULT_PAYMENT_METHOD = '01';

/** `codigoPrincipal` admite como mucho 25 caracteres en el esquema v2.1.0. */
const MAX_PRODUCT_CODE = 25;

export interface IssuerFiscalProfile {
  /** `SI` / `NO`. */
  obligadoContabilidad?: string;
  /** Número de resolución de contribuyente especial, si lo es. */
  contribuyenteEspecial?: string;
  /** Leyenda RIMPE tal como la exige el SRI, p. ej. `CONTRIBUYENTE RÉGIMEN RIMPE`. */
  contribuyenteRimpe?: string;
  /** Número de resolución de agente de retención, si lo es. */
  agenteRetencion?: string;
  /** Dirección de la matriz; si falta se usa la del establecimiento. */
  dirMatriz?: string;
  /** Forma de pago por defecto de la organización (Tabla 24). */
  defaultPaymentMethodCode?: string;
}

export interface InvoiceXmlInput {
  payload: InvoiceIssuedPayload;
  accessKey: string;
  environment: 'pruebas' | 'produccion';
  issueDate: Date;
  establishmentCode: string;
  emissionPointCode: string;
  sequentialNumber: string;
  /** id de tarifa de tax-service → código de catálogo (`IVA15`...). Sin él solo se aceptan tarifas inequívocas. */
  taxCodeById?: Record<string, string>;
  /** Código de catálogo del tipo de identificación del comprador (`RUC`, `CEDULA`...). */
  identificationTypeCode?: string;
  issuerProfile?: IssuerFiscalProfile;
}

/**
 * Arma el XML sin firmar de una factura (codDoc 01, versión 2.1.0).
 *
 * El orden de los nodos sigue el esquema: el SRI valida contra el XSD y un nodo
 * fuera de sitio es un rechazo aunque el dato sea correcto.
 */
export function buildInvoiceXml(input: InvoiceXmlInput): string {
  const { payload, accessKey, environment } = input;
  const issuer = payload.issuerSnapshot;
  if (!issuer) throw new FiscalValidationError('La factura no trae los datos del emisor');

  const profile = input.issuerProfile ?? {};
  const taxCodeById = input.taxCodeById ?? {};
  const envCode = environment === 'produccion' ? '2' : '1';

  const establishmentAddress = issuer.address?.trim() || '';
  const dirMatriz = profile.dirMatriz?.trim() || establishmentAddress;
  if (!dirMatriz) {
    throw new FiscalValidationError('Falta la dirección del establecimiento (dirMatriz es obligatoria en el SRI)');
  }

  const resolveLineTax = (tax: InvoiceIssuedPayload['lines'][number]['taxes'][number]): ResolvedTax =>
    resolveTax({ kind: tax.kind, rateSnapshot: tax.rateSnapshot, catalogCode: taxCodeById[tax.taxRateId] });

  let totalDescuentoCents = 0;
  const totals = new Map<string, { codigo: string; baseCents: number; amountCents: number }>();

  const detalles = payload.lines.map((line) => {
    totalDescuentoCents += line.discountCents;

    const impuestosXml = line.taxes.map((tax) => {
      const resolved = resolveLineTax(tax);
      const key = `${resolved.codigo}:${resolved.codigoPorcentaje}`;
      const group = totals.get(key) ?? { codigo: resolved.codigo, baseCents: 0, amountCents: 0 };
      group.baseCents += tax.baseCents;
      group.amountCents += tax.amountCents;
      totals.set(key, group);

      return `          <impuesto>
            <codigo>${resolved.codigo}</codigo>
            <codigoPorcentaje>${resolved.codigoPorcentaje}</codigoPorcentaje>
            <tarifa>${resolved.tarifa.toFixed(2)}</tarifa>
            <baseImponible>${money(tax.baseCents)}</baseImponible>
            <valor>${money(tax.amountCents)}</valor>
          </impuesto>`;
    }).join('\n');

    return `      <detalle>
        <codigoPrincipal>${text(productCode(line.productCode, line.productId))}</codigoPrincipal>
        <descripcion>${text(line.description)}</descripcion>
        <cantidad>${quantity(line.quantity)}</cantidad>
        <precioUnitario>${money(line.unitPriceCents)}</precioUnitario>
        <descuento>${money(line.discountCents)}</descuento>
        <precioTotalSinImpuesto>${money(line.subtotalCents)}</precioTotalSinImpuesto>
        <impuestos>
${impuestosXml}
        </impuestos>
      </detalle>`;
  }).join('\n');

  const totalConImpuestosXml = Array.from(totals.entries()).map(([key, group]) => {
    const codigoPorcentaje = key.split(':')[1];
    return `      <totalImpuesto>
        <codigo>${group.codigo}</codigo>
        <codigoPorcentaje>${codigoPorcentaje}</codigoPorcentaje>
        <baseImponible>${money(group.baseCents)}</baseImponible>
        <valor>${money(group.amountCents)}</valor>
      </totalImpuesto>`;
  }).join('\n');

  const buyer = buyerFor(payload, input.identificationTypeCode);
  const paymentMethod = payload.paymentMethodCode || profile.defaultPaymentMethodCode || DEFAULT_PAYMENT_METHOD;
  if (!/^\d{2}$/.test(paymentMethod)) {
    throw new FiscalValidationError(`Forma de pago inválida: "${paymentMethod}" (debe ser un código de 2 dígitos de la Tabla 24)`);
  }

  const optional = (tag: string, value: string | null | undefined, indent: string) =>
    value?.trim() ? `\n${indent}<${tag}>${text(value.trim())}</${tag}>` : '';

  const adicionales = [
    buyer.email ? `    <campoAdicional nombre="Email">${text(buyer.email)}</campoAdicional>` : null,
    buyer.phone ? `    <campoAdicional nombre="Telefono">${text(buyer.phone)}</campoAdicional>` : null,
  ].filter(Boolean);
  // `infoAdicional` exige al menos un `campoAdicional`: vacío es un rechazo por esquema.
  const infoAdicionalXml = adicionales.length
    ? `\n  <infoAdicional>\n${adicionales.join('\n')}\n  </infoAdicional>`
    : '';

  return `<?xml version="1.0" encoding="UTF-8"?>
<factura id="comprobante" version="2.1.0">
  <infoTributaria>
    <ambiente>${envCode}</ambiente>
    <tipoEmision>1</tipoEmision>
    <razonSocial>${text(issuer.legalName)}</razonSocial>${optional('nombreComercial', issuer.tradeName, '    ')}
    <ruc>${text(issuer.taxId)}</ruc>
    <claveAcceso>${text(accessKey)}</claveAcceso>
    <codDoc>01</codDoc>
    <estab>${text(input.establishmentCode)}</estab>
    <ptoEmi>${text(input.emissionPointCode)}</ptoEmi>
    <secuencial>${text(input.sequentialNumber)}</secuencial>
    <dirMatriz>${text(dirMatriz)}</dirMatriz>${optional('agenteRetencion', profile.agenteRetencion, '    ')}${optional('contribuyenteRimpe', profile.contribuyenteRimpe, '    ')}
  </infoTributaria>
  <infoFactura>
    <fechaEmision>${sriDate(input.issueDate)}</fechaEmision>${optional('dirEstablecimiento', establishmentAddress, '    ')}${optional('contribuyenteEspecial', profile.contribuyenteEspecial, '    ')}
    <obligadoContabilidad>${text(profile.obligadoContabilidad ?? 'SI')}</obligadoContabilidad>
    <tipoIdentificacionComprador>${buyer.idType}</tipoIdentificacionComprador>
    <razonSocialComprador>${text(buyer.name)}</razonSocialComprador>
    <identificacionComprador>${text(buyer.identification)}</identificacionComprador>
    <totalSinImpuestos>${money(payload.subtotalCents)}</totalSinImpuestos>
    <totalDescuento>${money(totalDescuentoCents)}</totalDescuento>
    <totalConImpuestos>
${totalConImpuestosXml}
    </totalConImpuestos>
    <propina>0.00</propina>
    <importeTotal>${money(payload.totalCents)}</importeTotal>
    <moneda>DOLAR</moneda>
    <pagos>
      <pago>
        <formaPago>${paymentMethod}</formaPago>
        <total>${money(payload.totalCents)}</total>
      </pago>
    </pagos>
  </infoFactura>
  <detalles>
${detalles}
  </detalles>${infoAdicionalXml}
</factura>`;
}

interface Buyer {
  idType: string;
  name: string;
  identification: string;
  email: string | null;
  phone: string | null;
}

function buyerFor(payload: InvoiceIssuedPayload, identificationTypeCode?: string): Buyer {
  const customer = payload.customerSnapshot;
  const identification = customer?.identification?.trim() || CONSUMIDOR_FINAL_ID;

  if (identification === CONSUMIDOR_FINAL_ID) {
    return {
      idType: '07',
      name: 'CONSUMIDOR FINAL',
      identification: CONSUMIDOR_FINAL_ID,
      email: customer?.email ?? null,
      phone: customer?.phone ?? null,
    };
  }

  const idType = identificationTypeCode
    ? SRI_ID_TYPE_MAP[identificationTypeCode]
    : guessIdentificationType(identification);
  if (!idType) {
    throw new FiscalValidationError(`El tipo de identificación "${identificationTypeCode}" no tiene equivalente en el SRI`);
  }
  if (!customer?.businessName?.trim()) {
    throw new FiscalValidationError('Falta el nombre o razón social del comprador');
  }

  return {
    idType,
    name: customer.businessName,
    identification,
    email: customer.email ?? null,
    phone: customer.phone ?? null,
  };
}

function guessIdentificationType(identification: string): string {
  if (/^\d{13}$/.test(identification)) return '04';
  if (/^\d{10}$/.test(identification)) return '05';
  return '06';
}

/** El SKU si cabe; si no, el id interno sin guiones recortado a lo que admite el esquema. */
function productCode(sku: string | null | undefined, productId: string): string {
  const clean = sku?.trim();
  if (clean && clean.length <= MAX_PRODUCT_CODE) return clean;
  return productId.replace(/-/g, '').slice(0, MAX_PRODUCT_CODE);
}

function money(cents: number): string {
  return (cents / 100).toFixed(2);
}

/** Hasta 6 decimales (lo que admite el esquema), sin ceros de más pero con al menos 2. */
function quantity(value: number): string {
  return Number(value).toFixed(6).replace(/0{1,4}$/, '');
}

/**
 * Escapado mínimo. `'` y `"` no se escapan en texto a propósito: la firma se
 * calcula sobre el texto tal cual y el SRI la verifica tras canonicalizar, y la
 * canonicalización deja esas comillas sin escapar. Escaparlas aquí rompe el digest.
 */
function text(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

import type { InvoiceIssuedPayload } from './types.js';

const CODE_MAP: Record<string, string> = {
  IVA0: '0',
  IVA15: '4',
  NO_OBJETO: '6',
};

const SRI_ID_TYPE_MAP: Record<string, string> = {
  RUC: '04',
  CEDULA: '05',
  PASAPORTE: '06',
  CONSUMIDOR_FINAL: '07',
  EXTERIOR: '08',
};

function mapIvaCode(taxCode: string): string {
  return CODE_MAP[taxCode] ?? '4';
}

function mapIdentificationTypeCode(identTypeCode: string): string {
  return SRI_ID_TYPE_MAP[identTypeCode] ?? '07';
}

function centsToDecimal(cents: number): string {
  return (cents / 100).toFixed(2);
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export interface InvoiceXmlInput {
  payload: InvoiceIssuedPayload;
  accessKey: string;
  environment: 'pruebas' | 'produccion';
  establishmentCode: string;
  emissionPointCode: string;
  sequentialNumber: string;
  taxCodeById?: Record<string, string>;
  identificationTypeCode?: string;
  obligadoContabilidad?: string;
}

export function buildInvoiceXml(input: InvoiceXmlInput): string {
  const { payload, accessKey, environment } = input;
  const issuer = payload.issuerSnapshot!;
  const customer = payload.customerSnapshot;

  const envCode = environment === 'produccion' ? '2' : '1';
  const fechaEmision = formatFechaEmision(new Date());
  const obligadoContabilidad = input.obligadoContabilidad ?? 'SI';

  let totalDescuentoCents = 0;
  for (const line of payload.lines) {
    totalDescuentoCents += line.discountCents;
  }

  const taxCodeById = input.taxCodeById ?? {};
  const fallbackIdTypeCode = input.identificationTypeCode;

  const detalles = payload.lines.map(line => {
    const precioUnitario = centsToDecimal(line.unitPriceCents);
    const descuento = centsToDecimal(line.discountCents);
    const precioTotalSinImpuesto = centsToDecimal(line.subtotalCents);

    const impuestosXml = line.taxes.map(tax => {
      const taxCode = taxCodeById[tax.taxRateId] ?? tax.rateSnapshot;
      const codigo = tax.kind === 'vat' ? '2' : '2';
      const codigoPorcentaje = mapIvaCode(taxCode);
      const tarifa = taxCode === 'NO_OBJETO' ? '0.00' : `${tax.rateSnapshot}.00`;
      const baseImponible = centsToDecimal(tax.baseCents);
      const valor = centsToDecimal(tax.amountCents);

      return `          <impuesto>
            <codigo>${escapeXml(codigo)}</codigo>
            <codigoPorcentaje>${escapeXml(codigoPorcentaje)}</codigoPorcentaje>
            <tarifa>${escapeXml(tarifa)}</tarifa>
            <baseImponible>${escapeXml(baseImponible)}</baseImponible>
            <valor>${escapeXml(valor)}</valor>
          </impuesto>`;
    }).join('\n');

    return `      <detalle>
        <codigoPrincipal>${escapeXml(line.productId)}</codigoPrincipal>
        <descripcion>${escapeXml(line.description)}</descripcion>
        <cantidad>${line.quantity}</cantidad>
        <precioUnitario>${escapeXml(precioUnitario)}</precioUnitario>
        <descuento>${escapeXml(descuento)}</descuento>
        <precioTotalSinImpuesto>${escapeXml(precioTotalSinImpuesto)}</precioTotalSinImpuesto>
        <impuestos>
${impuestosXml}
        </impuestos>
      </detalle>`;
  }).join('\n');

  const totalImpuestosMap = new Map<string, { baseCents: number; amountCents: number }>();
  for (const line of payload.lines) {
    for (const tax of line.taxes) {
      const taxCode = taxCodeById[tax.taxRateId] ?? tax.rateSnapshot;
      const key = mapIvaCode(taxCode);
      const existing = totalImpuestosMap.get(key);
      if (existing) {
        existing.baseCents += tax.baseCents;
        existing.amountCents += tax.amountCents;
      } else {
        totalImpuestosMap.set(key, { baseCents: tax.baseCents, amountCents: tax.amountCents });
      }
    }
  }

  const totalConImpuestosXml = Array.from(totalImpuestosMap.entries()).map(([codigoPorcentaje, totals]) => {
    return `        <totalImpuesto>
          <codigo>2</codigo>
          <codigoPorcentaje>${escapeXml(codigoPorcentaje)}</codigoPorcentaje>
          <baseImponible>${escapeXml(centsToDecimal(totals.baseCents))}</baseImponible>
          <valor>${escapeXml(centsToDecimal(totals.amountCents))}</valor>
        </totalImpuesto>`;
  }).join('\n');

  let tipoIdentificacionComprador: string;
  if (fallbackIdTypeCode) {
    tipoIdentificacionComprador = fallbackIdTypeCode;
  } else {
    tipoIdentificacionComprador = mapIdentificationType(customer?.identification ?? '');
  }

  const emailCampo = customer?.email
    ? `\n    <campoAdicional nombre="email">${escapeXml(customer.email)}</campoAdicional>`
    : '';

  return `<?xml version="1.0" encoding="UTF-8"?>
<factura id="comprobante" version="2.1.0">
  <infoTributaria>
    <ambiente>${escapeXml(envCode)}</ambiente>
    <tipoEmision>1</tipoEmision>
    <razonSocial>${escapeXml(issuer.legalName)}</razonSocial>
    ${issuer.tradeName ? `<nombreComercial>${escapeXml(issuer.tradeName)}</nombreComercial>` : ''}
    <ruc>${escapeXml(issuer.taxId)}</ruc>
    <claveAcceso>${escapeXml(accessKey)}</claveAcceso>
    <codDoc>01</codDoc>
    <estab>${escapeXml(input.establishmentCode)}</estab>
    <ptoEmi>${escapeXml(input.emissionPointCode)}</ptoEmi>
    <secuencial>${escapeXml(input.sequentialNumber)}</secuencial>
    <dirMatriz>${escapeXml(issuer.address ?? '')}</dirMatriz>
  </infoTributaria>
  <infoFactura>
    <fechaEmision>${escapeXml(fechaEmision)}</fechaEmision>
    ${issuer.address ? `<dirEstablecimiento>${escapeXml(issuer.address)}</dirEstablecimiento>` : ''}
    <obligadoContabilidad>${escapeXml(obligadoContabilidad)}</obligadoContabilidad>
    <tipoIdentificacionComprador>${escapeXml(tipoIdentificacionComprador)}</tipoIdentificacionComprador>
    <razonSocialComprador>${escapeXml(customer?.businessName ?? '')}</razonSocialComprador>
    <identificacionComprador>${escapeXml(customer?.identification ?? '')}</identificacionComprador>
    <totalSinImpuestos>${escapeXml(centsToDecimal(payload.subtotalCents))}</totalSinImpuestos>
    <totalDescuento>${escapeXml(centsToDecimal(totalDescuentoCents))}</totalDescuento>
    <totalConImpuestos>
${totalConImpuestosXml}
    </totalConImpuestos>
    <propina>0.00</propina>
    <importeTotal>${escapeXml(centsToDecimal(payload.totalCents))}</importeTotal>
    <moneda>DOLAR</moneda>
  </infoFactura>
  <detalles>
${detalles}
  </detalles>
  <infoAdicional>${emailCampo}
  </infoAdicional>
</factura>`;
}

function formatFechaEmision(date: Date): string {
  const dd = String(date.getDate()).padStart(2, '0');
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const yyyy = String(date.getFullYear());
  return `${dd}/${mm}/${yyyy}`;
}

function mapIdentificationType(identification: string): string {
  if (/^9{13}$/.test(identification)) return '07';
  if (/^\d{13}$/.test(identification)) return '04';
  if (/^\d{10}$/.test(identification)) return '05';
  return '06';
}

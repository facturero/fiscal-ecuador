import type { InvoiceIssuedPayload } from './types.js';
import { FiscalValidationError } from './errors.js';
import { sriDate } from './ecuador-time.js';
import { resolveTax } from './sri-tax-codes.js';
import { buyerFor, money, productCode, quantity, text, type IssuerFiscalProfile } from './invoice-xml-builder.js';

export interface CreditNoteXmlInput {
  payload: InvoiceIssuedPayload;
  accessKey: string;
  environment: 'pruebas' | 'produccion';
  issueDate: Date;
  establishmentCode: string;
  emissionPointCode: string;
  sequentialNumber: string;
  /** El comprobante que se modifica. `numDocModificado` es su NÚMERO (estab-pto-seq), no la clave. */
  modified: {
    documentType: string;
    /** Número del comprobante original, formato `ddd-ddd-ddddddddd`. */
    number: string;
    /** Fecha de emisión del original, `dd/mm/yyyy` o ISO (se convierte). */
    issueDate: string;
  };
  /** id de tarifa de tax-service → código de catálogo (`IVA15`...). */
  taxCodeById?: Record<string, string>;
  /** Código de catálogo del tipo de identificación del comprador (`RUC`, `CEDULA`...). */
  identificationTypeCode?: string;
  issuerProfile?: IssuerFiscalProfile;
}

/**
 * La fecha del comprobante que se modifica puede llegar como `dd/mm/yyyy` (venía
 * así del original) o ISO. El esquema pide `dd/mm/yyyy` (fechaEmisionDocSustento).
 */
function sustentoDate(value: string): string {
  if (/^(0[1-9]|[12][0-9]|3[01])\/(0[1-9]|1[012])\/20[0-9][0-9]$/.test(value)) return value;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new FiscalValidationError(`Fecha del comprobante que se modifica inválida: "${value}"`);
  }
  return sriDate(date);
}

/**
 * Arma el XML sin firmar de una nota de crédito (codDoc 04), contra el esquema
 * oficial `notaCredito_V1.1.0.xsd`.
 *
 * Una nota de crédito reversiona valores de un comprobante ya autorizado: los
 * montos van en positivo (son los que se acreditan), el comprobante que modifica
 * se declara con su número en `numDocModificado`, y el motivo es obligatorio
 * (es lo que ve el SRI y el cliente). El orden de los nodos sigue el esquema,
 * igual que en `buildInvoiceXml`: fuera de sitio es un rechazo sin importar el
 * dato.
 */
export function buildCreditNoteXml(input: CreditNoteXmlInput): string {
  const { payload, accessKey, environment } = input;
  const issuer = payload.issuerSnapshot;
  if (!issuer) throw new FiscalValidationError('La nota de crédito no trae los datos del emisor');
  if (!payload.creditNoteReason?.trim()) {
    throw new FiscalValidationError('El motivo de la nota de crédito no puede estar vacío');
  }
  if (!/^\d{3}-\d{3}-\d{9}$/.test(input.modified.number)) {
    throw new FiscalValidationError(`El número del comprobante modificado no tiene el formato esperado: "${input.modified.number}"`);
  }

  const profile = input.issuerProfile ?? {};
  const taxCodeById = input.taxCodeById ?? {};
  const envCode = environment === 'produccion' ? '2' : '1';

  const establishmentAddress = issuer.address?.trim() || '';
  const dirMatriz = profile.dirMatriz?.trim() || establishmentAddress;
  if (!dirMatriz) {
    throw new FiscalValidationError('Falta la dirección del establecimiento (dirMatriz es obligatoria en el SRI)');
  }

  const resolveLineTax = (tax: InvoiceIssuedPayload['lines'][number]['taxes'][number]) =>
    resolveTax({ kind: tax.kind, rateSnapshot: tax.rateSnapshot, catalogCode: taxCodeById[tax.taxRateId] });

  const detalles = payload.lines.map((line) => {
    const impuestosXml = line.taxes.map((tax) => {
      const resolved = resolveLineTax(tax);
      return `          <impuesto>
            <codigo>${resolved.codigo}</codigo>
            <codigoPorcentaje>${resolved.codigoPorcentaje}</codigoPorcentaje>
            <tarifa>${resolved.tarifa.toFixed(2)}</tarifa>
            <baseImponible>${money(tax.baseCents)}</baseImponible>
            <valor>${money(tax.amountCents)}</valor>
          </impuesto>`;
    }).join('\n');

    return `      <detalle>
        <codigoInterno>${text(productCode(line.productCode, line.productId))}</codigoInterno>
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

  // totalConImpuestos agrupa por (codigo, codigoPorcentaje), igual que en la
  // factura, pero sin tarifa: el esquema del SRI lo pide distinto.
  const totals = new Map<string, { base: number; valor: number }>();
  for (const line of payload.lines) {
    for (const tax of line.taxes) {
      const resolved = resolveLineTax(tax);
      const key = `${resolved.codigo}${resolved.codigoPorcentaje}`;
      const acc = totals.get(key) ?? { base: 0, valor: 0 };
      acc.base += tax.baseCents;
      acc.valor += tax.amountCents;
      totals.set(key, acc);
    }
  }
  const totalImpuestosXml = [...totals.entries()].map(([key, acc]) => `      <totalImpuesto>
        <codigo>${key[0]}</codigo>
        <codigoPorcentaje>${key.slice(1)}</codigoPorcentaje>
        <baseImponible>${money(acc.base)}</baseImponible>
        <valor>${money(acc.valor)}</valor>
      </totalImpuesto>`).join('\n');

  const buyer = buyerFor(payload, input.identificationTypeCode);

  const optional = (tag: string, value: string | null | undefined, indent: string) =>
    value?.trim() ? `\n${indent}<${tag}>${text(value.trim())}</${tag}>` : '';

  const adicionales = [
    buyer.email ? `    <campoAdicional nombre="Email">${text(buyer.email)}</campoAdicional>` : null,
    buyer.phone ? `    <campoAdicional nombre="Telefono">${text(buyer.phone)}</campoAdicional>` : null,
  ].filter(Boolean);
  const infoAdicionalXml = adicionales.length
    ? `\n  <infoAdicional>\n${adicionales.join('\n')}\n  </infoAdicional>`
    : '';

  return `<?xml version="1.0" encoding="UTF-8"?>
<notaCredito id="comprobante" version="2.1.0">
  <infoTributaria>
    <ambiente>${envCode}</ambiente>
    <tipoEmision>1</tipoEmision>
    <razonSocial>${text(issuer.legalName)}</razonSocial>${optional('nombreComercial', issuer.tradeName, '    ')}
    <ruc>${text(issuer.taxId)}</ruc>
    <claveAcceso>${text(accessKey)}</claveAcceso>
    <codDoc>04</codDoc>
    <estab>${text(input.establishmentCode)}</estab>
    <ptoEmi>${text(input.emissionPointCode)}</ptoEmi>
    <secuencial>${text(input.sequentialNumber)}</secuencial>
    <dirMatriz>${text(dirMatriz)}</dirMatriz>${optional('agenteRetencion', profile.agenteRetencion, '    ')}${optional('contribuyenteRimpe', profile.contribuyenteRimpe, '    ')}
  </infoTributaria>
  <infoNotaCredito>
    <fechaEmision>${sriDate(input.issueDate)}</fechaEmision>${optional('dirEstablecimiento', establishmentAddress, '    ')}
    <tipoIdentificacionComprador>${buyer.idType}</tipoIdentificacionComprador>
    <razonSocialComprador>${text(buyer.name)}</razonSocialComprador>
    <identificacionComprador>${text(buyer.identification)}</identificacionComprador>${optional('contribuyenteEspecial', profile.contribuyenteEspecial, '    ')}
    <obligadoContabilidad>${text(profile.obligadoContabilidad ?? 'SI')}</obligadoContabilidad>
    <codDocModificado>${text(input.modified.documentType)}</codDocModificado>
    <numDocModificado>${text(input.modified.number)}</numDocModificado>
    <fechaEmisionDocSustento>${text(sustentoDate(input.modified.issueDate))}</fechaEmisionDocSustento>
    <totalSinImpuestos>${money(payload.subtotalCents)}</totalSinImpuestos>
    <valorModificacion>${money(payload.totalCents)}</valorModificacion>
    <moneda>DOLAR</moneda>
    <totalConImpuestos>
${totalImpuestosXml}
    </totalConImpuestos>
    <motivo>${text(payload.creditNoteReason!.trim())}</motivo>
  </infoNotaCredito>
  <detalles>
${detalles}
  </detalles>${infoAdicionalXml}
</notaCredito>`;
}
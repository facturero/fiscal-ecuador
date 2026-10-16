import type { InvoiceIssuedPayload } from './types.js';
import { FiscalValidationError } from './errors.js';
import { sriDate } from './ecuador-time.js';
import { resolveTax } from './sri-tax-codes.js';
import { buyerFor, money, text, type IssuerFiscalProfile } from './invoice-xml-builder.js';

export interface DebitNoteXmlInput {
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
    number: string;
    /** Fecha de emisión del original, `dd/mm/yyyy` o ISO (se convierte). */
    issueDate: string;
  };
  taxCodeById?: Record<string, string>;
  identificationTypeCode?: string;
  issuerProfile?: IssuerFiscalProfile;
}

function sustentoDate(value: string): string {
  if (/^(0[1-9]|[12][0-9]|3[01])\/(0[1-9]|1[012])\/20[0-9][0-9]$/.test(value)) return value;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new FiscalValidationError(`Fecha del comprobante que se modifica inválida: "${value}"`);
  }
  return sriDate(date);
}

/** Tabla 24 por defecto: «sin utilización del sistema financiero». */
const DEFAULT_PAYMENT_METHOD = '01';

/**
 * Arma el XML sin firmar de una nota de débito (codDoc 05), contra el esquema oficial `notaDebito_V1.0.0.xsd`.
 *
 * Una nota de débito AÑADE valores a un comprobante ya autorizado (intereses de mora, gastos de cobranza, un cargo olvidado). A
 * diferencia de la factura y de la nota de crédito no lleva detalle de productos sino `motivos` (razón + valor): billing manda
 * cada motivo como una línea de cantidad 1 y aquí la línea se convierte en motivo. Los impuestos van agrupados por (código,
 * porcentaje) sobre la suma de los motivos; `valorTotal` es lo que se cobra de más (base + impuestos). El orden de los nodos
 * sigue el esquema: fuera de sitio es un rechazo sin importar el dato.
 */
export function buildDebitNoteXml(input: DebitNoteXmlInput): string {
  const { payload, accessKey, environment } = input;
  const issuer = payload.issuerSnapshot;
  if (!issuer) throw new FiscalValidationError('La nota de débito no trae los datos del emisor');
  if (!payload.lines?.length) throw new FiscalValidationError('La nota de débito necesita al menos un motivo');
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

  const motivosXml = payload.lines
    .map((line) => {
      const razon = line.description?.trim();
      if (!razon) throw new FiscalValidationError('Cada motivo de la nota de débito necesita su razón');
      return `      <motivo>
        <razon>${text(razon)}</razon>
        <valor>${money(line.subtotalCents)}</valor>
      </motivo>`;
    })
    .join('\n');

  // Los impuestos se agrupan por (código, porcentaje): el esquema pide un nodo por grupo, con tarifa, base y valor.
  const groups = new Map<string, { codigo: string; codigoPorcentaje: string; tarifa: number; baseCents: number; amountCents: number }>();
  for (const line of payload.lines) {
    for (const tax of line.taxes) {
      const resolved = resolveTax({ kind: tax.kind, rateSnapshot: tax.rateSnapshot, catalogCode: taxCodeById[tax.taxRateId] });
      const key = `${resolved.codigo}:${resolved.codigoPorcentaje}`;
      const group = groups.get(key) ?? { ...resolved, baseCents: 0, amountCents: 0 };
      group.baseCents += tax.baseCents;
      group.amountCents += tax.amountCents;
      groups.set(key, group);
    }
  }
  if (groups.size === 0) throw new FiscalValidationError('La nota de débito necesita al menos un impuesto (IVA 0% si no grava)');
  const impuestosXml = [...groups.values()]
    .map(
      (g) => `          <impuesto>
            <codigo>${g.codigo}</codigo>
            <codigoPorcentaje>${g.codigoPorcentaje}</codigoPorcentaje>
            <tarifa>${g.tarifa.toFixed(2)}</tarifa>
            <baseImponible>${money(g.baseCents)}</baseImponible>
            <valor>${money(g.amountCents)}</valor>
          </impuesto>`,
    )
    .join('\n');

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
  const infoAdicionalXml = adicionales.length ? `\n  <infoAdicional>\n${adicionales.join('\n')}\n  </infoAdicional>` : '';

  return `<?xml version="1.0" encoding="UTF-8"?>
<notaDebito id="comprobante" version="1.0.0">
  <infoTributaria>
    <ambiente>${envCode}</ambiente>
    <tipoEmision>1</tipoEmision>
    <razonSocial>${text(issuer.legalName)}</razonSocial>${optional('nombreComercial', issuer.tradeName, '    ')}
    <ruc>${text(issuer.taxId)}</ruc>
    <claveAcceso>${text(accessKey)}</claveAcceso>
    <codDoc>05</codDoc>
    <estab>${text(input.establishmentCode)}</estab>
    <ptoEmi>${text(input.emissionPointCode)}</ptoEmi>
    <secuencial>${text(input.sequentialNumber)}</secuencial>
    <dirMatriz>${text(dirMatriz)}</dirMatriz>${optional('agenteRetencion', profile.agenteRetencion, '    ')}${optional('contribuyenteRimpe', profile.contribuyenteRimpe, '    ')}
  </infoTributaria>
  <infoNotaDebito>
    <fechaEmision>${sriDate(input.issueDate)}</fechaEmision>${optional('dirEstablecimiento', establishmentAddress, '    ')}
    <tipoIdentificacionComprador>${buyer.idType}</tipoIdentificacionComprador>
    <razonSocialComprador>${text(buyer.name)}</razonSocialComprador>
    <identificacionComprador>${text(buyer.identification)}</identificacionComprador>${optional('contribuyenteEspecial', profile.contribuyenteEspecial, '    ')}
    <obligadoContabilidad>${text(profile.obligadoContabilidad ?? 'SI')}</obligadoContabilidad>
    <codDocModificado>${text(input.modified.documentType)}</codDocModificado>
    <numDocModificado>${text(input.modified.number)}</numDocModificado>
    <fechaEmisionDocSustento>${text(sustentoDate(input.modified.issueDate))}</fechaEmisionDocSustento>
    <totalSinImpuestos>${money(payload.subtotalCents)}</totalSinImpuestos>
    <impuestos>
${impuestosXml}
    </impuestos>
    <valorTotal>${money(payload.totalCents)}</valorTotal>
    <pagos>
      <pago>
        <formaPago>${paymentMethod}</formaPago>
        <total>${money(payload.totalCents)}</total>
      </pago>
    </pagos>
  </infoNotaDebito>
  <motivos>
${motivosXml}
  </motivos>${infoAdicionalXml}
</notaDebito>`;
}

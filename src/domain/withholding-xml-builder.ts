import { FiscalValidationError } from './errors.js';
import { sriDate } from './ecuador-time.js';
import { money, text, type IssuerFiscalProfile } from './invoice-xml-builder.js';
import {
  PARTY_ID_CODES,
  WITHHOLDING_TAX_CODES,
  sriDateFromIsoDay,
  validateDocumentNumber,
  type WithholdingPayload,
} from './direct-documents.js';

export interface WithholdingXmlInput {
  payload: WithholdingPayload;
  accessKey: string;
  environment: 'pruebas' | 'produccion';
  issueDate: Date;
  issuerProfile?: IssuerFiscalProfile;
}

/**
 * Arma el XML sin firmar de un comprobante de retención (codDoc 07, versión 2.0.0), contra `comprobanteRetencion_V2.0.0.xsd`.
 *
 * Desde la versión 2.0.0 las retenciones ya no cuelgan del comprobante sino de cada documento de sustento (`docSustento`): una
 * retención dice «de esta compra de tal proveedor retengo estos impuestos». Aquí se emite un sustento por comprobante. El
 * número del sustento va sin guiones (15 dígitos) a diferencia de la nota de crédito. El orden de los nodos sigue el esquema.
 *
 * Cubre pagos LOCALES (`pagoLocExt` = 01). Los pagos al exterior exigen más datos (régimen, país, convenio de doble tributación)
 * y se rechazan al registrar la retención, no aquí.
 */
export function buildWithholdingXml(input: WithholdingXmlInput): string {
  const { payload, accessKey, environment } = input;
  const issuer = payload.issuerSnapshot;
  const { subject, support } = payload;
  const profile = input.issuerProfile ?? {};
  const envCode = environment === 'produccion' ? '2' : '1';

  const establishmentAddress = issuer.address?.trim() || '';
  const dirMatriz = profile.dirMatriz?.trim() || establishmentAddress;
  if (!dirMatriz) {
    throw new FiscalValidationError('Falta la dirección del establecimiento (dirMatriz es obligatoria en el SRI)');
  }
  if (!payload.withholdings.length) throw new FiscalValidationError('El comprobante de retención necesita al menos un impuesto retenido');
  if (!support.taxes.length) throw new FiscalValidationError('El comprobante de sustento necesita al menos un impuesto (IVA 0 % si no grava)');
  validateDocumentNumber(support.number, 'Número del comprobante de sustento');
  if (!/^\d{2}$/.test(support.paymentMethodCode)) {
    throw new FiscalValidationError(`Forma de pago inválida: "${support.paymentMethodCode}" (debe ser un código de 2 dígitos de la Tabla 24)`);
  }
  if (!/^(0[1-9]|1[0-2])\/20\d\d$/.test(payload.fiscalPeriod)) {
    throw new FiscalValidationError(`Periodo fiscal inválido: "${payload.fiscalPeriod}" (se espera MM/AAAA)`);
  }

  const impuestos = support.taxes
    .map(
      (t) => `          <impuestoDocSustento>
            <codImpuestoDocSustento>${t.code}</codImpuestoDocSustento>
            <codigoPorcentaje>${text(t.percentageCode)}</codigoPorcentaje>
            <baseImponible>${money(t.baseCents)}</baseImponible>
            <tarifa>${t.rate.toFixed(2)}</tarifa>
            <valorImpuesto>${money(t.amountCents)}</valorImpuesto>
          </impuestoDocSustento>`,
    )
    .join('\n');

  const retenciones = payload.withholdings
    .map(
      (w) => `          <retencion>
            <codigo>${WITHHOLDING_TAX_CODES[w.tax]}</codigo>
            <codigoRetencion>${text(w.retentionCode)}</codigoRetencion>
            <baseImponible>${money(w.baseCents)}</baseImponible>
            <porcentajeRetener>${w.ratePercent.toFixed(2)}</porcentajeRetener>
            <valorRetenido>${money(w.amountCents)}</valorRetenido>
          </retencion>`,
    )
    .join('\n');

  const optional = (tag: string, value: string | null | undefined, indent: string) =>
    value?.trim() ? `\n${indent}<${tag}>${text(value.trim())}</${tag}>` : '';

  const adicionales = [
    subject.email ? `    <campoAdicional nombre="Email">${text(subject.email)}</campoAdicional>` : null,
    subject.phone ? `    <campoAdicional nombre="Telefono">${text(subject.phone)}</campoAdicional>` : null,
  ].filter(Boolean);
  const infoAdicionalXml = adicionales.length ? `\n  <infoAdicional>\n${adicionales.join('\n')}\n  </infoAdicional>` : '';

  return `<?xml version="1.0" encoding="UTF-8"?>
<comprobanteRetencion id="comprobante" version="2.0.0">
  <infoTributaria>
    <ambiente>${envCode}</ambiente>
    <tipoEmision>1</tipoEmision>
    <razonSocial>${text(issuer.legalName)}</razonSocial>${optional('nombreComercial', issuer.tradeName, '    ')}
    <ruc>${text(issuer.taxId)}</ruc>
    <claveAcceso>${text(accessKey)}</claveAcceso>
    <codDoc>07</codDoc>
    <estab>${text(issuer.establishmentCode)}</estab>
    <ptoEmi>${text(issuer.emissionPointCode)}</ptoEmi>
    <secuencial>${text(payload.sequentialNumber)}</secuencial>
    <dirMatriz>${text(dirMatriz)}</dirMatriz>${optional('agenteRetencion', profile.agenteRetencion, '    ')}${optional('contribuyenteRimpe', profile.contribuyenteRimpe, '    ')}
  </infoTributaria>
  <infoCompRetencion>
    <fechaEmision>${sriDate(input.issueDate)}</fechaEmision>${optional('dirEstablecimiento', establishmentAddress, '    ')}${optional('contribuyenteEspecial', profile.contribuyenteEspecial, '    ')}
    <obligadoContabilidad>${text(profile.obligadoContabilidad ?? 'SI')}</obligadoContabilidad>
    <tipoIdentificacionSujetoRetenido>${PARTY_ID_CODES[subject.identificationType]}</tipoIdentificacionSujetoRetenido>
    <parteRel>${subject.relatedParty ? 'SI' : 'NO'}</parteRel>
    <razonSocialSujetoRetenido>${text(subject.businessName)}</razonSocialSujetoRetenido>
    <identificacionSujetoRetenido>${text(subject.identification)}</identificacionSujetoRetenido>
    <periodoFiscal>${payload.fiscalPeriod}</periodoFiscal>
  </infoCompRetencion>
  <docsSustento>
    <docSustento>
      <codSustento>${text(support.supportCode)}</codSustento>
      <codDocSustento>${text(support.documentCode)}</codDocSustento>
      <numDocSustento>${support.number.replace(/-/g, '')}</numDocSustento>
      <fechaEmisionDocSustento>${sriDateFromIsoDay(support.issueDate)}</fechaEmisionDocSustento>${optional('numAutDocSustento', support.authorizationNumber, '      ')}
      <pagoLocExt>01</pagoLocExt>
      <totalSinImpuestos>${money(support.totalWithoutTaxesCents)}</totalSinImpuestos>
      <importeTotal>${money(support.totalCents)}</importeTotal>
      <impuestosDocSustento>
${impuestos}
      </impuestosDocSustento>
      <retenciones>
${retenciones}
      </retenciones>
      <pagos>
        <pago>
          <formaPago>${support.paymentMethodCode}</formaPago>
          <total>${money(support.totalCents)}</total>
        </pago>
      </pagos>
    </docSustento>
  </docsSustento>${infoAdicionalXml}
</comprobanteRetencion>`;
}

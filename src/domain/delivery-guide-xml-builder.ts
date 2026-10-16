import { FiscalValidationError } from './errors.js';
import { quantity, text, type IssuerFiscalProfile } from './invoice-xml-builder.js';
import { PARTY_ID_CODES, sriDateFromIsoDay, validateDocumentNumber, type DeliveryGuidePayload } from './direct-documents.js';

export interface DeliveryGuideXmlInput {
  payload: DeliveryGuidePayload;
  accessKey: string;
  environment: 'pruebas' | 'produccion';
  issueDate: Date;
  issuerProfile?: IssuerFiscalProfile;
}

/**
 * Arma el XML sin firmar de una guía de remisión (codDoc 06, versión 1.1.0), contra `guiaRemision_V1.1.0.xsd`.
 *
 * La guía ampara el TRASLADO de mercadería: no tiene valores ni impuestos, solo quién la lleva (transportista y placa), de dónde
 * sale, a quién llega y qué lleva. Cada destinatario puede citar el comprobante que sustenta el traslado (la factura). El orden
 * de los nodos sigue el esquema.
 */
export function buildDeliveryGuideXml(input: DeliveryGuideXmlInput): string {
  const { payload, accessKey, environment } = input;
  const issuer = payload.issuerSnapshot;
  const profile = input.issuerProfile ?? {};
  const envCode = environment === 'produccion' ? '2' : '1';

  const establishmentAddress = issuer.address?.trim() || '';
  const dirMatriz = profile.dirMatriz?.trim() || establishmentAddress;
  if (!dirMatriz) {
    throw new FiscalValidationError('Falta la dirección del establecimiento (dirMatriz es obligatoria en el SRI)');
  }
  if (!payload.recipients.length) throw new FiscalValidationError('La guía de remisión necesita al menos un destinatario');

  const optional = (tag: string, value: string | null | undefined, indent: string) =>
    value?.trim() ? `\n${indent}<${tag}>${text(value.trim())}</${tag}>` : '';

  const destinatarios = payload.recipients
    .map((r, i) => {
      if (!r.items.length) throw new FiscalValidationError(`El destinatario ${i + 1} (${r.businessName}) no lleva ninguna mercadería`);
      const support = r.support;
      let supportXml = '';
      if (support) {
        validateDocumentNumber(support.number, `Comprobante de sustento del destinatario ${i + 1}`);
        supportXml =
          `\n        <codDocSustento>${text(support.documentCode)}</codDocSustento>` +
          `\n        <numDocSustento>${support.number}</numDocSustento>` +
          optional('numAutDocSustento', support.authorizationNumber, '        ') +
          `\n        <fechaEmisionDocSustento>${sriDateFromIsoDay(support.issueDate)}</fechaEmisionDocSustento>`;
      }
      const detalles = r.items
        .map(
          (item) => `          <detalle>${optional('codigoInterno', item.internalCode, '            ')}${optional('codigoAdicional', item.additionalCode, '            ')}
            <descripcion>${text(item.description)}</descripcion>
            <cantidad>${quantity(item.quantity)}</cantidad>
          </detalle>`,
        )
        .join('\n');
      return `      <destinatario>
        <identificacionDestinatario>${text(r.identification)}</identificacionDestinatario>
        <razonSocialDestinatario>${text(r.businessName)}</razonSocialDestinatario>
        <dirDestinatario>${text(r.address)}</dirDestinatario>
        <motivoTraslado>${text(r.reason)}</motivoTraslado>${optional('docAduaneroUnico', r.customsDocument, '        ')}${optional('codEstabDestino', r.destinationEstablishmentCode, '        ')}${optional('ruta', r.route, '        ')}${supportXml}
        <detalles>
${detalles}
        </detalles>
      </destinatario>`;
    })
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<guiaRemision id="comprobante" version="1.1.0">
  <infoTributaria>
    <ambiente>${envCode}</ambiente>
    <tipoEmision>1</tipoEmision>
    <razonSocial>${text(issuer.legalName)}</razonSocial>${optional('nombreComercial', issuer.tradeName, '    ')}
    <ruc>${text(issuer.taxId)}</ruc>
    <claveAcceso>${text(accessKey)}</claveAcceso>
    <codDoc>06</codDoc>
    <estab>${text(issuer.establishmentCode)}</estab>
    <ptoEmi>${text(issuer.emissionPointCode)}</ptoEmi>
    <secuencial>${text(payload.sequentialNumber)}</secuencial>
    <dirMatriz>${text(dirMatriz)}</dirMatriz>${optional('agenteRetencion', profile.agenteRetencion, '    ')}${optional('contribuyenteRimpe', profile.contribuyenteRimpe, '    ')}
  </infoTributaria>
  <infoGuiaRemision>${optional('dirEstablecimiento', establishmentAddress, '    ')}
    <dirPartida>${text(payload.originAddress)}</dirPartida>
    <razonSocialTransportista>${text(payload.carrier.businessName)}</razonSocialTransportista>
    <tipoIdentificacionTransportista>${PARTY_ID_CODES[payload.carrier.identificationType]}</tipoIdentificacionTransportista>
    <rucTransportista>${text(payload.carrier.identification)}</rucTransportista>${optional('rise', payload.carrier.rise, '    ')}
    <obligadoContabilidad>${text(profile.obligadoContabilidad ?? 'SI')}</obligadoContabilidad>${optional('contribuyenteEspecial', profile.contribuyenteEspecial, '    ')}
    <fechaIniTransporte>${sriDateFromIsoDay(payload.transportStart)}</fechaIniTransporte>
    <fechaFinTransporte>${sriDateFromIsoDay(payload.transportEnd)}</fechaFinTransporte>
    <placa>${text(payload.carrier.plate)}</placa>
  </infoGuiaRemision>
  <destinatarios>
${destinatarios}
  </destinatarios>
</guiaRemision>`;
}

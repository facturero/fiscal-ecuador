export interface SriReceptionResponse {
  estado: 'RECIBIDA' | 'DEVUELTA';
  mensajes?: Array<{
    mensaje: string;
    tipo: string;
    informacionAdicional?: string;
  }>;
}

export interface SriAuthorizationResponse {
  estado: 'AUTORIZADO' | 'NO AUTORIZADO' | 'EN PROCESAMIENTO' | 'CLAVE DE ACCESO EN PROCESAMIENTO';
  numeroAutorizacion?: string;
  fechaAutorizacion?: string;
  xmlAutorizado?: string;
  mensajes?: Array<{
    mensaje: string;
    tipo: string;
    informacionAdicional?: string;
  }>;
}

function wrapSoapEnvelope(operation: string, bodyXml: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ser="http://ec.gob.sri.ws.cfactura">
  <soapenv:Header/>
  <soapenv:Body>
    <ser:${operation}>
      <xml>${Buffer.from(bodyXml).toString('base64')}</xml>
    </ser:${operation}>
  </soapenv:Body>
</soapenv:Envelope>`;
}

function wrapAuthSoapEnvelope(claveAcceso: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ser="http://ec.gob.sri.ws.cfactura">
  <soapenv:Header/>
  <soapenv:Body>
    <ser:autorizacionComprobante>
      <claveAccesoConsultada>${claveAcceso}</claveAccesoConsultada>
    </ser:autorizacionComprobante>
  </soapenv:Body>
</soapenv:Envelope>`;
}

function parseReceptionResponse(soapXml: string): SriReceptionResponse {
  const estadoMatch = soapXml.match(/<estado>(.*?)<\/estado>/);
  const estado = (estadoMatch?.[1] ?? 'DEVUELTA') as SriReceptionResponse['estado'];

  const mensajes: SriReceptionResponse['mensajes'] = [];
  const msgRegex = /<mensaje>([\s\S]*?)<\/mensaje>/g;
  let msgMatch;
  while ((msgMatch = msgRegex.exec(soapXml)) !== null) {
    mensajes.push({ mensaje: msgMatch[1].trim(), tipo: 'ERROR' });
  }

  return { estado, mensajes: mensajes.length > 0 ? mensajes : undefined };
}

function parseAuthorizationResponse(soapXml: string): SriAuthorizationResponse {
  const estadoMatch = soapXml.match(/<estado>(.*?)<\/estado>/);
  const estado = (estadoMatch?.[1] ?? 'EN PROCESAMIENTO') as SriAuthorizationResponse['estado'];

  const numeroMatch = soapXml.match(/<numeroAutorizacion>(.*?)<\/numeroAutorizacion>/);
  const fechaMatch = soapXml.match(/<fechaAutorizacion>(.*?)<\/fechaAutorizacion>/);
  const xmlMatch = soapXml.match(/<comprobante><!\[CDATA\[([\s\S]*?)\]\]><\/comprobante>/);

  const mensajes: SriAuthorizationResponse['mensajes'] = [];
  const msgRegex = /<mensaje>([\s\S]*?)<\/mensaje>/g;
  let msgMatch;
  while ((msgMatch = msgRegex.exec(soapXml)) !== null) {
    mensajes.push({ mensaje: msgMatch[1].trim(), tipo: 'ERROR' });
  }

  return {
    estado,
    numeroAutorizacion: numeroMatch?.[1],
    fechaAutorizacion: fechaMatch?.[1],
    xmlAutorizado: xmlMatch?.[1],
    mensajes: mensajes.length > 0 ? mensajes : undefined,
  };
}

export async function sendToSriReception(signedXml: string, endpoint: string): Promise<SriReceptionResponse> {
  const soapBody = wrapSoapEnvelope('validarComprobante', signedXml);

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/xml; charset=utf-8' },
    body: soapBody,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`SRI Recepción HTTP ${response.status}: ${text}`);
  }

  const xml = await response.text();
  return parseReceptionResponse(xml);
}

export async function querySriAuthorization(claveAcceso: string, endpoint: string): Promise<SriAuthorizationResponse> {
  const soapBody = wrapAuthSoapEnvelope(claveAcceso);

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/xml; charset=utf-8' },
    body: soapBody,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`SRI Autorización HTTP ${response.status}: ${text}`);
  }

  const xml = await response.text();
  return parseAuthorizationResponse(xml);
}

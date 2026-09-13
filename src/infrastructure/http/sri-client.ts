/**
 * Cliente de los web services "offline" del SRI (recepción y autorización).
 *
 * Tres reglas que antes no se cumplían:
 * - **Toda llamada tiene tiempo máximo.** El SRI a veces acepta la conexión y no
 *   contesta; sin timeout el `fetch` se quedaba colgado y con él el consumidor
 *   de RabbitMQ entero.
 * - **Un SOAP Fault es un error, no un estado.** Antes, si la respuesta no traía
 *   `<estado>`, se inventaba `DEVUELTA` (rechazo definitivo) o `EN PROCESAMIENTO`
 *   (esperar para siempre). Ahora se lanza `SriUnavailableError` y se reintenta.
 * - **Se conserva el XML autorizado**, que es el comprobante legal: el que se
 *   firmó aquí no lleva el número ni la fecha de autorización del SRI.
 */

export interface SriMessage {
  identificador?: string;
  mensaje: string;
  tipo?: string;
  informacionAdicional?: string;
}

export interface SriReceptionResponse {
  estado: 'RECIBIDA' | 'DEVUELTA';
  mensajes?: SriMessage[];
}

export type SriAuthorizationState = 'AUTORIZADO' | 'NO AUTORIZADO' | 'EN PROCESAMIENTO';

export interface SriAuthorizationResponse {
  estado: SriAuthorizationState;
  numeroAutorizacion?: string;
  fechaAutorizacion?: string;
  xmlAutorizado?: string;
  mensajes?: SriMessage[];
}

/** El SRI no respondió algo utilizable: red, timeout, HTTP de error o SOAP Fault. Se puede reintentar. */
export class SriUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SriUnavailableError';
  }
}

/**
 * Errores de recepción que significan "este comprobante ya lo tengo": el envío
 * anterior sí llegó aunque aquí no se registrara la respuesta. Lo correcto es
 * pasar a consultar la autorización, no marcarlo como rechazado.
 * 43 = CLAVE ACCESO REGISTRADA, 45 = SECUENCIAL REGISTRADO (con la misma clave).
 */
const ALREADY_RECEIVED_IDS = new Set(['43', '45']);

export function isAlreadyReceived(response: SriReceptionResponse): boolean {
  return (
    response.estado === 'DEVUELTA' &&
    (response.mensajes ?? []).some(
      (m) => ALREADY_RECEIVED_IDS.has(m.identificador ?? '') || /CLAVE\s+(DE\s+)?ACCESO\s+REGISTRADA/i.test(m.mensaje),
    )
  );
}

export function describeMessages(mensajes: SriMessage[] | undefined, fallback: string): string {
  if (!mensajes?.length) return fallback;
  return mensajes
    .map((m) => {
      const head = m.identificador ? `[${m.identificador}] ${m.mensaje}` : m.mensaje;
      return m.informacionAdicional ? `${head}: ${m.informacionAdicional}` : head;
    })
    .join('; ');
}

function wrapReceptionEnvelope(signedXml: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ec="http://ec.gob.sri.ws.recepcion">
  <soapenv:Header/>
  <soapenv:Body>
    <ec:validarComprobante>
      <xml>${Buffer.from(signedXml, 'utf-8').toString('base64')}</xml>
    </ec:validarComprobante>
  </soapenv:Body>
</soapenv:Envelope>`;
}

function wrapAuthorizationEnvelope(claveAcceso: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ec="http://ec.gob.sri.ws.autorizacion">
  <soapenv:Header/>
  <soapenv:Body>
    <ec:autorizacionComprobante>
      <claveAccesoComprobante>${claveAcceso}</claveAccesoComprobante>
    </ec:autorizacionComprobante>
  </soapenv:Body>
</soapenv:Envelope>`;
}

function tag(xml: string, name: string): string | undefined {
  const match = xml.match(new RegExp(`<(?:\\w+:)?${name}>([\\s\\S]*?)</(?:\\w+:)?${name}>`));
  return match?.[1]?.trim();
}

function decodeEntities(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function assertNoFault(soapXml: string, operation: string): void {
  if (/<(?:\w+:)?Fault>/.test(soapXml)) {
    const reason = tag(soapXml, 'faultstring') ?? tag(soapXml, 'Text') ?? 'sin detalle';
    throw new SriUnavailableError(`SRI ${operation}: SOAP Fault (${decodeEntities(reason)})`);
  }
}

function parseMessages(xml: string): SriMessage[] | undefined {
  const mensajes: SriMessage[] = [];
  // Cada <mensaje> exterior envuelve identificador, mensaje, informacionAdicional y tipo.
  const blockRegex = /<mensaje>\s*(<identificador>[\s\S]*?)<\/mensaje>\s*(?=<mensaje>|<\/mensajes>)/g;
  let block;
  while ((block = blockRegex.exec(xml)) !== null) {
    const body = block[1];
    const inner = body.match(/<mensaje>([\s\S]*?)<\/mensaje>/);
    mensajes.push({
      identificador: tag(body, 'identificador'),
      mensaje: decodeEntities(inner?.[1]?.trim() ?? ''),
      informacionAdicional: tag(body, 'informacionAdicional') && decodeEntities(tag(body, 'informacionAdicional')!),
      tipo: tag(body, 'tipo'),
    });
  }
  return mensajes.length ? mensajes : undefined;
}

export function parseReceptionResponse(soapXml: string): SriReceptionResponse {
  assertNoFault(soapXml, 'recepción');
  const estado = tag(soapXml, 'estado');
  if (estado !== 'RECIBIDA' && estado !== 'DEVUELTA') {
    throw new SriUnavailableError(`SRI recepción: respuesta sin estado reconocible (${estado ?? 'vacío'})`);
  }
  return { estado, mensajes: parseMessages(soapXml) };
}

export function parseAuthorizationResponse(soapXml: string): SriAuthorizationResponse {
  assertNoFault(soapXml, 'autorización');
  if (!/RespuestaAutorizacionComprobante/.test(soapXml)) {
    throw new SriUnavailableError('SRI autorización: la respuesta no es de autorización');
  }

  // Puede haber varias <autorizacion> para la misma clave (intentos anteriores).
  // Manda la autorizada si la hay; si no, la más reciente, que es la primera.
  const blocks = soapXml.match(/<autorizacion>[\s\S]*?<\/autorizacion>/g) ?? [];
  if (blocks.length === 0) {
    // numeroComprobantes = 0: el SRI todavía no tiene resultado para esa clave.
    return { estado: 'EN PROCESAMIENTO' };
  }
  const chosen: string = blocks.find((b) => tag(b, 'estado') === 'AUTORIZADO') ?? blocks[0]!;
  const estado = tag(chosen, 'estado');
  if (estado !== 'AUTORIZADO' && estado !== 'NO AUTORIZADO' && estado !== 'EN PROCESAMIENTO') {
    throw new SriUnavailableError(`SRI autorización: estado desconocido (${estado ?? 'vacío'})`);
  }

  const comprobante = chosen.match(/<comprobante>([\s\S]*?)<\/comprobante>/)?.[1];
  const xmlAutorizado = comprobante
    ? comprobante.trim().startsWith('<![CDATA[')
      ? comprobante.trim().slice('<![CDATA['.length, -']]>'.length)
      : decodeEntities(comprobante.trim())
    : undefined;

  return {
    estado,
    numeroAutorizacion: tag(chosen, 'numeroAutorizacion'),
    fechaAutorizacion: tag(chosen, 'fechaAutorizacion'),
    xmlAutorizado,
    mensajes: parseMessages(chosen),
  };
}

async function postSoap(endpoint: string, body: string, operation: string, timeoutMs: number): Promise<string> {
  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'text/xml; charset=utf-8', SOAPAction: '' },
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const reason = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')
      ? `sin respuesta en ${Math.round(timeoutMs / 1000)} s`
      : (err as Error).message;
    throw new SriUnavailableError(`SRI ${operation}: ${reason}`);
  }

  const text = await response.text();
  // Un Fault llega con HTTP 500: se lee antes de mirar el código para dar el motivo real.
  assertNoFault(text, operation);
  if (!response.ok) {
    throw new SriUnavailableError(`SRI ${operation}: HTTP ${response.status}`);
  }
  return text;
}

export async function sendToSriReception(signedXml: string, endpoint: string, timeoutMs: number): Promise<SriReceptionResponse> {
  const xml = await postSoap(endpoint, wrapReceptionEnvelope(signedXml), 'recepción', timeoutMs);
  return parseReceptionResponse(xml);
}

export async function querySriAuthorization(claveAcceso: string, endpoint: string, timeoutMs: number): Promise<SriAuthorizationResponse> {
  const xml = await postSoap(endpoint, wrapAuthorizationEnvelope(claveAcceso), 'autorización', timeoutMs);
  return parseAuthorizationResponse(xml);
}

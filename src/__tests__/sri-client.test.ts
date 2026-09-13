import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  describeMessages,
  isAlreadyReceived,
  parseAuthorizationResponse,
  parseReceptionResponse,
  querySriAuthorization,
  sendToSriReception,
  SriUnavailableError,
} from '../infrastructure/http/sri-client.js';

// Las tres primeras son respuestas REALES del ambiente de pruebas del SRI
// (celcer), capturadas el 2026-09-13. Las demás se construyen con la misma forma.

const REAL_AUTH_NOT_FOUND = `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><ns2:autorizacionComprobanteResponse xmlns:ns2="http://ec.gob.sri.ws.autorizacion"><RespuestaAutorizacionComprobante><claveAccesoConsultada>1309202601179217560600110010010000001231234567814</claveAccesoConsultada><numeroComprobantes>0</numeroComprobantes><autorizaciones/></RespuestaAutorizacionComprobante></ns2:autorizacionComprobanteResponse></soap:Body></soap:Envelope>`;

const REAL_RECEPTION_DEVUELTA = `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><ns2:validarComprobanteResponse xmlns:ns2="http://ec.gob.sri.ws.recepcion"><RespuestaRecepcionComprobante><estado>DEVUELTA</estado><comprobantes><comprobante><claveAcceso>N/A</claveAcceso><mensajes><mensaje><identificador>35</identificador><mensaje>ARCHIVO NO CUMPLE ESTRUCTURA XML</mensaje><informacionAdicional>Se encontró el siguiente error en la estructura del comprobante: No se ha encontrado información en el tag claveAcceso.</informacionAdicional><tipo>ERROR</tipo></mensaje></mensajes></comprobante></comprobantes></RespuestaRecepcionComprobante></ns2:validarComprobanteResponse></soap:Body></soap:Envelope>`;

/** Lo que devolvía el SRI al sobre que usaba antes este servicio. */
const REAL_FAULT_OLD_ENVELOPE = `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><soap:Fault><faultcode>soap:Client</faultcode><faultstring>Unexpected wrapper element {http://ec.gob.sri.ws.cfactura}autorizacionComprobante found.   Expected {http://ec.gob.sri.ws.autorizacion}autorizacionComprobante.</faultstring></soap:Fault></soap:Body></soap:Envelope>`;

const RECEPTION_RECIBIDA = `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><ns2:validarComprobanteResponse xmlns:ns2="http://ec.gob.sri.ws.recepcion"><RespuestaRecepcionComprobante><estado>RECIBIDA</estado><comprobantes/></RespuestaRecepcionComprobante></ns2:validarComprobanteResponse></soap:Body></soap:Envelope>`;

const RECEPTION_ALREADY_REGISTERED = REAL_RECEPTION_DEVUELTA
  .replace('<identificador>35</identificador>', '<identificador>43</identificador>')
  .replace('ARCHIVO NO CUMPLE ESTRUCTURA XML', 'CLAVE ACCESO REGISTRADA');

const AUTH_AUTHORIZED = `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><ns2:autorizacionComprobanteResponse xmlns:ns2="http://ec.gob.sri.ws.autorizacion"><RespuestaAutorizacionComprobante><claveAccesoConsultada>KEY</claveAccesoConsultada><numeroComprobantes>2</numeroComprobantes><autorizaciones><autorizacion><estado>NO AUTORIZADO</estado><fechaAutorizacion>2026-09-13T10:00:00-05:00</fechaAutorizacion><ambiente>PRUEBAS</ambiente><comprobante><![CDATA[<factura>viejo</factura>]]></comprobante><mensajes><mensaje><identificador>39</identificador><mensaje>FIRMA INVALIDA</mensaje><tipo>ERROR</tipo></mensaje></mensajes></autorizacion><autorizacion><estado>AUTORIZADO</estado><numeroAutorizacion>1309202601179217560600110010010000001231234567814</numeroAutorizacion><fechaAutorizacion>2026-09-13T10:05:00-05:00</fechaAutorizacion><ambiente>PRUEBAS</ambiente><comprobante><![CDATA[<?xml version="1.0" encoding="UTF-8"?><factura id="comprobante">&amp; ok</factura>]]></comprobante><mensajes/></autorizacion></autorizaciones></RespuestaAutorizacionComprobante></ns2:autorizacionComprobanteResponse></soap:Body></soap:Envelope>`;

describe('Respuestas de recepción', () => {
  it('lee una DEVUELTA real con su identificador y la información adicional', () => {
    const r = parseReceptionResponse(REAL_RECEPTION_DEVUELTA);
    expect(r.estado).toBe('DEVUELTA');
    expect(r.mensajes).toEqual([
      {
        identificador: '35',
        mensaje: 'ARCHIVO NO CUMPLE ESTRUCTURA XML',
        informacionAdicional: expect.stringContaining('tag claveAcceso'),
        tipo: 'ERROR',
      },
    ]);
    expect(describeMessages(r.mensajes, '')).toMatch(/^\[35\] ARCHIVO NO CUMPLE ESTRUCTURA XML: Se encontró/);
    expect(isAlreadyReceived(r)).toBe(false);
  });

  it('RECIBIDA', () => {
    expect(parseReceptionResponse(RECEPTION_RECIBIDA)).toEqual({ estado: 'RECIBIDA', mensajes: undefined });
  });

  it('"clave ya registrada" significa que el envío anterior llegó, no un rechazo', () => {
    expect(isAlreadyReceived(parseReceptionResponse(RECEPTION_ALREADY_REGISTERED))).toBe(true);
  });

  it('un SOAP Fault es un error reintentable, no un rechazo', () => {
    expect(() => parseReceptionResponse(REAL_FAULT_OLD_ENVELOPE)).toThrow(SriUnavailableError);
    expect(() => parseReceptionResponse(REAL_FAULT_OLD_ENVELOPE)).toThrow(/Unexpected wrapper element/);
  });

  it('una respuesta sin estado no se interpreta como DEVUELTA', () => {
    expect(() => parseReceptionResponse('<html>Service Unavailable</html>')).toThrow(SriUnavailableError);
  });
});

describe('Respuestas de autorización', () => {
  it('sin comprobantes todavía (respuesta real) es EN PROCESAMIENTO', () => {
    expect(parseAuthorizationResponse(REAL_AUTH_NOT_FOUND)).toEqual({ estado: 'EN PROCESAMIENTO' });
  });

  it('con varios intentos se queda con el autorizado y conserva el XML oficial', () => {
    const r = parseAuthorizationResponse(AUTH_AUTHORIZED);
    expect(r.estado).toBe('AUTORIZADO');
    expect(r.numeroAutorizacion).toBe('1309202601179217560600110010010000001231234567814');
    expect(r.fechaAutorizacion).toBe('2026-09-13T10:05:00-05:00');
    expect(r.xmlAutorizado).toBe('<?xml version="1.0" encoding="UTF-8"?><factura id="comprobante">&amp; ok</factura>');
  });

  it('también lee el XML autorizado cuando viene escapado en vez de en CDATA', () => {
    const escaped = AUTH_AUTHORIZED.replace(
      /<comprobante><!\[CDATA\[(<\?xml[\s\S]*?)\]\]><\/comprobante>/,
      (_m, inner: string) => `<comprobante>${inner.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</comprobante>`,
    );
    expect(parseAuthorizationResponse(escaped).xmlAutorizado).toBe(
      '<?xml version="1.0" encoding="UTF-8"?><factura id="comprobante">&amp; ok</factura>',
    );
  });

  it('NO AUTORIZADO con sus mensajes', () => {
    const onlyRejected = AUTH_AUTHORIZED.replace(/<autorizacion><estado>AUTORIZADO[\s\S]*?<\/autorizacion>/, '');
    const r = parseAuthorizationResponse(onlyRejected);
    expect(r.estado).toBe('NO AUTORIZADO');
    expect(describeMessages(r.mensajes, '')).toBe('[39] FIRMA INVALIDA');
  });

  it('un SOAP Fault real se lanza como error, no se queda EN PROCESAMIENTO para siempre', () => {
    expect(() => parseAuthorizationResponse(REAL_FAULT_OLD_ENVELOPE)).toThrow(SriUnavailableError);
  });
});

describe('Llamadas HTTP', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('usa los namespaces y el elemento que publica el WSDL del SRI', async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => new Response(REAL_AUTH_NOT_FOUND, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await querySriAuthorization('KEY', 'https://sri/auth', 5000);
    const body = String(fetchMock.mock.calls[0][1].body);
    expect(body).toContain('xmlns:ec="http://ec.gob.sri.ws.autorizacion"');
    expect(body).toContain('<claveAccesoComprobante>KEY</claveAccesoComprobante>');

    fetchMock.mockResolvedValueOnce(new Response(RECEPTION_RECIBIDA, { status: 200 }));
    await sendToSriReception('<factura/>', 'https://sri/recepcion', 5000);
    const receptionBody = String(fetchMock.mock.calls[1][1].body);
    expect(receptionBody).toContain('xmlns:ec="http://ec.gob.sri.ws.recepcion"');
    expect(receptionBody).toContain(`<xml>${Buffer.from('<factura/>').toString('base64')}</xml>`);
  });

  it('corta por timeout en vez de quedarse colgada', async () => {
    vi.stubGlobal('fetch', (_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(Object.assign(new Error('timeout'), { name: 'TimeoutError' })));
      }),
    );
    await expect(querySriAuthorization('KEY', 'https://sri/auth', 20)).rejects.toThrow(/sin respuesta/);
  });

  it('un Fault con HTTP 500 da el motivo del SRI, no solo el código', async () => {
    vi.stubGlobal('fetch', async () => new Response(REAL_FAULT_OLD_ENVELOPE, { status: 500 }));
    await expect(querySriAuthorization('KEY', 'https://sri/auth', 5000)).rejects.toThrow(/Unexpected wrapper element/);
  });
});

/**
 * Un comprobante que no se puede emitir **por sus datos**, no por la red.
 *
 * La distinción importa para reintentar: un fallo de red se arregla solo
 * volviendo a intentarlo; uno de estos no, porque el SRI lo va a rechazar igual
 * hasta que alguien corrija la factura, el producto o la configuración. Por eso
 * se detectan aquí, antes de firmar y enviar, con un mensaje que diga qué falta.
 */
export class FiscalValidationError extends Error {
  readonly problems: string[];

  constructor(problems: string[] | string) {
    const list = Array.isArray(problems) ? problems : [problems];
    super(list.join('; '));
    this.name = 'FiscalValidationError';
    this.problems = list;
  }
}

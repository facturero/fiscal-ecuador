import type { IssuerDirectory } from '../../application/ports.js';
import type { DirectIssuerSnapshot } from '../../domain/direct-documents.js';
import { FiscalValidationError } from '../../domain/errors.js';

const TIMEOUT_MS = 10_000;

/**
 * Resuelve el emisor de un comprobante propio de fiscal desde organization-service (server-to-server, así que pone ella misma
 * las cabeceras que el gateway inyectaría; mismo patrón que `HttpFiscalCatalogs`).
 *
 * A diferencia del catálogo, aquí NO se devuelve «no sé»: sin RUC, establecimiento o punto de emisión no se puede numerar ni
 * firmar nada, así que se lanza un error de validación con lo que falta.
 */
export class HttpIssuerDirectory implements IssuerDirectory {
  constructor(private readonly orgServiceUrl: string) {}

  async resolve(organizationId: string, establishmentId: string, emissionPointId: string): Promise<DirectIssuerSnapshot> {
    const org = await this.get<{ legalName: string | null; tradeName: string | null; taxId: string | null }>(
      '/organizations/me', organizationId, 'organization:read', 'la organización',
    );
    if (!org.legalName || !org.taxId) {
      throw new FiscalValidationError('La organización no tiene razón social o RUC: complétalos en Organización antes de emitir comprobantes');
    }

    const establishments = await this.get<Array<{ id: string; code: string; address: string | null; status: string }>>(
      '/establishments', organizationId, 'establishment:read', 'los establecimientos',
    );
    const establishment = establishments.find((e) => e.id === establishmentId);
    if (!establishment) throw new FiscalValidationError('El establecimiento elegido no existe');
    if (establishment.status !== 'active') throw new FiscalValidationError('El establecimiento elegido está inactivo');

    const points = await this.get<Array<{ id: string; code: string; status: string }>>(
      `/establishments/${encodeURIComponent(establishmentId)}/billing-points`, organizationId, 'establishment:read', 'los puntos de emisión',
    );
    const point = points.find((p) => p.id === emissionPointId);
    if (!point) throw new FiscalValidationError('El punto de emisión elegido no existe en ese establecimiento');
    if (point.status !== 'active') throw new FiscalValidationError('El punto de emisión elegido está inactivo');

    return {
      legalName: org.legalName,
      tradeName: org.tradeName,
      taxId: org.taxId,
      establishmentCode: establishment.code,
      emissionPointCode: point.code,
      address: establishment.address,
    };
  }

  private async get<T>(path: string, organizationId: string, permission: string, what: string): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${this.orgServiceUrl}${path}`, {
        headers: { 'X-Organization-Id': organizationId, 'X-Permissions': permission },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      // Sin organization-service no se puede emitir; no es un dato mal puesto, así que no es un FiscalValidationError.
      throw upstreamError(`No se pudo leer ${what} (organization-service no responde: ${(err as Error).message})`);
    }
    if (!response.ok) throw upstreamError(`No se pudo leer ${what} (organization-service respondió ${response.status})`);
    return (await response.json()) as T;
  }
}

function upstreamError(message: string): Error {
  return Object.assign(new Error(message), { statusCode: 502, name: 'UpstreamError' });
}

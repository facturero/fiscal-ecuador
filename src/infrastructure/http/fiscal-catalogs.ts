import type { FiscalCatalogs } from '../../application/ports.js';
import type { IssuerFiscalProfile } from '../../domain/invoice-xml-builder.js';

const TIMEOUT_MS = 10_000;

/**
 * Las llamadas entre servicios no pasan por el gateway, así que cada servicio
 * pide a mano el contexto que el gateway inyectaría. Sin esto tax-service
 * responde 401 (exige X-User-Id) y organization-service 403 (exige el permiso),
 * y fiscal facturaba sin catálogo ni perfil tributario del emisor sin avisar.
 * Mismo patrón que billing-service. Se vio al emitir de punta a punta en
 * docker-compose; con dobles no aparece.
 */
const TAX_SERVICE_HEADERS = { 'X-User-Id': 'fiscal-ecuador' };

/**
 * Los datos de apoyo para armar el XML: códigos de impuestos y de tipo de
 * identificación (tax-service) y el perfil tributario del emisor
 * (organization-service).
 *
 * Si un catálogo no responde se devuelve "no sé" (`undefined` o `{}`) y no un
 * valor inventado: es el constructor del XML el que decide si puede seguir sin
 * ese dato o si la factura se queda en error hasta que el catálogo vuelva.
 */
export class HttpFiscalCatalogs implements FiscalCatalogs {
  constructor(
    private readonly taxServiceUrl: string,
    private readonly orgServiceUrl: string,
  ) {}

  async taxCodesById(countryCode: string): Promise<Record<string, string> | undefined> {
    const rates = await this.getJson<Array<{ id: string; code: string }>>(
      `${this.taxServiceUrl}/countries/${countryCode}/tax-rates`,
      'tarifas de impuestos',
      TAX_SERVICE_HEADERS,
    );
    if (!rates?.length) return undefined;
    return Object.fromEntries(rates.filter((r) => r.id && r.code).map((r) => [r.id, r.code]));
  }

  async identificationTypeCode(countryCode: string, identificationTypeId: string): Promise<string | undefined> {
    const types = await this.getJson<Array<{ id: string; code: string }>>(
      `${this.taxServiceUrl}/countries/${countryCode}/identification-types`,
      'tipos de identificación',
      TAX_SERVICE_HEADERS,
    );
    return types?.find((t) => t.id === identificationTypeId)?.code;
  }

  async issuerProfile(organizationId: string): Promise<IssuerFiscalProfile> {
    const org = await this.getJson<{ settings?: Record<string, unknown> | null }>(
      `${this.orgServiceUrl}/organizations/me`,
      'organización',
      { 'X-Organization-Id': organizationId, 'X-Permissions': 'organization:read' },
    );
    return profileFromSettings(org?.settings ?? null);
  }

  private async getJson<T>(url: string, what: string, headers: Record<string, string> = {}): Promise<T | undefined> {
    try {
      const response = await fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!response.ok) {
        console.warn(`[fiscal-ecuador] No se pudo leer ${what} (${response.status})`);
        return undefined;
      }
      return (await response.json()) as T;
    } catch (err) {
      console.warn(`[fiscal-ecuador] No se pudo leer ${what}: ${(err as Error).message}`);
      return undefined;
    }
  }
}

/**
 * Lee de `organization.settings` lo que el SRI necesita del emisor. Todas son
 * claves opcionales: la pantalla de organización hoy solo guarda
 * `obligadoContabilidad`; las demás se escriben en settings cuando apliquen.
 */
export function profileFromSettings(settings: Record<string, unknown> | null): IssuerFiscalProfile {
  if (!settings) return {};
  const str = (key: string) => (typeof settings[key] === 'string' && (settings[key] as string).trim()) || undefined;
  return {
    obligadoContabilidad:
      typeof settings.obligadoContabilidad === 'boolean' ? (settings.obligadoContabilidad ? 'SI' : 'NO') : undefined,
    contribuyenteEspecial: str('contribuyenteEspecial'),
    contribuyenteRimpe: str('contribuyenteRimpe'),
    agenteRetencion: str('agenteRetencion'),
    dirMatriz: str('dirMatriz'),
    defaultPaymentMethodCode: str('defaultPaymentMethodCode'),
  };
}

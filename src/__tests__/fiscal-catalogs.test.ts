import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpFiscalCatalogs, profileFromSettings } from '../infrastructure/http/fiscal-catalogs.js';
import { describeFetchError } from '../infrastructure/http/document-storage.js';

/**
 * Contrato con tax-service y organization-service. Estos servicios no se
 * llaman a través del gateway: si falta una cabecera responden 401/403 y fiscal
 * seguía adelante sin catálogo y sin perfil del emisor, sin ningún error visible.
 */
describe('Llamadas a los catálogos', () => {
  afterEach(() => vi.unstubAllGlobals());

  function stub(routes: Record<string, (headers: Headers) => Response>) {
    const calls: Array<{ url: string; headers: Headers }> = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
      const headers = new Headers(init.headers);
      calls.push({ url, headers });
      const handler = Object.entries(routes).find(([suffix]) => url.endsWith(suffix))?.[1];
      return handler ? handler(headers) : new Response('no', { status: 404 });
    });
    return calls;
  }

  it('tax-service recibe X-User-Id (sin él responde 401)', async () => {
    const calls = stub({
      '/countries/EC/tax-rates': (h) =>
        h.get('X-User-Id')
          ? Response.json([{ id: 'r1', code: 'IVA15' }])
          : new Response('{"code":"USER_CONTEXT_REQUIRED"}', { status: 401 }),
    });
    const catalogs = new HttpFiscalCatalogs('http://tax', 'http://org');
    expect(await catalogs.taxCodesById('EC')).toEqual({ r1: 'IVA15' });
    expect(calls[0].headers.get('X-User-Id')).toBe('fiscal-ecuador');
  });

  it('organization-service recibe la organización y el permiso organization:read (sin él responde 403)', async () => {
    stub({
      '/organizations/me': (h) =>
        h.get('X-Permissions')?.split(',').includes('organization:read') && h.get('X-Organization-Id') === 'org-1'
          ? Response.json({ settings: { obligadoContabilidad: false, contribuyenteRimpe: 'CONTRIBUYENTE RÉGIMEN RIMPE' } })
          : new Response('{"code":"FORBIDDEN"}', { status: 403 }),
    });
    const catalogs = new HttpFiscalCatalogs('http://tax', 'http://org');
    expect(await catalogs.issuerProfile('org-1')).toMatchObject({
      obligadoContabilidad: 'NO',
      contribuyenteRimpe: 'CONTRIBUYENTE RÉGIMEN RIMPE',
    });
  });

  it('si el catálogo no responde devuelve "no sé", no un valor inventado', async () => {
    stub({});
    const catalogs = new HttpFiscalCatalogs('http://tax', 'http://org');
    expect(await catalogs.taxCodesById('EC')).toBeUndefined();
    expect(await catalogs.issuerProfile('org-1')).toEqual({});
  });

  it('el perfil ignora claves vacías o de tipo equivocado', () => {
    expect(profileFromSettings({ contribuyenteEspecial: '  ', agenteRetencion: 5, dirMatriz: 'Quito' })).toEqual({
      obligadoContabilidad: undefined,
      contribuyenteEspecial: undefined,
      contribuyenteRimpe: undefined,
      agenteRetencion: undefined,
      dirMatriz: 'Quito',
      defaultPaymentMethodCode: undefined,
    });
  });
});

describe('Errores de red legibles', () => {
  it('saca la causa real de "fetch failed"', () => {
    const err = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    expect(describeFetchError(err)).toBe('ECONNREFUSED');
    expect(describeFetchError(Object.assign(new Error('x'), { name: 'TimeoutError' }))).toBe('tiempo de espera agotado');
  });
});

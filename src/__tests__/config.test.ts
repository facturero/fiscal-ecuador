import { describe, expect, it } from 'vitest';
import { resolveConfig, SRI_ENDPOINTS } from '../infrastructure/config.js';

describe('Configuración del SRI', () => {
  it('pruebas apunta a celcer', () => {
    const { env } = resolveConfig({ SRI_ENVIRONMENT: 'pruebas' });
    expect(env?.SRI_RECEPTION_URL).toBe(SRI_ENDPOINTS.pruebas.reception);
    expect(env?.SRI_AUTHORIZATION_URL).toBe(SRI_ENDPOINTS.pruebas.authorization);
  });

  it('producción apunta a cel, no a celcer', () => {
    const { env } = resolveConfig({ SRI_ENVIRONMENT: 'produccion' });
    expect(env?.SRI_RECEPTION_URL).toBe('https://cel.sri.gob.ec/comprobantes-electronicos-ws/RecepcionComprobantesOffline');
    expect(env?.SRI_AUTHORIZATION_URL).toBe('https://cel.sri.gob.ec/comprobantes-electronicos-ws/AutorizacionComprobantesOffline');
  });

  it('se niega a arrancar si el ambiente y las URLs no coinciden', () => {
    const { env, problems } = resolveConfig({ SRI_ENVIRONMENT: 'produccion', SRI_RECEPTION_URL: SRI_ENDPOINTS.pruebas.reception });
    expect(env).toBeUndefined();
    expect(problems).toEqual([expect.stringMatching(/apuntan a celcer/)]);
  });

  it('en producción se niega a arrancar con los secretos de desarrollo', () => {
    const { env, problems } = resolveConfig({ NODE_ENV: 'production' });
    expect(env).toBeUndefined();
    expect(problems).toEqual([
      expect.stringMatching(/CERTIFICATE_MASTER_KEY/),
      expect.stringMatching(/INTERNAL_SERVICE_SECRET/),
    ]);
  });

  it('en producción arranca con secretos propios', () => {
    const { env, problems } = resolveConfig({
      NODE_ENV: 'production', CERTIFICATE_MASTER_KEY: 'a'.repeat(64), INTERNAL_SERVICE_SECRET: 'secreto-real',
    });
    expect(problems).toEqual([]);
    expect(env).toBeDefined();
  });

  it('en desarrollo los valores por defecto no avisan', () => {
    expect(resolveConfig({}).warnings).toEqual([]);
  });
});

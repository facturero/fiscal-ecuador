import { describe, expect, it } from 'vitest';
import { createApp } from '../interface/http/app.js';

const app = createApp({
  corsOrigin: '*',
  documents: { upload: async () => 'x', download: async () => Buffer.from('') },
  onRetry: async () => null,
});

function retry(permissions: string) {
  return app.fetch(new Request('http://localhost/fiscal-invoices/inv-1/retry', {
    method: 'POST',
    headers: { 'X-Organization-Id': 'org-1', 'X-Permissions': permissions },
  }));
}

function ride(permissions: string) {
  return app.fetch(new Request('http://localhost/fiscal-invoices/inv-1/ride', {
    headers: { 'X-Organization-Id': 'org-1', 'X-Permissions': permissions },
  }));
}

/** Los casos con permiso pasan a la base: están en integration/http.int.test.ts. */
describe('Permisos del reintento fiscal (sin permiso no llega a la base)', () => {
  it('sin invoice:authorize ni fiscal:manage responde 403 y dice qué hace falta', async () => {
    const res = await retry('fiscal:read,invoice:read,invoice:issue');
    expect(res.status).toBe(403);
    expect((await res.json()).message).toBe('Permiso requerido: invoice:authorize o fiscal:manage');
  });

  it('sin organización responde 401', async () => {
    const res = await app.fetch(new Request('http://localhost/fiscal-invoices/inv-1/retry', { method: 'POST' }));
    expect(res.status).toBe(401);
  });
});

describe('Permisos de la descarga del RIDE', () => {
  it('requirePermission(fiscal:read): sin fiscal:read responde 403', async () => {
    const res = await ride('invoice:read');
    expect(res.status).toBe(403);
    expect((await res.json()).message).toBe('Permiso requerido: fiscal:read');
  });

  it('sin organización responde 401', async () => {
    const res = await app.fetch(new Request('http://localhost/fiscal-invoices/inv-1/ride'));
    expect(res.status).toBe(401);
  });
});

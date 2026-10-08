import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { getActor } from '@facturero/outbox-relay';
import {
  certificateRevokedEvent,
  certificateUploadedEvent,
  invoiceRetryRequestedEvent,
} from '../domain/audit-events.js';
import { requireOrganization } from '../interface/http/middlewares.js';

const cert = {
  id: 'cert-1',
  organization_id: 'org-1',
  alias: 'Firma 2026',
  p12_file_id: 'file-1',
  valid_from: '2026-01-01',
  valid_until: '2027-01-01',
  status: 'active',
};

describe('eventos de auditoría de certificados y reintentos', () => {
  it('subir un certificado: dice cuál, de quién y cuándo vence, y nunca lleva la contraseña', () => {
    const ev = certificateUploadedEvent({ ...cert, password_encrypted: 'secreto' } as typeof cert);
    expect(ev.type).toBe('fiscal.ec.certificate.uploaded');
    expect(ev.aggregateId).toBe('cert-1');
    expect(ev.payload).toMatchObject({
      targetId: 'cert-1',
      organizationId: 'org-1',
      alias: 'Firma 2026',
      fileId: 'file-1',
      validFrom: '2026-01-01',
      validUntil: '2027-01-01',
    });
    expect(JSON.stringify(ev.payload)).not.toMatch(/secreto|password/i);
  });

  it('revocar un certificado: conserva el estado que tenía', () => {
    const ev = certificateRevokedEvent(cert);
    expect(ev.type).toBe('fiscal.ec.certificate.revoked');
    expect(ev.payload).toMatchObject({ targetId: 'cert-1', organizationId: 'org-1', previousStatus: 'active' });
  });

  it('pedir un reintento: apunta a la factura de billing y recorta el error previo', () => {
    const ev = invoiceRetryRequestedEvent({
      id: 'fi-1',
      organization_id: 'org-1',
      billing_invoice_id: 'inv-1',
      number: '001-001-000000012',
      last_error: 'x'.repeat(2000),
    });
    expect(ev.type).toBe('fiscal.ec.invoice.retry_requested');
    expect(ev.payload.invoiceId).toBe('inv-1');
    expect((ev.payload.previousError as string).length).toBe(500);
  });

  it('ningún evento de auditoría coincide con el que el gateway convierte en notificación', () => {
    const tipos = [
      certificateUploadedEvent(cert).type,
      certificateRevokedEvent(cert).type,
      invoiceRetryRequestedEvent({
        id: 'a', organization_id: 'b', billing_invoice_id: 'c', number: 'd', last_error: null,
      }).type,
    ];
    expect(tipos).not.toContain('fiscal.ec.invoice.attention_required');
  });
});

describe('requireOrganization deja al actor en el contexto de la petición', () => {
  const app = new Hono();
  app.get('/quien', requireOrganization(), (c) => c.json(getActor() ?? null));

  it('usuario, correo, IP y request id llegan hasta quien publica el evento', async () => {
    const res = await app.fetch(
      new Request('http://localhost/quien', {
        headers: {
          'X-Organization-Id': 'org-1',
          'X-User-Id': 'user-9',
          'X-User-Email': 'ana@empresa.com',
          'X-Client-Ip': '203.0.113.7',
          'X-Request-Id': 'req-1',
        },
      }),
    );
    expect(await res.json()).toEqual({
      actorId: 'user-9',
      actorEmail: 'ana@empresa.com',
      actorIp: '203.0.113.7',
      requestId: 'req-1',
    });
  });

  it('sin cabeceras de usuario el actor queda vacío, no inventado', async () => {
    const res = await app.fetch(new Request('http://localhost/quien', { headers: { 'X-Organization-Id': 'org-1' } }));
    expect(await res.json()).toEqual({ actorId: null, actorEmail: null, actorIp: null, requestId: null });
  });
});

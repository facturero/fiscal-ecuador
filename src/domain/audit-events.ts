/**
 * Eventos que existen SOLO para la bitácora de auditoría: nadie más los consume. Registran lo que una persona hizo con
 * el certificado de firma o con una factura, que no cambia el estado fiscal y por eso no salía en ningún
 * `fiscal.ec.invoice.*`. Quién lo hizo (actorId/actorEmail/ip) lo añade el outbox desde el contexto de la petición.
 *
 * Ojo con los nombres: el gateway solo escucha `fiscal.ec.invoice.attention_required` (notificaciones). Ninguno de estos coincide, y un
 * aviso de auditoría no debe hacer sonar la campana de nadie: no los renombres a ese evento.
 *
 * Jamás llevan la contraseña del .p12 ni su contenido: la bitácora la lee cualquiera con `audit:read` y no se borra.
 */
export interface AuditEventDraft {
  type: string;
  aggregateType: string;
  aggregateId: string;
  payload: Record<string, unknown>;
}

export function certificateUploadedEvent(cert: {
  id: string;
  organization_id: string;
  alias: string;
  p12_file_id: string;
  valid_from: string;
  valid_until: string;
}): AuditEventDraft {
  return {
    type: 'fiscal.ec.certificate.uploaded',
    aggregateType: 'certificate',
    aggregateId: cert.id,
    payload: {
      targetId: cert.id,
      organizationId: cert.organization_id,
      alias: cert.alias,
      fileId: cert.p12_file_id,
      validFrom: cert.valid_from,
      validUntil: cert.valid_until,
    },
  };
}

export function certificateRevokedEvent(cert: {
  id: string;
  organization_id: string;
  alias: string;
  valid_until: string;
  status: string;
}): AuditEventDraft {
  return {
    type: 'fiscal.ec.certificate.revoked',
    aggregateType: 'certificate',
    aggregateId: cert.id,
    payload: {
      targetId: cert.id,
      organizationId: cert.organization_id,
      alias: cert.alias,
      validUntil: cert.valid_until,
      previousStatus: cert.status,
    },
  };
}

export function invoiceRetryRequestedEvent(invoice: {
  id: string;
  organization_id: string;
  billing_invoice_id: string;
  number: string;
  last_error: string | null;
}): AuditEventDraft {
  return {
    type: 'fiscal.ec.invoice.retry_requested',
    aggregateType: 'fiscal_invoice',
    aggregateId: invoice.id,
    payload: {
      invoiceId: invoice.billing_invoice_id,
      organizationId: invoice.organization_id,
      number: invoice.number,
      previousError: invoice.last_error ? invoice.last_error.slice(0, 500) : null,
    },
  };
}

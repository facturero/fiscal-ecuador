import { randomUUID } from 'node:crypto';
import type { Transaction } from 'sequelize';
import { withActor } from '@facturero/outbox-relay';
import type { AuditEventDraft } from '../../domain/audit-events.js';
import { OutboxModel } from '../persistence/models.js';

/**
 * Deja un evento de auditoría en el outbox. Va dentro de la misma transacción que el cambio, para que no pueda existir
 * uno sin el otro. `withActor` le pega quién lo hizo (usuario, correo, IP, request id) desde el contexto de la petición.
 */
export async function recordAuditEvent(event: AuditEventDraft, transaction?: Transaction): Promise<void> {
  await OutboxModel.create(
    {
      id: randomUUID(),
      aggregate_type: event.aggregateType,
      aggregate_id: event.aggregateId,
      type: event.type,
      payload: withActor({ ...event.payload, occurredAt: new Date().toISOString() }),
      occurred_at: new Date(),
      processed_at: null,
    },
    { transaction },
  );
}

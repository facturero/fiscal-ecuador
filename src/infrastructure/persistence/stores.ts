import { randomUUID } from 'node:crypto';
import { Op } from 'sequelize';
import { sequelize } from './sequelize.js';
import { CertificateModel, FiscalInvoiceModel, OutboxModel } from './models.js';
import type {
  CertificateStore,
  FiscalEvent,
  FiscalInvoiceRecord,
  FiscalInvoiceStore,
  FiscalStatus,
  SigningCertificate,
} from '../../application/ports.js';
import type { InvoiceIssuedPayload } from '../../domain/types.js';

/** Aviso para la campana: una factura fiscal necesita que alguien actúe. */
export const ATTENTION_EVENT = 'fiscal.ec.invoice.attention_required';

function toRecord(model: FiscalInvoiceModel): FiscalInvoiceRecord {
  const v = model.get({ plain: true }) as Record<string, unknown>;
  return {
    ...(v as unknown as FiscalInvoiceRecord),
    original_payload: (v.original_payload as InvoiceIssuedPayload | null) ?? null,
  };
}

export class SequelizeFiscalInvoiceStore implements FiscalInvoiceStore {
  async findByBillingInvoiceId(billingInvoiceId: string): Promise<FiscalInvoiceRecord | null> {
    const row = await FiscalInvoiceModel.findOne({ where: { billing_invoice_id: billingInvoiceId } });
    return row ? toRecord(row) : null;
  }

  async findOtherWithNumber(organizationId: string, number: string, billingInvoiceId: string): Promise<FiscalInvoiceRecord | null> {
    const row = await FiscalInvoiceModel.findOne({
      where: { organization_id: organizationId, number, billing_invoice_id: { [Op.ne]: billingInvoiceId } },
    });
    return row ? toRecord(row) : null;
  }

  async findLatestBefore(organizationId: string, number: string): Promise<FiscalInvoiceRecord | null> {
    // El prefijo (establecimiento-punto) va delante del secuencial: comparar
    // cadenas del mismo prefijo es comparar secuenciales. El LIKE evita saltar
    // entre puntos de emisión distintos de la misma organización.
    const prefix = number.slice(0, 8);
    const row = await FiscalInvoiceModel.findOne({
      where: {
        organization_id: organizationId,
        number: { [Op.like]: `${prefix}%`, [Op.lt]: number },
      },
      order: [['number', 'DESC']],
    });
    return row ? toRecord(row) : null;
  }

  async findBetween(organizationId: string, fromNumber: string, toNumber: string): Promise<FiscalInvoiceRecord[]> {
    const rows = await FiscalInvoiceModel.findAll({
      where: {
        organization_id: organizationId,
        number: { [Op.gt]: fromNumber, [Op.lt]: toNumber },
      },
    });
    return rows.map(toRecord);
  }

  /**
   * Registro y evento en una sola transacción: si el proceso muere entre las
   * dos escrituras no queda un estado sin evento ni al revés.
   *
   * Insert o update explícito por id, y NO `upsert`. En MySQL `upsert` es
   * `INSERT ... ON DUPLICATE KEY UPDATE`, que salta con CUALQUIER índice único:
   * una factura nueva con un número ya usado reemplazaba entera la fila de la
   * otra factura (id incluido) sin dar error. Lo encontró el test de
   * integración contra MySQL; con dobles en memoria no se ve.
   */
  async save(record: FiscalInvoiceRecord, event?: FiscalEvent): Promise<void> {
    await sequelize.transaction(async (transaction) => {
      const { id, ...fields } = record;
      const [updated] = await FiscalInvoiceModel.update(fields as never, { where: { id }, transaction });
      if (updated === 0) {
        const exists = await FiscalInvoiceModel.count({ where: { id }, transaction });
        // MySQL cuenta como 0 filas afectadas un UPDATE sin cambios reales.
        if (!exists) await FiscalInvoiceModel.create(record as never, { transaction });
      }
      if (!event) return;
      const payload = {
        fiscalInvoiceId: record.id,
        billingInvoiceId: record.billing_invoice_id,
        // Mismo nombre que en billing.invoice.*: la campana enlaza con él a la factura.
        invoiceId: record.billing_invoice_id,
        organizationId: record.organization_id,
        number: record.number,
        status: record.status,
        type: event.type,
        message: event.message,
        requiresAttention: event.requiresAttention,
        // Sin destinatario el gateway descarta el evento y la campana no suena.
        ...(record.original_payload?.userId ? { userId: record.original_payload.userId } : {}),
      };
      const rows = [`fiscal.ec.invoice.${event.type}`];
      // Un aviso aparte, y solo cuando hace falta una persona: los errores que
      // se reintentan solos no deben llenar la campana. Es el evento al que
      // están suscritos notification-service y el hub del gateway.
      if (event.requiresAttention) rows.push(ATTENTION_EVENT);
      for (const type of rows) {
        await OutboxModel.create(
          {
            id: randomUUID(),
            aggregate_type: 'fiscal_invoice',
            aggregate_id: record.id,
            type,
            payload,
            occurred_at: new Date(),
            processed_at: null,
          },
          { transaction },
        );
      }
    });
  }

  async findDue(status: FiscalStatus, now: Date, limit: number): Promise<FiscalInvoiceRecord[]> {
    const rows = await FiscalInvoiceModel.findAll({
      where: { status, next_check_at: { [Op.lte]: now } },
      order: [['next_check_at', 'ASC']],
      limit,
    });
    return rows.map(toRecord);
  }

  async findStalePending(updatedBefore: Date, limit: number): Promise<FiscalInvoiceRecord[]> {
    const rows = await FiscalInvoiceModel.findAll({
      where: { status: 'pending', updated_at: { [Op.lt]: updatedBefore }, billing_voided_at: null },
      order: [['updated_at', 'ASC']],
      limit,
    });
    return rows.map(toRecord);
  }
}

export class SequelizeCertificateStore implements CertificateStore {
  async listActive(organizationId: string): Promise<SigningCertificate[]> {
    const rows = await CertificateModel.findAll({
      where: { organization_id: organizationId, status: 'active' },
      order: [['created_at', 'DESC']],
    });
    return rows.map((c) => ({
      id: c.id,
      p12FileId: c.p12_file_id,
      passwordEncrypted: c.password_encrypted,
      validFrom: String(c.valid_from),
      validUntil: String(c.valid_until),
      status: c.status,
      createdAt: c.created_at,
    }));
  }

  async markExpired(ids: string[]): Promise<void> {
    if (!ids.length) return;
    await CertificateModel.update({ status: 'expired' }, { where: { id: ids, status: 'active' } });
  }
}

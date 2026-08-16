import { DataTypes, InferAttributes, InferCreationAttributes, Model } from 'sequelize';
import { sequelize } from './sequelize.js';

// ── Fiscal Invoice ────────────────────────────────────────────────────────

export class FiscalInvoiceModel extends Model<
  InferAttributes<FiscalInvoiceModel>,
  InferCreationAttributes<FiscalInvoiceModel>
> {
  declare id: string;
  declare organization_id: string;
  declare billing_invoice_id: string;
  declare number: string;
  declare access_key: string;
  declare status: 'pending' | 'sent' | 'authorized' | 'rejected' | 'error';
  declare authorization_number: string | null;
  declare authorization_date: Date | null;
  declare sri_response: unknown | null;
  declare signed_xml_file_id: string | null;
  declare retry_count: number;
  declare last_error: string | null;
  declare original_payload: unknown | null;
  declare created_at: Date;
  declare updated_at: Date;
}

FiscalInvoiceModel.init(
  {
    id: { type: DataTypes.CHAR(36), primaryKey: true },
    organization_id: { type: DataTypes.CHAR(36), allowNull: false },
    billing_invoice_id: { type: DataTypes.CHAR(36), allowNull: false, unique: true },
    number: { type: DataTypes.STRING(30), allowNull: false },
    access_key: { type: DataTypes.CHAR(49), allowNull: false, unique: true },
    status: { type: DataTypes.ENUM('pending', 'sent', 'authorized', 'rejected', 'error'), allowNull: false, defaultValue: 'pending' },
    authorization_number: { type: DataTypes.STRING(49), allowNull: true },
    authorization_date: { type: DataTypes.DATE, allowNull: true },
    sri_response: { type: DataTypes.JSON, allowNull: true },
    signed_xml_file_id: { type: DataTypes.CHAR(36), allowNull: true },
    retry_count: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    last_error: { type: DataTypes.TEXT, allowNull: true },
    original_payload: { type: DataTypes.JSON, allowNull: true },
    created_at: DataTypes.DATE,
    updated_at: DataTypes.DATE,
  },
  { sequelize, tableName: 'fiscal_invoices', timestamps: false },
);

// ── Certificate ───────────────────────────────────────────────────────────

export class CertificateModel extends Model<
  InferAttributes<CertificateModel>,
  InferCreationAttributes<CertificateModel>
> {
  declare id: string;
  declare organization_id: string;
  declare alias: string;
  declare p12_file_id: string;
  declare password_encrypted: string;
  declare valid_from: string;
  declare valid_until: string;
  declare status: 'active' | 'expired' | 'revoked';
  declare created_at: Date;
}

CertificateModel.init(
  {
    id: { type: DataTypes.CHAR(36), primaryKey: true },
    organization_id: { type: DataTypes.CHAR(36), allowNull: false },
    alias: { type: DataTypes.STRING(100), allowNull: false },
    p12_file_id: { type: DataTypes.CHAR(36), allowNull: false },
    password_encrypted: { type: DataTypes.TEXT, allowNull: false },
    valid_from: { type: DataTypes.DATEONLY, allowNull: false },
    valid_until: { type: DataTypes.DATEONLY, allowNull: false },
    status: { type: DataTypes.ENUM('active', 'expired', 'revoked'), allowNull: false, defaultValue: 'active' },
    created_at: DataTypes.DATE,
  },
  {
    sequelize,
    tableName: 'certificates',
    timestamps: false,
    indexes: [{ fields: ['organization_id', 'status'] }],
  },
);

// ── Outbox ────────────────────────────────────────────────────────────────

export class OutboxModel extends Model<
  InferAttributes<OutboxModel>,
  InferCreationAttributes<OutboxModel>
> {
  declare id: string;
  declare aggregate_type: string;
  declare aggregate_id: string;
  declare type: string;
  declare payload: unknown;
  declare occurred_at: Date;
  declare processed_at: Date | null;
}

OutboxModel.init(
  {
    id: { type: DataTypes.CHAR(36), primaryKey: true },
    aggregate_type: { type: DataTypes.STRING(50), allowNull: false },
    aggregate_id: { type: DataTypes.CHAR(36), allowNull: false },
    type: { type: DataTypes.STRING(100), allowNull: false },
    payload: { type: DataTypes.JSON, allowNull: false },
    occurred_at: { type: DataTypes.DATE, allowNull: false },
    processed_at: { type: DataTypes.DATE, allowNull: true },
  },
  { sequelize, tableName: 'outbox_messages', timestamps: false },
);

// ── Processed Events (idempotencia) ───────────────────────────────────────

export class ProcessedEventModel extends Model<
  InferAttributes<ProcessedEventModel>,
  InferCreationAttributes<ProcessedEventModel>
> {
  declare event_id: string;
  declare processed_at: Date;
}

ProcessedEventModel.init(
  {
    event_id: { type: DataTypes.CHAR(36), primaryKey: true },
    processed_at: { type: DataTypes.DATE, allowNull: false },
  },
  { sequelize, tableName: 'processed_events', timestamps: false },
);

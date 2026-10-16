'use strict';

/**
 * Comprobantes que fiscal emite por su cuenta: retención (07) y guía de remisión (06).
 *
 * - `fiscal_invoices.source`: de dónde viene el comprobante. Las filas existentes llegaron todas por un evento de billing.
 *   Para los emitidos aquí, `billing_invoice_id` guarda el id propio del comprobante (la columna conserva su nombre por no
 *   migrar los consumidores); `source` es lo que distingue los dos mundos.
 * - `fiscal_sequences`: la serie de numeración de esos comprobantes. Billing numera facturas y notas; retenciones y guías no
 *   pasan por él, así que cada una lleva su contador por (organización, establecimiento, punto de emisión, tipo). El contador se
 *   incrementa con una sola sentencia atómica (ver SequelizeDirectDocumentStore).
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    const table = await queryInterface.describeTable('fiscal_invoices');
    if (!table.source) {
      await queryInterface.addColumn('fiscal_invoices', 'source', {
        type: Sequelize.STRING(10),
        allowNull: false,
        defaultValue: 'billing',
      });
    }

    const tables = await queryInterface.showAllTables();
    if (!tables.includes('fiscal_sequences')) {
      await queryInterface.createTable('fiscal_sequences', {
        id: { type: Sequelize.CHAR(36), primaryKey: true },
        organization_id: { type: Sequelize.CHAR(36), allowNull: false },
        establishment_code: { type: Sequelize.CHAR(3), allowNull: false },
        emission_point_code: { type: Sequelize.CHAR(3), allowNull: false },
        document_type: { type: Sequelize.CHAR(2), allowNull: false },
        current_value: { type: Sequelize.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
        updated_at: { type: Sequelize.DATE, allowNull: false },
      });
      await queryInterface.addIndex('fiscal_sequences', ['organization_id', 'establishment_code', 'emission_point_code', 'document_type'], {
        name: 'fiscal_sequences_series_unique',
        unique: true,
      });
    }

    await queryInterface.addIndex('fiscal_invoices', ['organization_id', 'document_type', 'created_at'], {
      name: 'fiscal_invoices_org_type_created',
    });
  },

  async down(queryInterface) {
    await queryInterface.removeIndex('fiscal_invoices', 'fiscal_invoices_org_type_created');
    await queryInterface.dropTable('fiscal_sequences');
    await queryInterface.removeColumn('fiscal_invoices', 'source');
  },
};

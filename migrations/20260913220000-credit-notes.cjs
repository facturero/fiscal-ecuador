'use strict';

/**
 * Notas de crédito (codDoc 04).
 *
 * Hasta ahora `fiscal_invoices` solo guardaba facturas y el registro no llevaba
 * el tipo de documento: `documentTypeCode: '01'` quedaba hardcodeado en la clave
 * de acceso. Una nota de crédito tiene su propia serie en billing (el secuencial
 * es por tipo de documento), así que su número `001-001-000000001` convivirá con
 * la factura 001-001-000000001 de la misma organización. Sin el tipo en la
 * fila, el UNIQUE (organization_id, number) las habría tratado como un secuencial
 * reutilizado.
 *
 * - `document_type`: código SRI del comprobante ('01' factura, '04' nota de
 *   crédito). Las filas existentes son todas facturas: default '01' al añadirla.
 * - El índice único pasa a (organization_id, document_type, number).
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    const table = await queryInterface.describeTable('fiscal_invoices');

    if (!table.document_type) {
      await queryInterface.addColumn('fiscal_invoices', 'document_type', {
        type: Sequelize.CHAR(2),
        allowNull: false,
        defaultValue: '01',
      });
    }

    await queryInterface.removeIndex('fiscal_invoices', 'fiscal_invoices_organization_number_unique');
    await queryInterface.addIndex('fiscal_invoices', ['organization_id', 'document_type', 'number'], {
      name: 'fiscal_invoices_org_type_number_unique',
      unique: true,
    });
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.removeIndex('fiscal_invoices', 'fiscal_invoices_org_type_number_unique');
    await queryInterface.addIndex('fiscal_invoices', ['organization_id', 'number'], {
      name: 'fiscal_invoices_organization_number_unique',
      unique: true,
    });
    await queryInterface.removeColumn('fiscal_invoices', 'document_type');
  },
};
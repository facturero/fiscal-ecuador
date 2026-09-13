'use strict';

/**
 * Columnas para cerrar las brechas de robustez de facturación (FACTURACION-BRECHAS.md):
 *
 * - `access_key` pasa a admitir NULL. Una factura sin datos del emisor no tiene
 *   clave posible; antes se inventaba una de 49 caracteres aleatorios solo para
 *   no violar el NOT NULL + UNIQUE. MySQL admite varios NULL en un UNIQUE.
 * - `authorized_xml_file_id`: el XML que devuelve el SRI al autorizar, que es el
 *   comprobante legal (el firmado aquí no lleva la autorización).
 * - `next_check_at`: cuándo toca volver a mirar la factura (autorización o
 *   reintento), para espaciar las consultas en vez de martillear cada 2 min.
 * - `billing_voided_at`: billing anuló la factura. No se envía nada más al SRI y,
 *   si ya estaba autorizada, se avisa de que hace falta una nota de crédito.
 * - Índice único (organization_id, number): dos facturas de billing con el mismo
 *   número en la misma organización son un secuencial reutilizado.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    const table = await queryInterface.describeTable('fiscal_invoices');

    await queryInterface.changeColumn('fiscal_invoices', 'access_key', {
      type: Sequelize.CHAR(49),
      allowNull: true,
    });

    if (!table.authorized_xml_file_id) {
      await queryInterface.addColumn('fiscal_invoices', 'authorized_xml_file_id', {
        type: Sequelize.CHAR(36),
        allowNull: true,
      });
    }
    if (!table.next_check_at) {
      await queryInterface.addColumn('fiscal_invoices', 'next_check_at', {
        type: Sequelize.DATE,
        allowNull: true,
      });
    }
    if (!table.billing_voided_at) {
      await queryInterface.addColumn('fiscal_invoices', 'billing_voided_at', {
        type: Sequelize.DATE,
        allowNull: true,
      });
    }

    await queryInterface.addIndex('fiscal_invoices', ['status', 'next_check_at'], {
      name: 'fiscal_invoices_status_next_check_at',
    });
    await queryInterface.addIndex('fiscal_invoices', ['organization_id', 'number'], {
      name: 'fiscal_invoices_organization_number_unique',
      unique: true,
    });
    await queryInterface.addIndex('fiscal_invoices', ['organization_id', 'created_at'], {
      name: 'fiscal_invoices_organization_created_at',
    });
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.removeIndex('fiscal_invoices', 'fiscal_invoices_organization_created_at');
    await queryInterface.removeIndex('fiscal_invoices', 'fiscal_invoices_organization_number_unique');
    await queryInterface.removeIndex('fiscal_invoices', 'fiscal_invoices_status_next_check_at');
    await queryInterface.removeColumn('fiscal_invoices', 'billing_voided_at');
    await queryInterface.removeColumn('fiscal_invoices', 'next_check_at');
    await queryInterface.removeColumn('fiscal_invoices', 'authorized_xml_file_id');
    await queryInterface.changeColumn('fiscal_invoices', 'access_key', {
      type: Sequelize.CHAR(49),
      allowNull: false,
    });
  },
};

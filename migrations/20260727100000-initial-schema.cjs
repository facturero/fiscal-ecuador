'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('fiscal_invoices', {
      id: { type: Sequelize.CHAR(36), primaryKey: true },
      organization_id: { type: Sequelize.CHAR(36), allowNull: false },
      billing_invoice_id: { type: Sequelize.CHAR(36), allowNull: false, unique: true },
      number: { type: Sequelize.STRING(30), allowNull: false },
      access_key: { type: Sequelize.CHAR(49), allowNull: false, unique: true },
      status: { type: Sequelize.ENUM('pending', 'sent', 'authorized', 'rejected', 'error'), allowNull: false, defaultValue: 'pending' },
      authorization_number: { type: Sequelize.STRING(49), allowNull: true },
      authorization_date: { type: Sequelize.DATE, allowNull: true },
      sri_response: { type: Sequelize.JSON, allowNull: true },
      signed_xml_file_id: { type: Sequelize.CHAR(36), allowNull: true },
      retry_count: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      last_error: { type: Sequelize.TEXT, allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false },
      updated_at: { type: Sequelize.DATE, allowNull: false },
    });

    await queryInterface.createTable('certificates', {
      id: { type: Sequelize.CHAR(36), primaryKey: true },
      organization_id: { type: Sequelize.CHAR(36), allowNull: false },
      alias: { type: Sequelize.STRING(100), allowNull: false },
      p12_file_id: { type: Sequelize.CHAR(36), allowNull: false },
      password_encrypted: { type: Sequelize.TEXT, allowNull: false },
      valid_from: { type: Sequelize.DATEONLY, allowNull: false },
      valid_until: { type: Sequelize.DATEONLY, allowNull: false },
      status: { type: Sequelize.ENUM('active', 'expired', 'revoked'), allowNull: false, defaultValue: 'active' },
      created_at: { type: Sequelize.DATE, allowNull: false },
    });
    await queryInterface.addIndex('certificates', ['organization_id', 'status']);

    await queryInterface.createTable('outbox_messages', {
      id: { type: Sequelize.CHAR(36), primaryKey: true },
      aggregate_type: { type: Sequelize.STRING(50), allowNull: false },
      aggregate_id: { type: Sequelize.CHAR(36), allowNull: false },
      type: { type: Sequelize.STRING(100), allowNull: false },
      payload: { type: Sequelize.JSON, allowNull: false },
      occurred_at: { type: Sequelize.DATE, allowNull: false },
      processed_at: { type: Sequelize.DATE, allowNull: true },
    });

    await queryInterface.createTable('processed_events', {
      event_id: { type: Sequelize.CHAR(36), primaryKey: true },
      processed_at: { type: Sequelize.DATE, allowNull: false },
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('processed_events');
    await queryInterface.dropTable('outbox_messages');
    await queryInterface.dropTable('certificates');
    await queryInterface.dropTable('fiscal_invoices');
  },
};

'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('fiscal_invoices', 'original_payload', {
      type: Sequelize.JSON,
      allowNull: true,
      after: 'last_error',
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('fiscal_invoices', 'original_payload');
  },
};

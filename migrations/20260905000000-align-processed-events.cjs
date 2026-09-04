'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    const tableDef = await queryInterface.describeTable('processed_events');

    if (tableDef.event_id) {
      await queryInterface.renameColumn('processed_events', 'event_id', 'id');
    }
    const afterDef = await queryInterface.describeTable('processed_events');

    if (!afterDef.event_type) {
      await queryInterface.addColumn('processed_events', 'event_type', {
        type: Sequelize.STRING(100),
        allowNull: false,
        defaultValue: '',
      });
    }
    if (!afterDef.routing_key) {
      await queryInterface.addColumn('processed_events', 'routing_key', {
        type: Sequelize.STRING(200),
        allowNull: false,
        defaultValue: '',
      });
    }
    if (!afterDef.payload) {
      await queryInterface.addColumn('processed_events', 'payload', {
        type: Sequelize.JSON,
        allowNull: true,
      });
    }
    if (!afterDef.status) {
      await queryInterface.addColumn('processed_events', 'status', {
        type: Sequelize.STRING(30),
        allowNull: false,
        defaultValue: 'processed',
      });
    }
    if (!afterDef.last_error) {
      await queryInterface.addColumn('processed_events', 'last_error', {
        type: Sequelize.TEXT,
        allowNull: true,
      });
    }
  },

  async down(queryInterface, Sequelize) {
    const tableDef = await queryInterface.describeTable('processed_events');
    const cols = ['last_error', 'status', 'payload', 'routing_key', 'event_type'];
    for (const col of cols) {
      if (tableDef[col]) {
        await queryInterface.removeColumn('processed_events', col);
      }
    }
    if (tableDef.id) {
      await queryInterface.renameColumn('processed_events', 'id', 'event_id');
    }
  },
};

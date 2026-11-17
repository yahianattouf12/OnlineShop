const { DataTypes, Transaction } = require('sequelize');

const migrations = [
  { name: '001-initial-inventory', up: require('./migrations/001-initial-inventory') },
];

async function migrate(sequelize) {
  const History = sequelize.define('InventoryMigration', {
    name: { type: DataTypes.STRING, allowNull: false, primaryKey: true },
  }, { tableName: 'inventory_migrations', timestamps: false });

  await sequelize.transaction({ isolationLevel: Transaction.ISOLATION_LEVELS.READ_COMMITTED }, async (transaction) => {
    // Serialize startup migrations before checking history, even on a fresh database.
    await sequelize.query("SELECT pg_advisory_xact_lock(hashtext('onlineshop.inventory.migrations'))", { transaction });
    await History.sync({ transaction });

    for (const { name, up } of migrations) {
      if (await History.findByPk(name, { transaction })) continue;
      await up(sequelize, transaction);
      await History.create({ name }, { transaction });
    }
  });
}

module.exports = { migrate };

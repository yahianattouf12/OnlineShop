const { Sequelize } = require('sequelize');
const { defineModels } = require('./models');
const { migrate } = require('./migrate');

// The inventory service has its OWN database. The main application never reads it:
// it can only ask this service over gRPC.
const databaseUrl = process.env.DATABASE_URL;
const sequelize = new Sequelize(databaseUrl, { dialect: 'postgres', logging: false });
const { Stock, Reservation, ReservationItem } = defineModels(sequelize);

/** Wait for PostgreSQL to become reachable, then apply pending migrations. */
async function initDatabase() {
  for (let attempt = 1; ; attempt++) {
    try {
      await sequelize.authenticate();
      break;
    } catch (err) {
      if (attempt >= 30) throw err;
      console.log(`Database not ready (${err.message}), trying again in 2 s...`);
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
  await migrate(sequelize);
}

function closeDatabase() {
  return sequelize.close();
}

module.exports = { sequelize, Stock, Reservation, ReservationItem, initDatabase, closeDatabase };

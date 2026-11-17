const { DataTypes, Op, QueryTypes, fn } = require('sequelize');

const uuidKey = { type: DataTypes.UUID, allowNull: false, primaryKey: true };
const quantity = { type: DataTypes.INTEGER, allowNull: false };
const timestamp = { type: DataTypes.DATE, allowNull: false, defaultValue: fn('now') };

const tables = [
  {
    name: 'stock',
    columns: { product_id: uuidKey, quantity, updated_at: timestamp },
    check: { name: 'stock_quantity_check', fields: ['quantity'], where: { quantity: { [Op.gte]: 0 } } },
    constraints: ['PRIMARY KEY (product_id)', 'CHECK (quantity >= 0)'],
  },
  {
    name: 'reservations',
    columns: {
      order_id: uuidKey,
      status: { type: DataTypes.TEXT, allowNull: false },
      created_at: timestamp,
      released_at: { type: DataTypes.DATE, allowNull: true },
    },
    check: {
      name: 'reservations_status_check',
      fields: ['status'],
      where: { status: { [Op.in]: ['RESERVED', 'RELEASED'] } },
    },
    constraints: ['PRIMARY KEY (order_id)', "CHECK (status = ANY (ARRAY['RESERVED'::text, 'RELEASED'::text]))"],
  },
  {
    name: 'reservation_items',
    columns: {
      order_id: { ...uuidKey, references: { model: 'reservations', key: 'order_id' } },
      product_id: uuidKey,
      quantity,
    },
    check: { name: 'reservation_items_quantity_check', fields: ['quantity'], where: { quantity: { [Op.gt]: 0 } } },
    constraints: [
      'PRIMARY KEY (order_id, product_id)',
      'FOREIGN KEY (order_id) REFERENCES reservations(order_id)',
      'CHECK (quantity > 0)',
    ],
  },
];

const postgresTypes = { UUID: 'UUID', INTEGER: 'INTEGER', TEXT: 'TEXT', DATE: 'TIMESTAMP WITH TIME ZONE' };

function matchesColumn(actual, expected) {
  return actual && actual.type === postgresTypes[expected.type.key]
    && actual.allowNull === expected.allowNull
    && Boolean(actual.primaryKey) === Boolean(expected.primaryKey)
    && actual.defaultValue === (expected.defaultValue ? 'now()' : null);
}

async function up(sequelize, transaction) {
  const queryInterface = sequelize.getQueryInterface();
  // Sequelize's constraint inspection omits CHECK expressions. Read them from PostgreSQL.
  const existing = await sequelize.query(`
    SELECT t.relname AS "tableName", n.nspname AS "schemaName",
           pg_get_constraintdef(c.oid, true) AS definition
    FROM pg_class t
    JOIN pg_namespace n ON n.oid = t.relnamespace
    LEFT JOIN pg_constraint c ON c.conrelid = t.oid AND c.convalidated AND c.contype IN ('p', 'f', 'c', 'u')
    WHERE n.nspname = current_schema() AND t.relkind IN ('r', 'p') AND t.relname::text = ANY($1::text[])
  `, { bind: [tables.map(({ name }) => name)], type: QueryTypes.SELECT, transaction });

  if (existing.length === 0) {
    for (const { name, columns, check } of tables) {
      await queryInterface.createTable(name, columns, { transaction });
      await queryInterface.addConstraint(name, { ...check, type: 'check', transaction });
    }
    return;
  }

  // A previous version created these tables at startup. Adopt them only if they match the baseline.
  for (const { name, columns, constraints } of tables) {
    const rows = existing.filter(({ tableName }) => tableName === name);
    if (rows.length === 0) throw new Error(`Inventory migration 001: existing schema is missing ${name}.`);

    const actual = await queryInterface.describeTable(name, { schema: rows[0].schemaName, transaction });
    const expectedColumns = Object.entries(columns);
    if (Object.keys(actual).length !== expectedColumns.length
        || !expectedColumns.every(([column, expected]) => matchesColumn(actual[column], expected))) {
      throw new Error(`Inventory migration 001: existing columns in ${name} differ from the expected schema.`);
    }

    const actualConstraints = rows.map(({ definition }) => definition);
    if (actualConstraints.length !== constraints.length
        || !constraints.every((constraint) => actualConstraints.includes(constraint))) {
      throw new Error(`Inventory migration 001: existing constraints on ${name} differ from the expected schema.`);
    }
  }
}

module.exports = up;

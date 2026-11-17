const { DataTypes, fn } = require('sequelize');

// Map the inventory database schema managed by migrations.
function defineModels(sequelize) {
  const Stock = sequelize.define('Stock', {
    productId: {
      type: DataTypes.UUID,
      field: 'product_id',
      allowNull: false,
      primaryKey: true,
    },
    quantity: {
      type: DataTypes.INTEGER,
      allowNull: false,
      validate: { min: 0 },
    },
    updatedAt: {
      type: DataTypes.DATE,
      field: 'updated_at',
      allowNull: false,
      defaultValue: fn('now'),
    },
  }, { tableName: 'stock', timestamps: false });

  const Reservation = sequelize.define('Reservation', {
    orderId: {
      type: DataTypes.UUID,
      field: 'order_id',
      allowNull: false,
      primaryKey: true,
    },
    status: {
      type: DataTypes.TEXT,
      allowNull: false,
      validate: { isIn: [['RESERVED', 'RELEASED']] },
    },
    createdAt: {
      type: DataTypes.DATE,
      field: 'created_at',
      allowNull: false,
      defaultValue: fn('now'),
    },
    releasedAt: {
      type: DataTypes.DATE,
      field: 'released_at',
      allowNull: true,
    },
  }, { tableName: 'reservations', timestamps: false });

  const ReservationItem = sequelize.define('ReservationItem', {
    orderId: {
      type: DataTypes.UUID,
      field: 'order_id',
      allowNull: false,
      primaryKey: true,
      references: { model: 'reservations', key: 'order_id' },
    },
    productId: {
      type: DataTypes.UUID,
      field: 'product_id',
      allowNull: false,
      primaryKey: true,
    },
    quantity: {
      type: DataTypes.INTEGER,
      allowNull: false,
      validate: { min: 1 },
    },
  }, { tableName: 'reservation_items', timestamps: false });

  return { Stock, Reservation, ReservationItem };
}

module.exports = { defineModels };

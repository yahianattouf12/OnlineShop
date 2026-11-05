const grpc = require('@grpc/grpc-js');
const { fn } = require('sequelize');
const { sequelize, Stock, Reservation, ReservationItem } = require('./db');

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_INT32 = 2_147_483_647;

/** An error we throw on purpose. The client receives its gRPC status code and its message. */
class RpcError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

class StockShortageError extends Error {
  constructor(shortages) {
    super('Insufficient stock.');
    this.shortages = shortages;
  }
}

function guid(value, field) {
  if (typeof value !== 'string' || !GUID.test(value)) {
    throw new RpcError(grpc.status.INVALID_ARGUMENT, `${field} must be a GUID.`);
  }
  return value.toLowerCase();
}

/**
 * Every transaction touches stock rows in the same order (sorted by product id).
 * Then two orders can never each hold a row the other one is waiting for (a deadlock).
 */
function byProductId(a, b) {
  return a.productId < b.productId ? -1 : a.productId > b.productId ? 1 : 0;
}

async function getStock(request) {
  const productId = guid(request.product_id, 'product_id');
  const stock = await Stock.findByPk(productId, { attributes: ['quantity'] });
  return { product_id: productId, available: stock?.quantity ?? 0 };
}

//! هي الفانكشنتين لسه لهلق ما فهمتهم بدهم شرح متعمق اكثر حتى افهم شو يلي عم يصير بالضبط
async function reserve(request) {
  const orderId = guid(request.order_id, 'order_id');

  if (request.items.length === 0) {
    throw new RpcError(grpc.status.INVALID_ARGUMENT, 'items must not be empty.');
  }

  // The same product twice in one request counts as one item with the quantities added up.
  const quantities = new Map();
  for (const item of request.items) {
    const productId = guid(item.product_id, 'product_id');
    if (item.quantity <= 0) {
      throw new RpcError(grpc.status.INVALID_ARGUMENT, 'quantity must be greater than 0.');
    }
    const total = (quantities.get(productId) ?? 0) + item.quantity;
    if (total > MAX_INT32) {
      throw new RpcError(grpc.status.INVALID_ARGUMENT, 'Total quantity for one product exceeds the maximum.');
    }
    quantities.set(productId, total);
  }
  const items = [...quantities].map(([productId, quantity]) => ({ productId, quantity })).sort(byProductId);

  try {
    return await sequelize.transaction(async (transaction) => {
      const [reservation, created] = await Reservation.findOrCreate({
        where: { orderId },
        defaults: { status: 'RESERVED' },
        transaction,
        lock: true,
      });

      if (!created) {
        if (reservation.status === 'RESERVED') {
          return { reserved: true, shortages: [] };
        }
        throw new RpcError(grpc.status.FAILED_PRECONDITION, `The reservation of order ${orderId} was already released.`);
      }

      const shortages = [];
      for (const { productId, quantity } of items) {
        // Lock before reading the quantity so competing orders check stock one at a time.
        const stock = await Stock.findByPk(productId, { transaction, lock: true });
        const available = stock?.quantity ?? 0;
        if (available < quantity) {
          shortages.push({ product_id: productId, requested: quantity, available });
          continue;
        }
        await stock.update({ quantity: available - quantity, updatedAt: fn('now') }, { transaction });
      }

      // Throw inside the transaction so Sequelize rolls back every deduction and the reservation row.
      if (shortages.length > 0) throw new StockShortageError(shortages);

      await ReservationItem.bulkCreate(items.map((item) => ({ orderId, ...item })), { transaction });
      console.log(`Reserve ${orderId}: reserved ${items.length} product(s)`);
      return { reserved: true, shortages: [] };
    });
  } catch (error) {
    if (!(error instanceof StockShortageError)) throw error;
    console.log(`Reserve ${orderId}: rejected, not enough stock for ${error.shortages.length} product(s)`);
    return { reserved: false, shortages: error.shortages };
  }
}

async function release(request) {
  const orderId = guid(request.order_id, 'order_id');

  return sequelize.transaction(async (transaction) => {
    // Nothing reserved under this order? Still write it down as RELEASED: if its Reserve call
    // arrives late (it was slow on the network), it is refused instead of taking the stock forever.
    // lock: true uses SELECT FOR UPDATE to keep two Release calls from both giving the stock back.
    //! بدي حدا يشرحلي هي تبع Select For Update اجباري
    const [reservation, created] = await Reservation.findOrCreate({
      where: { orderId },
      defaults: { status: 'RELEASED', releasedAt: fn('now') },
      transaction,
      lock: true,
    });
    if (created) {
      console.log(`Release ${orderId}: nothing was reserved`);
      return { released: false };
    }
    if (reservation.status === 'RELEASED') {
      return { released: false };
    }

    const items = await ReservationItem.findAll({ where: { orderId }, transaction });
    for (const { productId, quantity } of items.sort(byProductId)) {
      const stock = await Stock.findByPk(productId, { transaction, lock: true });
      if (stock) {
        await stock.update({ quantity: stock.quantity + quantity, updatedAt: fn('now') }, { transaction });
      }
    }

    await reservation.update({ status: 'RELEASED', releasedAt: fn('now') }, { transaction });

    console.log(`Release ${orderId}: gave back ${items.length} product(s)`);
    return { released: true };
  });
}

async function setStock(request) {
  const productId = guid(request.product_id, 'product_id');
  if (request.quantity < 0) {
    throw new RpcError(grpc.status.INVALID_ARGUMENT, 'quantity must be 0 or more.');
  }

  const [stock] = await Stock.upsert({
    productId,
    quantity: request.quantity,
    updatedAt: fn('now'),
  }, { fields: ['quantity', 'updatedAt'] });

  console.log(`SetStock ${productId}: ${stock.quantity}`);
  return { product_id: productId, available: stock.quantity };
}

module.exports = { RpcError, getStock, reserve, release, setStock };

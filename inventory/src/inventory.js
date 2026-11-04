const grpc = require('@grpc/grpc-js');
const { pool, inTransaction } = require('./db');

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** An error we throw on purpose. The client receives its gRPC status code and its message. */
class RpcError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
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

async function availableOf(db, productId) {
  const { rows } = await db.query('SELECT quantity FROM stock WHERE product_id = $1', [productId]);
  return rows.length ? rows[0].quantity : 0; // a product we never heard of has 0 in stock
}

async function getStock(request) {
  const productId = guid(request.product_id, 'product_id');
  return { product_id: productId, available: await availableOf(pool, productId) };
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
    quantities.set(productId, (quantities.get(productId) ?? 0) + item.quantity);
  }
  const items = [...quantities].map(([productId, quantity]) => ({ productId, quantity })).sort(byProductId);

  return inTransaction(async (db) => {
    // Remember the order first. If it is already here, this is a repeated call (for example a retry).
    const created = await db.query(
      `INSERT INTO reservations (order_id, status) VALUES ($1, 'RESERVED')
       ON CONFLICT (order_id) DO NOTHING`,
      [orderId]);

    if (created.rowCount === 0) {
      const { rows } = await db.query('SELECT status FROM reservations WHERE order_id = $1', [orderId]);
      if (rows[0].status === 'RESERVED') {
        return { commit: true, result: { reserved: true, shortages: [] } }; // already reserved: do not take it twice
      }
      throw new RpcError(grpc.status.FAILED_PRECONDITION, `The reservation of order ${orderId} was already released.`);
    }

    const shortages = [];
    for (const { productId, quantity } of items) {
      // THE protection against the race condition: check and subtract in ONE statement.
      // PostgreSQL locks the row, so when two orders want the last unit at the same moment,
      // the second one waits, then sees quantity = 0, the WHERE does not match, and 0 rows change.
      const taken = await db.query(
        `UPDATE stock SET quantity = quantity - $2, updated_at = now()
         WHERE product_id = $1 AND quantity >= $2`,
        [productId, quantity]);

      if (taken.rowCount === 0) {
        shortages.push({ product_id: productId, requested: quantity, available: await availableOf(db, productId) });
        continue;
      }

      await db.query(
        'INSERT INTO reservation_items (order_id, product_id, quantity) VALUES ($1, $2, $3)',
        [orderId, productId, quantity]);
    }

    // All or nothing: if even one product is short, ROLLBACK gives back what the others took.
    if (shortages.length > 0) {
      console.log(`Reserve ${orderId}: rejected, not enough stock for ${shortages.length} product(s)`);
      return { commit: false, result: { reserved: false, shortages } };
    }

    console.log(`Reserve ${orderId}: reserved ${items.length} product(s)`);
    return { commit: true, result: { reserved: true, shortages: [] } };
  });
}

async function release(request) {
  const orderId = guid(request.order_id, 'order_id');

  return inTransaction(async (db) => {
    // Nothing reserved under this order? Still write it down as RELEASED: if its Reserve call
    // arrives late (it was slow on the network), it is refused instead of taking the stock forever.
    const marked = await db.query(
      `INSERT INTO reservations (order_id, status, released_at) VALUES ($1, 'RELEASED', now())
       ON CONFLICT (order_id) DO NOTHING`,
      [orderId]);
    if (marked.rowCount === 1) {
      console.log(`Release ${orderId}: nothing was reserved`);
      return { commit: true, result: { released: false } };
    }

    // FOR UPDATE: two Release calls for the same order at the same time cannot both give the stock back.
    //! بدي حدا يشرحلي هي تبع Select For Update اجباري
    const { rows } = await db.query('SELECT status FROM reservations WHERE order_id = $1 FOR UPDATE', [orderId]);
    if (rows[0].status === 'RELEASED') {
      return { commit: true, result: { released: false } }; // already given back
    }

    const reserved = await db.query(
      'SELECT product_id AS "productId", quantity FROM reservation_items WHERE order_id = $1',
      [orderId]);
    for (const { productId, quantity } of reserved.rows.sort(byProductId)) {
      await db.query(
        'UPDATE stock SET quantity = quantity + $2, updated_at = now() WHERE product_id = $1',
        [productId, quantity]);
    }

    await db.query(
      `UPDATE reservations SET status = 'RELEASED', released_at = now() WHERE order_id = $1`,
      [orderId]);

    console.log(`Release ${orderId}: gave back ${reserved.rowCount} product(s)`);
    return { commit: true, result: { released: true } };
  });
}

async function setStock(request) {
  const productId = guid(request.product_id, 'product_id');
  if (request.quantity < 0) {
    throw new RpcError(grpc.status.INVALID_ARGUMENT, 'quantity must be 0 or more.');
  }

  const { rows } = await pool.query(
    `INSERT INTO stock (product_id, quantity) VALUES ($1, $2)
     ON CONFLICT (product_id) DO UPDATE SET quantity = EXCLUDED.quantity, updated_at = now()
     RETURNING quantity`,
    [productId, request.quantity]);

  console.log(`SetStock ${productId}: ${rows[0].quantity}`);
  return { product_id: productId, available: rows[0].quantity };
}

module.exports = { RpcError, getStock, reserve, release, setStock };
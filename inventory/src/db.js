const { Pool } = require('pg');

// The inventory service has its OWN database. The main application never reads it:
// it can only ask this service over gRPC.
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const schema = `
  CREATE TABLE IF NOT EXISTS stock (
    product_id  UUID PRIMARY KEY,
    quantity    INT NOT NULL CHECK (quantity >= 0),   -- the database itself refuses a negative stock
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  -- One row per order: is its reservation still held, or was it given back?
  CREATE TABLE IF NOT EXISTS reservations (
    order_id    UUID PRIMARY KEY,
    status      TEXT NOT NULL CHECK (status IN ('RESERVED', 'RELEASED')),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    released_at TIMESTAMPTZ
  );

  -- What exactly each order reserved, so Release knows what to give back.
  CREATE TABLE IF NOT EXISTS reservation_items (
    order_id    UUID NOT NULL REFERENCES reservations (order_id),
    product_id  UUID NOT NULL,
    quantity    INT NOT NULL CHECK (quantity > 0),
    PRIMARY KEY (order_id, product_id)
  );
`;

/** Creates the tables. Tries again for a while, because the database may still be starting. */
async function initDatabase() {
  for (let attempt = 1; ; attempt++) {
    try {
      await pool.query(schema);
      return;
    } catch (err) {
      if (attempt >= 30) throw err;
      console.log(`Database not ready (${err.message}), trying again in 2 s...`);
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
}

/**
 * Runs work(db) inside ONE database transaction.
 * work returns { commit, result }: commit = false undoes everything it did (ROLLBACK).
 * If work throws, everything is undone too.
 */
async function inTransaction(work) {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    const { commit, result } = await work(db);
    await db.query(commit ? 'COMMIT' : 'ROLLBACK');
    return result;
  } catch (err) {
    await db.query('ROLLBACK');
    throw err;
  } finally {
    db.release();
  }
}

module.exports = { pool, initDatabase, inTransaction };
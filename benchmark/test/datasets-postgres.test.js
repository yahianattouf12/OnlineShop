const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

// Opt in with a disposable container; these tests never connect to the project's app-db.
const container = process.env.TEST_POSTGRES_CONTAINER;
test('studio fixture SQL grows, shrinks and preserves unrelated records in PostgreSQL', { skip: !container }, () => {
  assert.match(container, /^onlineshop-lab-fixture-check-[a-zA-Z0-9-]+$/);
  const run = (database, sql, variables = {}) => {
    const args = ['exec', '-i', container, 'psql', '-X', '-q', '-A', '-t', '-U', 'postgres', '-d', database, '-v', 'ON_ERROR_STOP=1'];
    for (const [key, value] of Object.entries(variables)) args.push('-v', `${key}=${value}`);
    args.push('-f', '-');
    return spawnSync('docker', args, { input: sql, encoding: 'utf8', maxBuffer: 2 * 1024 * 1024, windowsHide: true });
  };
  const ok = (database, sql, vars) => {
    const result = run(database, sql, vars);
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    return result.stdout.trim();
  };
  const appDb = `fixture_app_${process.pid}`, stockDb = `fixture_stock_${process.pid}`;
  ok('postgres', `CREATE DATABASE ${appDb}; CREATE DATABASE ${stockDb};`);
  const untouched = '11111111-1111-1111-1111-111111111111';
  const admin = '22222222-2222-2222-2222-222222222222';
  const customer = '33333333-3333-3333-3333-333333333333';
  ok(appDb, `
    CREATE SCHEMA users; CREATE SCHEMA products; CREATE SCHEMA orders;
    CREATE TABLE users."Users" ("Id" uuid PRIMARY KEY, "Email" text UNIQUE, "PasswordHash" text, "Role" text, "CreatedAt" timestamptz);
    CREATE TABLE products."Products" ("Id" uuid PRIMARY KEY, "Name" text, "Description" text, "Price" numeric(10,2), "Category" text, "ImageFileName" text, "ImageContentType" text, "CreatedAt" timestamptz);
    CREATE TABLE orders."Orders" ("Id" uuid PRIMARY KEY, "UserId" uuid, "Status" text, "TotalAmount" numeric(12,2), "CreatedAt" timestamptz, "UpdatedAt" timestamptz);
    CREATE TABLE orders."OrderItems" ("Id" uuid PRIMARY KEY, "OrderId" uuid REFERENCES orders."Orders"("Id") ON DELETE CASCADE, "ProductId" uuid, "ProductName" text, "UnitPrice" numeric(10,2), "Quantity" int);
    CREATE TABLE orders."OrderStatusHistory" ("Id" uuid PRIMARY KEY, "OrderId" uuid REFERENCES orders."Orders"("Id") ON DELETE CASCADE, "Status" text, "ChangedAt" timestamptz, "ChangedByUserId" uuid);
    CREATE INDEX ON orders."OrderItems"("OrderId"); CREATE INDEX ON orders."OrderStatusHistory"("OrderId");
    INSERT INTO users."Users" VALUES ('${admin}', 'admin@example.invalid', 'hash', 'Admin', now()), ('${customer}', 'benchmark-customer@example.invalid', 'hash', 'Customer', now());
    INSERT INTO products."Products" VALUES ('${untouched}', 'Existing product', '', 10, 'other', '', '', now());
    INSERT INTO orders."Orders" VALUES ('${untouched}', '${customer}', 'Pending', 10, now(), now());
    INSERT INTO orders."OrderItems" VALUES ('${untouched}', '${untouched}', '${untouched}', 'Existing product', 10, 1);
  `);
  ok(stockDb, `CREATE TABLE stock(product_id uuid PRIMARY KEY, quantity integer CHECK(quantity >= 0), updated_at timestamptz DEFAULT now()); INSERT INTO stock VALUES('${untouched}', 77, now());`);
  const appSql = fs.readFileSync(path.join(__dirname, '../../seed/custom-benchmark-app.sql'), 'utf8');
  const stockSql = fs.readFileSync(path.join(__dirname, '../../seed/custom-benchmark-inventory.sql'), 'utf8');
  const summary = output => JSON.parse(output.split(/\r?\n/).reverse().find(line => line.startsWith('{')));
  function prepare(orders, products, min, max) {
    const app = summary(ok(appDb, appSql, { orders, products, customers: 20, customer_every: 5 }));
    const stock = summary(ok(stockDb, stockSql, { products, stock_min: min, stock_max: max }));
    assert.equal(app.fixture.orders, orders);
    assert.equal(app.fixture.products, products);
    assert.equal(app.counts.orders, orders + 1);
    assert.equal(app.counts.products, products + 1);
    assert.equal(app.counts.customerOrders, Math.floor(orders / 5) + 1);
    assert.equal(stock.fixtureInventory, products);
    assert.equal(stock.inventory, products + 1);
    assert.equal(ok(stockDb, `SELECT quantity FROM stock WHERE product_id='${untouched}';`), '77');
    assert.equal(ok(appDb, `SELECT "Name" FROM products."Products" WHERE "Id"='${untouched}';`), 'Existing product');
    assert.equal(ok(appDb, `SELECT count(*) FROM orders."OrderItems" WHERE "OrderId"='${untouched}';`), '1');
    assert.equal(ok(appDb, `SELECT count(*) FROM orders."Orders" o JOIN benchmark_lab.entities e ON e.kind='order' AND e.id=o."Id" JOIN (SELECT "OrderId", sum("UnitPrice"*"Quantity") AS amount FROM orders."OrderItems" GROUP BY "OrderId") totals ON totals."OrderId"=o."Id" WHERE o."TotalAmount" != totals.amount;`), '0');
    return app;
  }
  prepare(100, 12, 10, 20);
  prepare(150000, 50000, 5, 300);
  prepare(25, 3, 100, 100);
  prepare(25, 3, 100, 100);
  prepare(0, 0, 0, 0);
  // A generated-ID collision without the ownership marker must abort, preserving the row.
  ok(appDb, `INSERT INTO products."Products" VALUES(md5('studio-product-v1-1')::uuid, 'Do not replace', '', 1, '', '', '', now());`);
  const collision = run(appDb, appSql, { orders: 0, products: 1, customers: 1, customer_every: 1 });
  assert.notEqual(collision.status, 0);
  assert.equal(ok(appDb, `SELECT "Name" FROM products."Products" WHERE "Id"=md5('studio-product-v1-1')::uuid;`), 'Do not replace');
});

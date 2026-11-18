// Requirement 3 proof: the admin order list comes from the replica, and a customer still sees
// their new order at once (read-your-own-writes), even when the replica is behind.
//
//   1. Pause the replica:   docker compose exec app-db-replica psql -U admin -d db_online_shop -c "SELECT pg_wal_replay_pause();"
//   2. Run:                 $env:CUSTOMER_PASSWORD = '...'; node api-tests/r3/proof-replica.mjs
//   3. Resume the replica:  docker compose exec app-db-replica psql -U admin -d db_online_shop -c "SELECT pg_wal_replay_resume();"
import { readFileSync } from 'node:fs';

const env = Object.fromEntries(readFileSync(new URL('../../.env', import.meta.url), 'utf8')
  .split(/\r?\n/).map((l) => l.match(/^(\w+)=(.*)$/)).filter(Boolean).map((m) => [m[1], m[2]]));
const API = 'http://localhost:8080/api/v1';
const customerEmail = process.env.CUSTOMER_EMAIL ?? 'customer@test.local';
const customerPassword = process.env.CUSTOMER_PASSWORD;
if (!customerPassword) throw new Error('Set CUSTOMER_PASSWORD first.');

async function login(email, password) {
  const res = await fetch(`${API}/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }),
  });
  if (!res.ok) throw new Error(`Login of ${email} failed (${res.status}).`);
  return (await res.json()).accessToken;
}
const get = async (path, token) => (await fetch(API + path, { headers: { Authorization: `Bearer ${token}` } })).json();

const admin = await login(env.ADMIN_EMAIL, env.ADMIN_PASSWORD);
const customer = await login(customerEmail, customerPassword);

const adminBefore = (await get('/orders?pageSize=1', admin)).totalCount;
const product = (await (await fetch(`${API}/products?page=1&pageSize=1`)).json()).items[0];

// The customer places an order (written to the PRIMARY).
const res = await fetch(`${API}/orders`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${customer}` },
  body: JSON.stringify({ items: [{ productId: product.id, quantity: 1 }] }),
});
if (res.status !== 201) throw new Error(`Placing the order failed (${res.status}): ${await res.text()}`);
const order = await res.json();
console.log(`1. customer placed order ${order.id.slice(0, 8)}`);

// Immediately, no waiting.
const mine = await get('/orders?page=1&pageSize=10', customer);
const customerSees = mine.items.some((o) => o.id === order.id);
console.log(`2. customer's own list (primary):  sees the new order? ${customerSees}`);

const adminAfter = (await get('/orders?pageSize=1', admin)).totalCount;
console.log(`3. admin's list (replica):        total ${adminBefore} -> ${adminAfter}`);

if (!customerSees) {
  console.log('\nPROOF FAILED: the customer must always see their own new order.');
  process.exit(1);
}
console.log(adminAfter === adminBefore
  ? '\nPROOF OK: the replica is behind (paused), the admin list does not have the order yet, but the customer sees it.'
  : '\nThe admin list already has the order: the replica caught up (did you pause it?). The customer saw it either way.');

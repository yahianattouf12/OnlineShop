// Requirement 2 proof: many orders at the SAME moment for the LAST unit of a product.
// Expected: exactly ONE order succeeds (201), all the others are refused (409), and the stock ends at 0.
//
// Run (with "docker compose up" running):   node api-tests/race-last-unit.mjs
// Options:                                  node api-tests/race-last-unit.mjs <number of orders, default 20>
// The admin login (ADMIN_EMAIL, ADMIN_PASSWORD) is read from api-tests/.env, or else from the root .env.
// Each run logs in twice, and login is limited to 5 per minute: on 429, wait a minute and run it again.

import { readFileSync } from 'node:fs';

const BASE = process.env.BASE_URL ?? 'http://localhost:8080';
const API = `${BASE}/api/v1`;
const ORDERS = Number(process.argv[2] ?? 20);

function readDotEnv(path) {
  try {
    return Object.fromEntries(
      readFileSync(path, 'utf8')
        .split(/\r?\n/)
        .filter((line) => /^\s*[A-Z_]+\s*=/.test(line))
        .map((line) => {
          const i = line.indexOf('=');
          return [line.slice(0, i).trim(), line.slice(i + 1).trim()];
        }));
  } catch {
    return {};
  }
}

const env = {
  ...readDotEnv(new URL('../.env', import.meta.url)),
  ...readDotEnv(new URL('./.env', import.meta.url)),
  ...process.env,
};

async function call(method, path, { token, body } = {}) {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

async function login(email, password) {
  const { status, body } = await call('POST', '/auth/login', { body: { email, password } });
  if (status !== 200) throw new Error(`Login of ${email} failed: ${status} ${JSON.stringify(body)}`);
  return body.accessToken;
}

// 1. The admin picks a product and sets its stock to 1.
const admin = await login(env.ADMIN_EMAIL, env.ADMIN_PASSWORD);

const list = await call('GET', '/products?pageSize=1');
const product = list.body?.items?.[0];
if (!product) throw new Error('There are no products. Add one first (POST /api/v1/products).');

const set = await call('PUT', `/products/${product.id}/stock`, { token: admin, body: { quantity: 1 } });
if (set.status !== 200) throw new Error(`Setting the stock failed: ${set.status} ${JSON.stringify(set.body)}`);
console.log(`Product "${product.name}": stock set to ${set.body.stock}`);

// 2. A customer.
const email = `race.${Date.now()}@shop.test`;
await call('POST', '/auth/register', { body: { email, password: 'Passw0rd!' } });
const customer = await login(email, 'Passw0rd!');

// 3. All the orders leave together: Promise.all starts them all before waiting for any answer.
console.log(`Sending ${ORDERS} orders at the same moment for the last unit...`);
const results = await Promise.all(
  Array.from({ length: ORDERS }, () =>
    call('POST', '/orders', { token: customer, body: { items: [{ productId: product.id, quantity: 1 }] } })));

const count = (status) => results.filter((r) => r.status === status).length;
const others = results.filter((r) => r.status !== 201 && r.status !== 409);
console.log(`  201 Created  : ${count(201)}`);
console.log(`  409 Conflict : ${count(409)}`);
if (others.length) console.log('  other        :', others.map((r) => r.status).join(', '));
const refused = results.find((r) => r.status === 409);
if (refused) console.log(`  a refusal says: "${refused.body.detail}"`);

// 4. What is left?
const after = await call('GET', `/products/${product.id}`);
console.log(`Stock now: ${after.body.stock}`);

const ok = count(201) === 1 && count(409) === ORDERS - 1 && after.body.stock === 0;
console.log(ok ? 'PASS: exactly one order got the last unit.' : 'FAIL');
process.exit(ok ? 0 : 1);

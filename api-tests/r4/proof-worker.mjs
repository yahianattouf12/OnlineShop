// Requirement 4, proof 1: stop the email worker, place orders, start it again -> no email is lost.
//
//   node api-tests/r4/proof-worker.mjs        (from the project folder, with the whole Docker stack running)
//
// It stops and starts the email-worker container itself, reads the queue from the RabbitMQ management API,
// and reads the worker's log to see which emails were sent. Then look in your mail inbox (Mailtrap).
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const env = Object.fromEntries(readFileSync(new URL('../../.env', import.meta.url), 'utf8')
  .split(/\r?\n/).map((l) => l.match(/^(\w+)=(.*)$/)).filter(Boolean).map((m) => [m[1], m[2]]));
const API = 'http://localhost:8080/api/v1';
const QUEUE_URL = 'http://localhost:15672/api/queues/%2F/email.order-created';
const rabbitAuth = 'Basic ' + Buffer.from(`${env.RABBITMQ_USER}:${env.RABBITMQ_PASSWORD}`).toString('base64');
const ORDERS = 3;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const compose = (args) => execSync(`docker compose ${args}`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

async function call(method, path, token, body) {
  const res = await fetch(API + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${text}`);
  return text ? JSON.parse(text) : undefined;
}
const login = async (email, password) => (await call('POST', '/auth/login', null, { email, password })).accessToken;

/** messages_ready = waiting for a worker; messages_unacknowledged = a worker has it but has not acked yet. */
async function queue() {
  const res = await fetch(QUEUE_URL, { headers: { Authorization: rabbitAuth } });
  if (!res.ok) throw new Error(`RabbitMQ management API -> ${res.status} (is RabbitMQ up? port 15672?)`);
  const q = await res.json();
  return { ready: q.messages_ready ?? 0, unacked: q.messages_unacknowledged ?? 0 };
}

async function waitUntil(check, what, seconds = 60) {
  for (let i = 0; i < seconds; i++) {
    if (await check()) return;
    await sleep(1000);
  }
  throw new Error(`Timed out waiting for: ${what}`);
}

// A new customer for every run, so the result is not mixed with old orders.
const email = `worker-proof-${Date.now()}@test.local`;
const password = 'Proof-Pass-123!';
await call('POST', '/auth/register', null, { email, password });
const customer = await login(email, password);
const admin = await login(env.ADMIN_EMAIL, env.ADMIN_PASSWORD);

const product = (await call('GET', '/products?page=1&pageSize=1')).items[0];
await call('PUT', `/products/${product.id}/stock`, admin, { quantity: 1000 });

console.log('1. docker compose stop email-worker');
compose('stop email-worker');

const orderIds = [];
for (let i = 0; i < ORDERS; i++) {
  const started = performance.now();
  const order = await call('POST', '/orders', customer, { items: [{ productId: product.id, quantity: 1 }] });
  orderIds.push(order.id);
  console.log(`2. order ${order.id.slice(0, 8)} placed, answer in ${Math.round(performance.now() - started)} ms (nobody waits for the email)`);
}

// The management API refreshes its numbers every few seconds, so wait for them.
await waitUntil(async () => (await queue()).ready >= ORDERS, `${ORDERS} messages ready in the queue`);
console.log(`3. worker stopped: ${(await queue()).ready} messages are waiting in email.order-created (not lost)`);

console.log('4. docker compose start email-worker');
const since = new Date().toISOString();
compose('start email-worker');

await waitUntil(async () => {
  const q = await queue();
  return q.ready === 0 && q.unacked === 0;
}, 'the queue to be empty');
await sleep(1000);
console.log('5. the queue is empty again: the worker took and acked every message');

const log = compose(`logs email-worker --since ${since}`);
const sent = orderIds.filter((id) => log.includes(`order ${id} sent`));
for (const id of orderIds) console.log(`   order ${id.slice(0, 8)}: ${sent.includes(id) ? 'email sent' : 'NOT FOUND in the worker log'}`);

if (sent.length !== ORDERS) {
  console.log('\nPROOF FAILED');
  process.exit(1);
}
console.log(`\nPROOF OK: the worker was stopped, ${ORDERS} orders were placed, and after the restart all ${ORDERS} emails were sent.`);
console.log(`Check the inbox (Mailtrap): ${ORDERS} emails to ${email}.`);

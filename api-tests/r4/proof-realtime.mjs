// Requirement 4, proofs 2 and 3 + the channel permissions:
//   * a new order appears at once on the admin channel,
//   * the admin's approval appears at once on the customer's order channel,
//   * nobody else can join those channels.
//
//   node api-tests/r4/proof-realtime.mjs      (from the project folder, with the whole Docker stack running)
//
// It talks to Soketi exactly like the website does (through nginx on port 3000), using the Pusher protocol
// directly over Node's built-in WebSocket (Node 22+), so you can see every step.
import { readFileSync } from 'node:fs';

const env = Object.fromEntries(readFileSync(new URL('../../.env', import.meta.url), 'utf8')
  .split(/\r?\n/).map((l) => l.match(/^(\w+)=(.*)$/)).filter(Boolean).map((m) => [m[1], m[2]]));
const API = 'http://localhost:8080/api/v1';
const WS = 'ws://localhost:3000/app';

async function call(method, path, token, body) {
  const res = await fetch(API + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined };
}
async function ok(method, path, token, body) {
  const res = await call(method, path, token, body);
  if (res.status >= 300) throw new Error(`${method} ${path} -> ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
}
const login = async (email, password) => (await ok('POST', '/auth/login', null, { email, password })).accessToken;
async function newCustomer(name) {
  const email = `${name}-${Date.now()}@test.local`;
  await ok('POST', '/auth/register', null, { email, password: 'Proof-Pass-123!' });
  return login(email, 'Proof-Pass-123!');
}

/** One WebSocket to Soketi, like one browser tab. */
async function connect(key, who) {
  const ws = new WebSocket(`${WS}/${key}?protocol=7&client=proof&version=1.0`);
  const listeners = new Set();
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    for (const listener of listeners) listener(msg);
  };
  const next = (match, ms = 5000) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => { listeners.delete(listener); reject(new Error(`${who}: timed out`)); }, ms);
    const listener = (msg) => {
      if (!match(msg)) return;
      clearTimeout(timer); listeners.delete(listener); resolve(msg);
    };
    listeners.add(listener);
  });
  // Soketi's first message gives this connection its socket_id.
  const established = await next((m) => m.event === 'pusher:connection_established');
  const socketId = JSON.parse(established.data).socket_id;
  return { ws, next, socketId, who };
}

/** Like pusher-js: ask OUR API for a signature (with the JWT), then send it to Soketi with the subscribe. */
async function subscribe(conn, channel, token) {
  const auth = await call('POST', '/realtime/auth', token, { socketId: conn.socketId, channelName: channel });
  if (auth.status !== 200) return `refused by the API (${auth.status})`;
  conn.ws.send(JSON.stringify({ event: 'pusher:subscribe', data: { channel, auth: auth.body.auth } }));
  const reply = await conn.next((m) => m.channel === channel || m.event === 'pusher:error');
  return reply.event === 'pusher_internal:subscription_succeeded' ? 'joined' : `refused by Soketi (${reply.event})`;
}

const { key } = await ok('GET', '/realtime/config');
const admin = await login(env.ADMIN_EMAIL, env.ADMIN_PASSWORD);
const customer = await newCustomer('realtime-customer');
const other = await newCustomer('realtime-other');

const product = (await ok('GET', '/products?page=1&pageSize=1')).items[0];
await ok('PUT', `/products/${product.id}/stock`, admin, { quantity: 1000 });

const adminTab = await connect(key, 'admin');
const customerTab = await connect(key, 'customer');
const otherTab = await connect(key, 'other customer');

console.log('Permissions:');
const adminJoin = await subscribe(adminTab, 'private-admin-orders', admin);
console.log(`  admin    -> private-admin-orders: ${adminJoin}`);
const customerOnAdmin = await subscribe(customerTab, 'private-admin-orders', customer);
console.log(`  customer -> private-admin-orders: ${customerOnAdmin}`);
// Skipping our API and sending a made-up signature straight to Soketi does not work either.
customerTab.ws.send(JSON.stringify({ event: 'pusher:subscribe', data: { channel: 'private-admin-orders', auth: `${key}:forged` } }));
const forged = await customerTab.next((m) => m.channel === 'private-admin-orders' || m.event === 'pusher:error');
console.log(`  customer -> private-admin-orders with a forged signature: refused by Soketi (${forged.event})`);

console.log('\nProof 2: a new order appears on the admin dashboard at once');
const adminHearsOrder = adminTab.next((m) => m.event === 'order.created');
const placedAt = performance.now();
const order = await ok('POST', '/orders', customer, { items: [{ productId: product.id, quantity: 1 }] });
const created = await adminHearsOrder;
const createdData = JSON.parse(created.data);
console.log(`  customer placed order ${order.id.slice(0, 8)} -> admin got "order.created" for ${createdData.order.id.slice(0, 8)} (${createdData.customerEmail}) after ${Math.round(performance.now() - placedAt)} ms`);

const orderChannel = `private-order-${order.id}`;
const customerJoin = await subscribe(customerTab, orderChannel, customer);
console.log(`  customer -> ${orderChannel.slice(0, 22)}... (own order): ${customerJoin}`);
const otherJoin = await subscribe(otherTab, orderChannel, other);
console.log(`  other    -> ${orderChannel.slice(0, 22)}... (NOT theirs): ${otherJoin}`);

console.log('\nProof 3: the admin\'s approval appears on the customer\'s order page at once');
const customerHearsStatus = customerTab.next((m) => m.event === 'order.status-changed');
const approvedAt = performance.now();
await ok('PATCH', `/orders/${order.id}/status`, admin, { status: 'Confirmed' });
const changed = JSON.parse((await customerHearsStatus).data);
console.log(`  admin confirmed the order -> customer got "order.status-changed": ${changed.status} after ${Math.round(performance.now() - approvedAt)} ms`);

for (const tab of [adminTab, customerTab, otherTab]) tab.ws.close();

const pass = adminJoin === 'joined' && customerOnAdmin.startsWith('refused') && customerJoin === 'joined'
  && otherJoin.startsWith('refused') && createdData.order.id === order.id && changed.status === 'Confirmed';
console.log(pass
  ? '\nPROOF OK: both live updates arrived without any page reload, and only the right people could listen.'
  : '\nPROOF FAILED');
process.exit(pass ? 0 : 1);

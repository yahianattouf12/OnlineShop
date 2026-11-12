import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const project = 'onlineshop-bench';
const projectDir = fileURLToPath(new URL('../../', import.meta.url));
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const maxStock = 1_000_000;

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

function token(name) {
  const value = process.env[name]?.trim();
  expect(value && /^[\w-]+(?:\.[\w-]+){2}$/.test(value), `Set ${name} to the accessToken value without Bearer.`);
  return value;
}

function benchmarkApi() {
  const result = spawnSync('docker', ['compose', '-p', project, 'port', 'app', '8080'], {
    cwd: projectDir,
    encoding: 'utf8',
    timeout: 10_000,
  });
  const binding = result.stdout?.match(/^(?:0\.0\.0\.0|127\.0\.0\.1):(\d+)\s*$/m);
  expect(result.status === 0 && binding,
    `No local port found for ${project}. Start the benchmark app with Docker Compose first.`);
  return `http://127.0.0.1:${binding[1]}/api/v1`;
}

function request(url, options = {}) {
  return fetch(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(10_000) });
}

function status(response, expected, step) {
  expect(response.status === expected, `${step} returned HTTP ${response.status}; expected ${expected}.`);
}

async function readAfterWrite(api, productId, accessToken) {
  const headers = { Authorization: `Bearer ${accessToken}` };
  const response = await request(`${api}/orders`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ items: [{ productId, quantity: 1 }] }),
  });
  status(response, 201, 'Create order (use a stocked test product and a customer token)');
  const { id } = await response.json();
  expect(uuid.test(id), 'The create response did not include an order ID.');

  const reads = Promise.all([
    request(`${api}/orders/${id}`, { headers }),
    request(`${api}/orders?page=1&pageSize=10`, { headers }),
  ]);
  console.log(`201 Created order ${id} (one stock unit consumed).`);
  const [detail, page] = await reads;
  status(detail, 200, 'Immediate order detail');
  status(page, 200, 'Immediate customer order list');
  const [order, list] = await Promise.all([detail.json(), page.json()]);
  expect(order.id === id && order.items?.some(item => item.productId === productId && item.quantity === 1),
    'The order detail did not contain the new order and its item.');
  expect(list.items?.some(item => item.id === id), 'The new order was missing from the first page.');
  console.log('PASS Both immediate customer reads returned the new order.');
}

async function etagStock(api, productId, accessToken) {
  const url = `${api}/products/${productId}`;

  async function readUnchanged(tag) {
    const response = await request(url, { headers: { 'If-None-Match': tag } });
    status(response, 304, 'Conditional GET for the current tag');
    expect(response.headers.get('etag') === tag, 'The 304 response did not repeat the current ETag.');
    expect(await response.text() === '', 'The 304 response contained a body.');
  }

  async function setStock(quantity, step) {
    const response = await request(`${url}/stock`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ quantity }),
    });
    status(response, 200, step);
    expect((await response.json()).stock === quantity, `${step} returned the wrong quantity.`);
  }

  const original = await request(url);
  status(original, 200, 'Initial product detail');
  const tag = original.headers.get('etag');
  expect(tag, 'Product detail has no ETag yet.');
  const { stock } = await original.json();
  expect(Number.isInteger(stock) && stock >= 0 && stock <= maxStock,
    'Initial stock is unavailable or outside the supported test range.');
  await readUnchanged(tag);
  console.log(`Initial GET returned stock ${stock}. The current tag returned 304 with an empty body.`);

  const changedStock = stock === maxStock ? stock - 1 : stock + 1;
  try {
    await setStock(changedStock, 'Update stock');
    const changed = await request(url, { headers: { 'If-None-Match': tag } });
    status(changed, 200, 'Immediate product detail with the old tag');
    const newTag = changed.headers.get('etag');
    expect(newTag && newTag.replace(/^W\//, '') !== tag.replace(/^W\//, ''), 'The stock change did not produce a new ETag.');
    expect((await changed.json()).stock === changedStock, 'The immediate product read returned stale stock.');
    await readUnchanged(newTag);
  } finally {
    await setStock(stock, 'Restore original stock');
  }
  console.log(`PASS Old tag returned 200 with stock ${changedStock} and a new ETag. New tag returned an empty 304. Restored stock to ${stock}.`);
}

async function main() {
  const mode = process.argv[2];
  expect(mode === 'read-after-write' || mode === 'etag-stock',
    'Usage: node api-tests/task3/verify.mjs read-after-write|etag-stock');
  const productId = process.env.PRODUCT_ID?.trim().toLowerCase();
  expect(uuid.test(productId), 'Set PRODUCT_ID to a product ID in the benchmark shop.');
  const accessToken = token(mode === 'read-after-write' ? 'CUSTOMER_TOKEN' : 'ORDERS_TOKEN');
  // The benchmark service (benchmark/) runs inside Docker and passes the API address; the CLI looks up the published port.
  const api = process.env.TASK3_API_URL?.trim() || benchmarkApi();
  if (mode === 'read-after-write') await readAfterWrite(api, productId, accessToken);
  else await etagStock(api, productId, accessToken);
}

main().catch(error => {
  console.error(`FAIL ${error.message}`);
  process.exitCode = 1;
});

// Adds the demo catalog (products.json + images/) through the API, as the admin.
// Products that already exist (same name) are skipped, so it is safe to run more than once.
//
//   With Docker (no Node needed):  docker compose --profile seed run --rm seed
//   With Node 18+:                 node seed/seed.mjs      (reads the admin login from the root .env)

import { readFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

// Outside Docker, take the admin login from the root .env.
const rootEnv = join(here, '..', '.env');
if (existsSync(rootEnv)) {
  for (const line of readFileSync(rootEnv, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^(\w+)=(.*)$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
}

const API = (process.env.API_URL ?? 'http://localhost:8080') + '/api/v1';
const { ADMIN_EMAIL, ADMIN_PASSWORD, BENCHMARK_STOCK } = process.env;
if (!ADMIN_EMAIL || !ADMIN_PASSWORD) {
  console.error('ADMIN_EMAIL and ADMIN_PASSWORD are required (from .env).');
  process.exit(1);
}
if (BENCHMARK_STOCK !== undefined && (!/^\d+$/.test(BENCHMARK_STOCK) || Number(BENCHMARK_STOCK) > 1_000_000)) {
  throw new Error('BENCHMARK_STOCK must be an integer from 0 to 1000000.');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function login() {
  // The API may still be starting (e.g. right after docker compose up): retry for up to a minute.
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(`${API}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
      });
      if (res.ok) return (await res.json()).accessToken;
      if (res.status === 429) throw new Error('Too many login attempts (429). Wait a minute and run it again.');
      throw new Error(`Admin login failed (${res.status}). Check ADMIN_EMAIL / ADMIN_PASSWORD in .env.`);
    } catch (err) {
      if (err instanceof Error && /\((401|429)\)/.test(err.message)) throw err;
      if (attempt >= 30) throw new Error(`Cannot reach the API at ${API}: ${err.message}`);
      await sleep(2000);
    }
  }
}

async function existingProducts() {
  const productsByName = new Map();
  for (let page = 1; ; page++) {
    const res = await fetch(`${API}/products?page=${page}&pageSize=50`);
    if (!res.ok) throw new Error(`Listing existing products failed (${res.status}).`);
    const data = await res.json();
    for (const product of data.items) {
      const name = product.name.toLowerCase();
      if (!productsByName.has(name)) productsByName.set(name, product.id);
    }
    if (page >= data.totalPages) return productsByName;
  }
}

const products = JSON.parse(await readFile(join(here, 'products.json'), 'utf8'));
const token = await login();
const existing = await existingProducts();
const benchmarkProduct = products[0];
const benchmarkProductName = benchmarkProduct.name.toLowerCase();
let benchmarkProductId = existing.get(benchmarkProductName);
let added = 0;

// The shop lists newest first, so add them in reverse to show them in the order of products.json.
for (const product of [...products].reverse()) {
  const name = product.name.toLowerCase();
  if (existing.has(name)) {
    console.log(`skip   ${product.name} (already in the shop)`);
    continue;
  }
  const form = new FormData();
  form.set('name', product.name);
  form.set('category', product.category);
  form.set('price', String(product.price));
  form.set('description', product.description);
  form.set('image', new Blob([await readFile(join(here, 'images', product.image))], { type: 'image/png' }), product.image);

  const res = await fetch(`${API}/products`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form });
  if (!res.ok) {
    console.error(`FAILED ${product.name}: ${res.status} ${await res.text()}`);
    process.exit(1);
  }
  if (BENCHMARK_STOCK !== undefined && name === benchmarkProductName) {
    benchmarkProductId = (await res.json()).id;
  }
  added++;
  console.log(`added  ${product.name}`);
}

if (BENCHMARK_STOCK !== undefined) {
  if (!benchmarkProductId) throw new Error(`Could not find the product ID for ${benchmarkProduct.name}.`);
  const res = await fetch(`${API}/products/${benchmarkProductId}/stock`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ quantity: Number(BENCHMARK_STOCK) }),
  });
  if (!res.ok) throw new Error(`Setting stock for ${benchmarkProduct.name} failed (${res.status}): ${await res.text()}`);
  console.log(`Set stock for ${benchmarkProduct.name} to ${BENCHMARK_STOCK}.`);
  console.log(`PRODUCT_ID=${benchmarkProductId}`);
}

console.log(`\nDone: ${added} added, ${products.length - added} already there.`);

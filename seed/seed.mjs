// Adds the demo catalog (products.json + images/) through the API, as the admin, and sets each product's stock
// (the API forwards it to the inventory service). Products that already exist (same name) are not added again,
// so it is safe to run more than once; an existing product with 0 in stock is restocked.
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
const { ADMIN_EMAIL, ADMIN_PASSWORD } = process.env;
if (!ADMIN_EMAIL || !ADMIN_PASSWORD) {
  console.error('ADMIN_EMAIL and ADMIN_PASSWORD are required (from .env).');
  process.exit(1);
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

/** Name (lower case) → id of every product already in the shop. */
async function existingProducts() {
  const ids = new Map();
  for (let page = 1; ; page++) {
    const res = await fetch(`${API}/products?page=${page}&pageSize=50`);
    const data = await res.json();
    data.items.forEach((p) => ids.set(p.name.toLowerCase(), p.id));
    if (page >= data.totalPages) return ids;
  }
}

/** Returns false (and says why) when the inventory service could not take it, e.g. it is not running. */
async function setStock(id, name, quantity) {
  const res = await fetch(`${API}/products/${id}/stock`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ quantity }),
  });
  if (res.ok) return true;
  console.error(`       stock of ${name} not set: ${res.status} ${await res.text()}`);
  return false;
}

async function currentStock(id) {
  const res = await fetch(`${API}/products/${id}`);
  return res.ok ? (await res.json()).stock : null;
}

const products = JSON.parse(await readFile(join(here, 'products.json'), 'utf8'));
const token = await login();
const existing = await existingProducts();
let added = 0;
let stockFailures = 0;

// The shop lists newest first, so add them in reverse to show them in the order of products.json.
for (const product of [...products].reverse()) {
  const existingId = existing.get(product.name.toLowerCase());
  if (existingId) {
    // Never overwrite a stock the admin set; only fill a product that has none (e.g. seeded before Requirement 2).
    if ((await currentStock(existingId)) === 0) {
      if (await setStock(existingId, product.name, product.stock)) console.log(`stock  ${product.name}: 0 → ${product.stock}`);
      else stockFailures++;
    } else {
      console.log(`skip   ${product.name} (already in the shop)`);
    }
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
  added++;
  const { id } = await res.json();
  if (await setStock(id, product.name, product.stock)) console.log(`added  ${product.name} (${product.stock} in stock)`);
  else {
    stockFailures++;
    console.log(`added  ${product.name} (stock not set)`);
  }
}

console.log(`\nDone: ${added} added, ${products.length - added} already there.`);
if (stockFailures > 0) {
  console.error(`${stockFailures} stock value(s) could not be set. Is the inventory service running? Run the seed again once it is.`);
  process.exit(1);
}

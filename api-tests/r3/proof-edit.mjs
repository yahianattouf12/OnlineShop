// Requirement 3 proof: an edited product shows at once, although the product is cached in Redis
// and the client holds an ETag.   Run:  node api-tests/r3/proof-edit.mjs
// Reads ADMIN_EMAIL / ADMIN_PASSWORD from the root .env.
import { readFileSync } from 'node:fs';

const env = Object.fromEntries(readFileSync(new URL('../../.env', import.meta.url), 'utf8')
  .split(/\r?\n/).map((l) => l.match(/^(\w+)=(.*)$/)).filter(Boolean).map((m) => [m[1], m[2]]));
const API = 'http://localhost:8080/api/v1';

const login = await fetch(`${API}/auth/login`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: env.ADMIN_EMAIL, password: env.ADMIN_PASSWORD }),
});
const { accessToken } = await login.json();

const product = (await (await fetch(`${API}/products?page=1&pageSize=1`)).json()).items[0];
const url = `${API}/products/${product.id}`;

// 1. Read it twice: now it is in Redis, and we keep its ETag like a browser would.
await fetch(url);
const first = await fetch(url);
const etag = first.headers.get('etag');
console.log(`1. before: price ${(await first.json()).price}, ETag ${etag.slice(0, 14)}...`);

const again = await fetch(url, { headers: { 'If-None-Match': etag } });
console.log(`2. same ETag again -> ${again.status} (nothing changed, no body)`);

// 2. The admin changes the price.
const newPrice = Math.round((product.price + 1) * 100) / 100;
const put = await fetch(url, {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
  body: JSON.stringify({ name: product.name, description: product.description, price: newPrice, category: product.category }),
});
console.log(`3. admin PUT new price ${newPrice} -> ${put.status}`);

// 3. Immediately, with no waiting: the old ETag no longer matches, and the new price comes back.
const after = await fetch(url, { headers: { 'If-None-Match': etag } });
const body = await after.json();
console.log(`4. old ETag right after the edit -> ${after.status}, price ${body.price}`);
const list = await (await fetch(`${API}/products?page=1&pageSize=1`)).json();
console.log(`5. product list right after the edit -> price ${list.items[0].price}`);

const ok = after.status === 200 && body.price === newPrice && list.items[0].price === newPrice;
console.log(ok ? '\nPROOF OK: the edit shows at once, in the details and in the list.' : '\nPROOF FAILED');
process.exit(ok ? 0 : 1);

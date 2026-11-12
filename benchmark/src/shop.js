const { API, DATASET } = require('./config');
const { Problem } = require('./problem');

/** One call to the shop API. A network failure becomes a clear 503 instead of a stack trace. */
async function call(path, { method = 'GET', token, body, headers = {} } = {}) {
  let response;
  try {
    response = await fetch(API + path, {
      method,
      headers: {
        Accept: 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...headers,
      },
      body: body ? JSON.stringify(body) : undefined,
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new Problem(503, 'The shop API is not answering.', `Start it, then try again: the benchmark service calls ${API}.`);
  }
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // Not JSON (an empty 304, an nginx error page): the status is what matters.
  }
  return { status: response.status, headers: response.headers, json };
}

/** When a JWT expires, read from its payload. The signature is checked by the shop API, not here. */
function expiresAt(token) {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    return typeof payload.exp === 'number' ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

// Asking the shop API "who is this?" for every poll would be wasteful: remember the answer for 30 seconds.
const verified = new Map();

/**
 * Only the shop's admin may use this service. The token is the one the website already holds;
 * the shop API checks its signature and expiry, and says who it belongs to.
 */
async function authenticate(header) {
  const match = /^Bearer ([\w-]+\.[\w-]+\.[\w-]+)$/.exec(header ?? '');
  if (!match) throw new Problem(401, 'Log in first.', 'Send the admin access token: Authorization: Bearer <token>.');
  const token = match[1];

  const now = Date.now();
  const known = verified.get(token);
  if (known && known.until > now) return known.session;

  const me = await call('/auth/me', { token });
  if (me.status === 401) throw new Problem(401, 'Your session is not valid.', 'It may have expired. Log in again.');
  if (me.status !== 200 || !me.json) throw new Problem(502, 'The shop API gave an unexpected answer.', `GET /auth/me returned ${me.status}.`);
  if (me.json.role !== 'Admin') throw new Problem(403, 'Admins only.', 'Only the admin account can run benchmarks.');

  const session = { token, user: me.json, expiresAt: expiresAt(token) };
  verified.set(token, { session, until: now + 30_000 });
  for (const [key, value] of verified) if (value.until <= now) verified.delete(key);
  return session;
}

// The benchmark customer logs in once; its token is reused until it is close to expiring.
// Login is limited to 5 per minute per IP, and every login from here shares this container's IP.
let customer = null;

async function customerSession(password, { fresh = false } = {}) {
  if (!fresh && customer && customer.expiresAt - Date.now() > 15 * 60_000) return customer;

  const secret = password || process.env.BENCHMARK_CUSTOMER_PASSWORD;
  if (!secret) {
    throw new Problem(400, 'The benchmark customer’s password is needed.',
      `Enter the password the seeder printed for ${DATASET.customerEmail}.`, { field: 'customerPassword' });
  }

  const login = await call('/auth/login', { method: 'POST', body: { email: DATASET.customerEmail, password: secret } });
  if (login.status === 429) {
    throw new Problem(429, 'Too many logins.', 'Login is limited to 5 per minute. Wait a minute and try again.');
  }
  if (login.status === 401 || login.status === 400) {
    throw new Problem(400, 'Wrong password for the benchmark customer.',
      `Use the password the seeder printed for ${DATASET.customerEmail}.`, { field: 'customerPassword' });
  }
  if (login.status !== 200 || !login.json?.accessToken) {
    throw new Problem(502, 'Logging in the benchmark customer failed.', `POST /auth/login returned ${login.status}.`);
  }

  const token = login.json.accessToken;
  const me = await call('/auth/me', { token });
  if (me.status !== 200 || me.json?.role !== 'Customer' || me.json?.email !== DATASET.customerEmail) {
    throw new Problem(502, 'The benchmark customer could not be confirmed.', 'GET /auth/me did not return the seeded customer.');
  }
  customer = { token, id: me.json.id, expiresAt: expiresAt(token) ?? Date.now() + 30 * 60_000 };
  return customer;
}

function knownCustomer() {
  return customer && customer.expiresAt - Date.now() > 60_000 ? customer : null;
}

/** The product the seeder stocked for the benchmark (the first one in seed/products.json). */
async function findBenchmarkProduct() {
  for (let page = 1; page <= 20; page++) {
    const list = await call(`/products?page=${page}&pageSize=50`);
    if (list.status !== 200 || !Array.isArray(list.json?.items)) return null;
    const found = list.json.items.find((p) => p.name?.toLowerCase() === DATASET.productName.toLowerCase());
    if (found) return found.id;
    if (page >= (list.json.totalPages ?? 1)) return null;
  }
  return null;
}

module.exports = { call, authenticate, customerSession, knownCustomer, findBenchmarkProduct, expiresAt };

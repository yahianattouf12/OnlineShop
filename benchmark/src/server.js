const http = require('node:http');
const { spawnSync } = require('node:child_process');
const { APP_URL, CASES, PROFILES, LABEL, PORT, K6_BIN, DATASET } = require('./config');
const shop = require('./shop');
const store = require('./store');
const results = require('./results');
const runner = require('./runner');
const proofs = require('./proofs');
const { preflight } = require('./preflight');
const { Problem } = require('./problem');

const BASE = '/benchmark-api/v1';
const k6Version = (spawnSync(K6_BIN, ['version'], { encoding: 'utf8' }).stdout ?? '').split('\n')[0].trim() || null;

/** The API, described by itself: GET /benchmark-api/v1 lists every route. */
const ENDPOINTS = [
  ['GET', '/health', false, 'Is the service up, which k6 it runs, and the run that is going (if any).'],
  ['GET', '/cases', false, 'The five Task 3 workloads, the run profiles and the fixtures they expect.'],
  ['POST', '/customer-session', true, 'Logs in the seeded benchmark customer: { password }. Its token is kept in memory for the customer workload and proof.'],
  ['GET', '/preflight?productId=', true, 'Checks that the benchmark data matches the workloads (200,000 orders, stock 100…).'],
  ['POST', '/runs', true, 'Starts a run: { label, cases[], profile: standard|quick, etag, productId?, customerPassword? } → 202.'],
  ['GET', '/runs', true, 'The run history, newest first.'],
  ['GET', '/runs/{id}', true, 'One run with its steps, metrics and per-second latency timelines (live while it runs).'],
  ['POST', '/runs/{id}/cancel', true, 'Stops the run that is going. Nothing is saved for the step that was cut short.'],
  ['GET', '/results', true, 'Every saved result in task3-results/, by label and workload.'],
  ['GET', '/compare?baseline=&labels=a,b', true, 'A baseline label against other labels: p50/p95/p99 reductions, with the same rules as report.mjs.'],
  ['GET', '/proofs', true, 'The history of the two correctness proofs.'],
  ['POST', '/proofs/{etag-stock|read-after-write}', true, 'Runs a proof from api-tests/task3/verify.mjs. read-after-write needs { acceptDatasetChange: true }.'],
].map(([method, path, auth, description]) => ({ method, path: BASE + path, auth: auth ? 'Bearer token of the shop admin' : 'none', description }));

function send(res, status, body, headers = {}) {
  res.writeHead(status, {
    'Content-Type': body instanceof Problem ? 'application/problem+json; charset=utf-8' : 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) {
    throw new Problem(415, 'Send JSON.', 'Use Content-Type: application/json.');
  }
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 16 * 1024) throw new Problem(413, 'The request is too large.', 'A request body is at most 16 KB.');
    chunks.push(chunk);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('not an object');
    return body;
  } catch {
    throw new Problem(400, 'The JSON is not valid.', 'Send a JSON object.');
  }
}

const auth = (req) => shop.authenticate(req.headers.authorization);

const routes = [
  ['GET', /^$/, async () => ({ service: 'OnlineShop benchmark (Requirement 3)', endpoints: ENDPOINTS })],
  ['GET', /^\/health$/, async () => ({ status: 'ok', k6: k6Version, appUrl: APP_URL, runningRunId: runner.busy() })],
  ['GET', /^\/cases$/, async () => ({ cases: CASES, profiles: PROFILES, rate: 20, expected: DATASET })],
  ['GET', /^\/preflight$/, async (req, url) => {
    const session = await auth(req);
    return preflight(session, { productId: url.searchParams.get('productId') || undefined });
  }],
  ['POST', /^\/customer-session$/, async (req) => {
    await auth(req);
    const { password } = await readJson(req);
    if (typeof password !== 'string' || !password) {
      throw new Problem(400, 'Some fields need attention.', 'Enter the benchmark customer’s password.', { field: 'password' });
    }
    const customer = await shop.customerSession(password, { fresh: true });
    return { email: DATASET.customerEmail, id: customer.id, expiresAt: new Date(customer.expiresAt).toISOString() };
  }],
  ['POST', /^\/runs$/, async (req, url, res) => {
    const session = await auth(req);
    const run = await runner.start(session, await readJson(req));
    send(res, 202, run, { Location: `${BASE}/runs/${run.id}` });
  }],
  ['GET', /^\/runs$/, async (req) => {
    await auth(req);
    return { runs: store.runs(), runningRunId: runner.busy() };
  }],
  ['GET', /^\/runs\/([0-9a-f-]{36})$/, async (req, url, res, [id]) => {
    await auth(req);
    return runner.details(id);
  }],
  ['POST', /^\/runs\/([0-9a-f-]{36})\/cancel$/, async (req, url, res, [id]) => {
    await auth(req);
    send(res, 202, runner.cancel(id));
  }],
  ['GET', /^\/results$/, async (req) => {
    await auth(req);
    return { labels: results.listResults() };
  }],
  ['GET', /^\/compare$/, async (req, url) => {
    await auth(req);
    const baseline = url.searchParams.get('baseline') ?? '';
    if (!LABEL.test(baseline)) throw new Problem(400, 'Some fields need attention.', 'Set baseline to a saved label, for example before.', { field: 'baseline' });
    const given = (url.searchParams.get('labels') ?? '').split(',').map((label) => label.trim()).filter(Boolean);
    if (given.some((label) => !LABEL.test(label))) throw new Problem(400, 'Some fields need attention.', 'labels is a comma-separated list of saved labels.', { field: 'labels' });
    const labels = given.length ? [...new Set(given)].filter((label) => label !== baseline)
      : results.listResults().map((entry) => entry.label).filter((label) => label !== baseline);
    return { baseline, labels, cases: results.compare(baseline, labels) };
  }],
  ['GET', /^\/proofs$/, async (req) => {
    await auth(req);
    return { proofs: store.proofs(), available: proofs.PROOFS };
  }],
  ['POST', /^\/proofs\/(etag-stock|read-after-write)$/, async (req, url, res, [mode]) => {
    const session = await auth(req);
    return proofs.run(session, mode, await readJson(req));
  }],
];

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://benchmark');
  try {
    if (!url.pathname.startsWith(BASE)) throw new Problem(404, 'Not found.', `The benchmark API lives under ${BASE}.`);
    const path = url.pathname.slice(BASE.length).replace(/\/$/, '');
    const matches = routes.filter(([, pattern]) => pattern.test(path));
    if (!matches.length) throw new Problem(404, 'Not found.', `No route ${path}. GET ${BASE} lists them.`);
    const route = matches.find(([method]) => method === req.method);
    if (!route) throw new Problem(405, 'Method not allowed.', `Use ${matches.map(([method]) => method).join(' or ')}.`);
    const [, pattern, handler] = route;
    const body = await handler(req, url, res, pattern.exec(path).slice(1));
    if (!res.headersSent) send(res, 200, body);
  } catch (error) {
    if (res.headersSent) return;
    if (error instanceof Problem) return send(res, error.status, error);
    console.error(`${req.method} ${url.pathname} failed:`, error);
    send(res, 500, new Problem(500, 'Something went wrong in the benchmark service.', 'See its log: docker compose logs benchmark.'));
  }
});

store.load();
server.listen(PORT, () => console.log(`Benchmark service on :${PORT}${BASE} (${k6Version ?? 'k6 not found'}), shop API at ${APP_URL}`));

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    runner.shutdown();
    server.close();
    // Give k6 a moment to stop and the history a moment to be written.
    setTimeout(() => process.exit(0), 1500).unref();
  });
}

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'benchmark-http-test-'));
process.env.RESULTS_DIR = directory;
const { Problem } = require('../src/problem');
const shop = require('../src/shop');
const operations = require('../src/operations');
const lab = require('../src/lab');
const datasets = require('../src/datasets');
const { server } = require('../src/server');
shop.authenticate = async (header) => {
  if (header !== 'Bearer test') throw new Problem(401, 'Log in first.');
  return { token: 'test', user: { email: 'local-test@example.invalid' } };
};
const listening = new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
async function request(route, options = {}) {
  await listening;
  return fetch(`http://127.0.0.1:${server.address().port}/benchmark-api/v1${route}`, options);
}
const headers = { Authorization: 'Bearer test', 'Content-Type': 'application/json' };

after(async () => {
  server.closeAllConnections();
  server.close();
  await once(server, 'close');
  // This directory was freshly created by this test, not a user results folder.
  fs.rmSync(directory, { recursive: true, force: true });
});

test('custom and fixture routes require the shop admin session', async () => {
  for (const route of ['/lab/scenarios', '/lab/runs', '/lab/data', '/lab/compare?before=x&after=y']) {
    const response = await request(route);
    assert.equal(response.status, 401, route);
  }
});

test('large scenario JSON is accepted while ordinary requests retain a smaller cap', async () => {
  const original = lab.saveScenario;
  lab.saveScenario = value => ({ accepted: value.name.length });
  try {
    const response = await request('/lab/scenarios', { method: 'POST', headers, body: JSON.stringify({ name: 'x'.repeat(20_000) }) });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).accepted, 20_000);
    const oversized = await request('/lab/scenarios', { method: 'POST', headers, body: JSON.stringify({ name: 'x'.repeat(530_000) }) });
    assert.equal(oversized.status, 413);
    const fixture = await request('/lab/data', { method: 'POST', headers, body: JSON.stringify({ name: 'x'.repeat(20_000) }) });
    assert.equal(fixture.status, 413);
  } finally { lab.saveScenario = original; }
});

test('custom start returns 202 and a retrievable Location', async () => {
  const original = lab.start;
  const id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  lab.start = async (session, body) => ({ id, label: body.label });
  try {
    const response = await request('/lab/runs', { method: 'POST', headers, body: JSON.stringify({ label: 'test-before' }) });
    assert.equal(response.status, 202);
    assert.equal(response.headers.get('location'), `/benchmark-api/v1/lab/runs/${id}`);
  } finally { lab.start = original; }
});

test('comparison report is plain text and never returned without auth', async () => {
  const original = lab.reportComparison;
  lab.reportComparison = (a, b) => `Comparison ${a} -> ${b}`;
  try {
    const response = await request('/lab/compare?before=one&after=two&format=txt', { headers });
    assert.equal(response.headers.get('content-type'), 'text/plain; charset=utf-8');
    assert.equal(await response.text(), 'Comparison one -> two');
  } finally { lab.reportComparison = original; }
});

test('request pages and fixture preparation are routed to the real service methods', async () => {
  const originalRequests = lab.requests;
  const originalStart = datasets.start;
  lab.requests = (id, page) => ({ id, ...page });
  datasets.start = async (session, body) => ({ job: { orders: body.orders } });
  try {
    const response = await request('/lab/runs/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/requests?page=3&pageSize=25', { headers });
    assert.equal((await response.json()).page, '3');
    const fixture = await request('/lab/data', { method: 'POST', headers, body: JSON.stringify({ orders: 50000 }) });
    assert.equal((await fixture.json()).job.orders, 50000);
  } finally { lab.requests = originalRequests; datasets.start = originalStart; }
});

test('shared operation reservation rejects overlaps and only its owner can release', () => {
  const release = operations.acquire('fixture', 'a');
  assert.throws(() => operations.acquire('benchmark', 'b'), error => error.status === 409);
  release();
  const secondRelease = operations.acquire('benchmark', 'b');
  release();
  assert.deepEqual(operations.busy(), { kind: 'benchmark', id: 'b' });
  secondRelease();
  assert.equal(operations.busy(), null);
});

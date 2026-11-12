const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');

let lab, model, server, temp, base, requests = [];
const session = { token: 'test-admin-token', user: { email: 'test@example.invalid' } };
const executable = process.env.K6_BIN || (process.platform === 'win32' ? 'C:\\Program Files\\k6\\k6.exe' : 'k6');
const hasK6 = require('node:child_process').spawnSync(executable, ['version'], { windowsHide: true }).status === 0;
function scenario(changes = {}) {
  return { name: 'A repeatable request', requests: [{ id: 'echo', name: 'Echo', path: '/api/echo?page=1', method: 'GET', role: 'admin', query: { page: '{{page}}' }, expectedStatuses: [200], assertions: [{ path: 'page', operator: 'eq', value: '{{page}}' }] }],
    data: { rows: [{ note: 'first' }, { note: 'second' }], ranges: [{ name: 'page', min: 3, max: 5, step: 1 }] },
    load: { mode: 'iterations', iterations: 6, duration: 20, concurrency: 2, warmup: 0, rate: 3, repeat: 1, pauseMs: 0 },
    thresholds: { p95: 10000, errorRate: 0, checks: 1 }, ...changes };
}
async function finished(run) {
  const deadline = Date.now() + 45000;
  while (lab.busy() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(lab.busy(), null, 'the child process must finish');
  return lab.details(run.id);
}
before(async () => {
  temp = fs.mkdtempSync(path.join(os.tmpdir(), 'shop-lab-test-'));
  server = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    const url = new URL(req.url, 'http://localhost');
    requests.push({ method: req.method, path: url.pathname, pages: url.searchParams.getAll('page'), body: Buffer.concat(chunks).toString(), auth: req.headers.authorization });
    if (url.pathname === '/api/redirect') { res.writeHead(302, { Location: '/outside' }); res.end(); return; }
    if (url.pathname === '/api/fail') { res.writeHead(503); res.end('unavailable'); return; }
    res.writeHead(req.method === 'POST' ? 201 : 200, { 'Content-Type': 'application/json', 'X-Fixture': 'real-response', 'Set-Cookie': 'session=private' });
    res.end(JSON.stringify({ page: url.searchParams.get('page'), method: req.method, password: 'private-response-value' }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
  process.env.APP_URL = base; process.env.RESULTS_DIR = temp; process.env.K6_BIN = executable;
  lab = require('../src/lab'); model = require('../src/lab-model');
  lab.setHooks({ dataset: () => ({ fingerprint: 'fixture-v1', config: { orders: 100 }, counts: { orders: 100 } }), sample: async () => null });
});
after(async () => {
  lab?.shutdown();
  if (lab?.busy()) await finished({ id: lab.busy() });
  await new Promise(resolve => server.close(resolve));
  // The test creates this exact isolated temporary tree, never the user's results.
  fs.rmSync(temp, { recursive: true, force: true });
});
test('validates methods, targets, body credentials, load and all data rows', () => {
  const config = model.normalize(scenario());
  assert.equal(model.materialize(config, config.requests[0], 2, 1).url, base + '/api/echo?page=5');
  for (const bad of ['https://example.org/api/test', '//example.org/api/test', '/api/../outside', '/api/%2e%2e/outside', '/api/\\evil']) {
    assert.throws(() => model.normalize(scenario({ requests: [{ id: 'x', path: bad }] })), /API path|shop API|path segment/);
  }
  assert.throws(() => model.normalize(scenario({ requests: [{ id: 'x', path: '/api/{{key}}/test' }], data: { rows: [{ key: 'okay' }, { key: '..' }] } })), /path segment/);
  assert.throws(() => model.normalize(scenario({ requests: [{ id: 'x', path: '/api/test', method: 'POST', body: '{"password":"private"}' }] })), /Credential/);
  assert.throws(() => model.normalize(scenario({ thresholds: 42 })), /Thresholds/);
  assert.throws(() => model.normalize(scenario({ load: { concurrency: 0 } })), /concurrency/);
  assert.throws(() => model.normalize(scenario({ requests: [{ id: 'x', path: '/api/test', headers: { Host: 'elsewhere' } }] })), /managed/);
  assert.equal(model.checkResponse({ expectedStatuses: [200], assertions: [{ path: 'missing', operator: 'eq', value: 'undefined' }] }, 200, '{}', {})[1].passed, false);
});
test('saves and updates reusable scenarios without changing saved runs', () => {
  const saved = lab.saveScenario(scenario());
  assert.ok(saved.id); assert.equal(lab.listScenarios().scenarios.length, 1);
  lab.saveScenario({ ...saved, name: 'Renamed' });
  assert.equal(lab.listScenarios().scenarios[0].name, 'Renamed');
  lab.deleteScenario(saved.id); assert.equal(lab.listScenarios().scenarios.length, 0);
});
test('inspector uses actual method/query/status/headers and redacts response credentials', async () => {
  const result = await lab.inspect(session, { scenario: scenario(), requestId: 'echo' });
  assert.equal(result.status, 200); assert.equal(result.headers['x-fixture'], 'real-response');
  assert.equal(result.headers['set-cookie'], '[redacted]'); assert.ok(!result.body.includes('private-response-value'));
  assert.ok(result.checks.every(c => c.passed)); assert.equal(requests.at(-1).auth, 'Bearer test-admin-token');
  assert.deepEqual(requests.at(-1).pages, ['3']);
  await assert.rejects(lab.inspect(session, { scenario: scenario(), requestId: 'missing' }), /Select a request/);
  await assert.rejects(lab.inspect({ ...session, expiresAt: Date.now() + 1000 }, { scenario: scenario() }), /Sign in again/);
  const write = scenario({ requests: [{ id: 'post', path: '/api/echo', method: 'POST', body: '{"quantity":3}', expectedStatuses: [201] }] });
  await assert.rejects(lab.inspect(session, { scenario: write }), /Confirm/);
  const posted = await lab.inspect(session, { scenario: write, acceptWrites: true });
  assert.equal(posted.status, 201); assert.equal(requests.at(-1).body, '{"quantity":3}');
  const redirect = await lab.inspect(session, { scenario: scenario({ requests: [{ id: 'redirect', path: '/api/redirect', expectedStatuses: [302] }] }) });
  assert.equal(redirect.status, 302); assert.equal(requests.some(r => r.path === '/outside'), false);
});
test('real k6 executes exact N iterations with repetitions, statuses and paginated headers', { skip: !hasK6 }, async () => {
  requests = [];
  const custom = scenario({ load: { mode: 'iterations', iterations: 120, duration: 20, concurrency: 4, warmup: 0, rate: 3, repeat: 2, pauseMs: 0 } });
  const started = await lab.start(session, { label: 'before', scenario: custom, sourceNote: 'original code' });
  await assert.rejects(lab.start(session, { label: 'overlap', scenario: custom }), /Wait for/);
  const result = await finished(started);
  assert.equal(result.status, 'passed', result.error || result.logs);
  assert.equal(result.requestCount, 240); assert.equal(result.metrics.requests, 240);
  assert.equal(result.repetitions.length, 2); assert.equal(result.requestMetrics[0].requests, 240);
  assert.ok(requests.every(r => r.pages.length === 1 && ['3', '4', '5'].includes(r.pages[0])));
  const page = await lab.requests(result.id, { page: '3', pageSize: '50' });
  assert.equal(page.total, 240); assert.equal(page.items.length, 50); assert.equal(page.items[0].sequence, 101);
  assert.ok(page.items.every(r => r.status === 200 && r.headers['X-Fixture'] === 'real-response' && r.headers['Set-Cookie'] === '[redacted]'));
  assert.equal(result.metrics.cpu, null); assert.ok(!lab.report(result.id).includes('test-admin-token'));
  await assert.rejects(lab.start(session, { label: 'before', scenario: custom }), /new label/);
  const next = await finished(await lab.start(session, { label: 'after', scenario: { ...custom, name: 'Renamed scenario', metrics: ['p95'] } }));
  assert.equal(next.status, 'passed', next.logs);
  assert.equal(lab.compare(result.id, next.id).comparable, true);
  assert.match(lab.reportComparison(result.id, next.id), /Comparable: yes/);
  const changed = await finished(await lab.start(session, { label: 'different', scenario: scenario() }));
  assert.equal(lab.compare(result.id, changed.id).comparable, false);
});
test('real rate warm-up is paced; failed responses and cancellation retain evidence', { skip: !hasK6 }, async () => {
  requests = [];
  const paced = scenario({ load: { mode: 'rate', rate: 3, duration: 1, warmup: 1, concurrency: 2, repeat: 1, iterations: 2, pauseMs: 0 } });
  const result = await finished(await lab.start(session, { label: 'rate', scenario: paced }));
  assert.equal(result.status, 'passed', result.logs);
  assert.ok(requests.length >= 6 && requests.length <= 8, `${requests.length} total with warmup`);
  assert.ok(result.requestCount >= 3 && result.requestCount <= 4);
  const failure = await finished(await lab.start(session, { label: 'failed', scenario: scenario({ requests: [{ id: 'fail', path: '/api/fail', expectedStatuses: [200] }] }) }));
  assert.equal(failure.status, 'failed'); assert.equal(failure.metrics.errors, 1);
  assert.equal((await lab.requests(failure.id)).items[0].status, 503);
  const running = await lab.start(session, { label: 'cancel', scenario: scenario({ load: { mode: 'duration', duration: 20, warmup: 0, concurrency: 1, repeat: 1, iterations: 2, rate: 2, pauseMs: 50 } }) });
  await new Promise(resolve => setTimeout(resolve, 300));
  lab.cancel(running.id); assert.equal((await finished(running)).status, 'cancelled');
});
test('write comparisons require a re-prepared matching fixture; restart marks active history interrupted', { skip: !hasK6 }, async () => {
  let preparedAt = '2020-01-01T00:00:00.000Z';
  lab.setHooks({ dataset: () => ({ fingerprint: 'fixture-v1', preparedAt, counts: { orders: 100 } }) });
  const writes = scenario({ requests: [{ id: 'write', path: '/api/echo', method: 'POST', body: '{"quantity":3}', expectedStatuses: [201] }] });
  const before = await finished(await lab.start(session, { label: 'write-before', scenario: writes, acceptWrites: true }));
  const withoutReset = await finished(await lab.start(session, { label: 'write-no-reset', scenario: writes, acceptWrites: true }));
  assert.equal(lab.compare(before.id, withoutReset.id).comparable, false);
  preparedAt = new Date().toISOString();
  const after = await finished(await lab.start(session, { label: 'write-after-reset', scenario: writes, acceptWrites: true }));
  assert.equal(lab.compare(before.id, after.id).comparable, true);
  const file = path.join(temp, '.lab', 'runs', after.id + '.json');
  const disk = JSON.parse(fs.readFileSync(file, 'utf8'));
  disk.status = 'running'; fs.writeFileSync(file, JSON.stringify(disk));
  const child = require('node:child_process').spawnSync(process.execPath,
    ['-e', 'const lab=require("./benchmark/src/lab"); process.stdout.write(lab.details(process.env.TEST_RUN_ID).status)'],
    { cwd: path.join(__dirname, '..', '..'), env: { ...process.env, TEST_RUN_ID: after.id }, encoding: 'utf8', windowsHide: true });
  assert.equal(child.status, 0, child.stderr); assert.equal(child.stdout, 'interrupted');
});
test('monitoring establishes a fresh counter baseline before measurement', { skip: !hasK6 }, async () => {
  const called = [];
  lab.setHooks({ resetSample: async () => { called.push('reset'); }, sample: async () => { called.push('sample'); return null; } });
  const run = await finished(await lab.start(session, { label: 'monitoring-baseline', scenario: scenario() }));
  assert.equal(run.status, 'passed');
  assert.deepEqual(called, ['reset', 'sample']);
  assert.deepEqual(run.observations, [], 'the initial counter baseline is not a measured resource sample');
});

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { APP_URL, TASK3_DIR, K6_BIN, LABEL } = require('./config');
const { Problem } = require('./problem');
const shop = require('./shop');
const model = require('./lab-model');
const store = require('./lab-store');
const operations = require('./operations');
let active = null;
let hooks = { sample: async () => null, resetSample: async () => {}, dataset: () => null };
const fail = (status, title, detail) => { throw new Problem(status, title, detail); };
const writes = scenario => scenario.requests.some(r => r.enabled && !['GET', 'HEAD', 'OPTIONS'].includes(r.method));
function acceptWrites(scenario, accepted) {
  if (writes(scenario) && accepted !== true) fail(400, 'This scenario writes data.', 'Confirm that these requests may create, update or delete shop data.');
}
function setHooks(value) { hooks = { ...hooks, ...value }; }
function listScenarios() { return { scenarios: store.scenarios() }; }
function saveScenario(body) {
  const scenario = model.normalize(body); scenario.id ??= crypto.randomUUID();
  const all = store.scenarios(), index = all.findIndex(s => s.id === scenario.id);
  if (index < 0) {
    if (all.length >= 200) fail(409, 'Scenario library is full.', 'Delete an unused scenario first.');
    all.push(scenario);
  } else all[index] = scenario;
  store.scenarios(all); return scenario;
}
function deleteScenario(id) {
  if (!model.ID.test(id)) fail(400, 'Invalid scenario.', 'Select a saved scenario.');
  store.scenarios(store.scenarios().filter(s => s.id !== id)); return { deleted: true };
}
async function credentials(session, scenario, password, requiredMs = 30000) {
  const tokens = { admin: session.token, customer: '' };
  function validUntil(expiry, role) {
    if (Number.isFinite(expiry) && expiry - Date.now() < requiredMs + 60000) {
      fail(400, `The ${role} session expires too soon.`, `Sign in again before starting this test (up to ${Math.ceil(requiredMs / 60000)} minutes).`);
    }
  }
  if (scenario.requests.some(r => r.enabled && r.role === 'admin')) validUntil(session.expiresAt, 'admin');
  if (scenario.requests.some(r => r.enabled && r.role === 'customer')) {
    const customer = await shop.customerSession(password); validUntil(customer.expiresAt, 'customer'); tokens.customer = customer.token;
  }
  return tokens;
}
function quantile(sorted, q) {
  if (!sorted.length) return null;
  const x = (sorted.length - 1) * q, lo = Math.floor(x), hi = Math.ceil(x);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (x - lo);
}
const average = values => values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
function resources(samples) {
  const values = fn => samples.map(fn).filter(Number.isFinite);
  return { cpu: average(values(s => s.api?.available ? s.api.cpuPercent : null)), memory: average(values(s => s.api?.available ? s.api.memoryBytes : null)),
    dbTransactions: average(values(s => s.database?.available ? s.database.transactionsPerSecond : null)),
    dbCacheHit: average(values(s => s.database?.available ? s.database.cacheHitRate : null)),
    dbConnections: average(values(s => s.database?.available ? s.database.activeConnections : null)) };
}
function stats(values, errors, checked, passed, seconds) {
  const sorted = [...values].sort((a, b) => a - b);
  return { p50: quantile(sorted, .5), p95: quantile(sorted, .95), p99: quantile(sorted, .99),
    requests: values.length, throughput: seconds > 0 ? values.length / seconds : 0,
    errors: values.length ? errors / values.length : null, checks: checked ? passed / checked : null };
}
function update(state) {
  const { run } = state;
  const liveMs = run.current?.phase === 'measure' ? Date.now() - Date.parse(run.current.startedAt) : 0;
  const seconds = (state.measuredMs + liveMs) / 1000;
  run.metrics = { ...stats(state.values, state.errors, state.checked, state.passed, seconds),
    dropped: state.dropped, bytesReceived: state.bytes, ...resources(run.observations) };
  run.requestMetrics = [...state.requestStats.entries()].map(([requestId, s]) => ({ requestId,
    name: run.scenario.requests.find(r => r.id === requestId)?.name, ...stats(s.values, s.errors, s.checked, s.passed, seconds) }));
  run.timeline = [...state.buckets.entries()].sort((a, b) => a[0] - b[0]).map(([second, s]) => {
    const sorted = [...s.values].sort((a, b) => a - b);
    return { second, requests: sorted.length, p50: quantile(sorted, .5), p95: quantile(sorted, .95), max: sorted.at(-1), failed: s.errors };
  });
}
function persist(state) { update(state); store.save(state); }
function details(id) {
  if (active?.run.id === id) { update(active); return active.run; }
  return store.get(id);
}
function runs() {
  const all = store.allRuns().map(r => active?.run.id === r.id ? details(r.id) : r);
  return { runs: all.map(({ timeline, observations, logs, ...r }) => ({ ...r, timeline: [], observations: [] })), runningRunId: busy() };
}
async function inspect(session, body = {}) {
  const scenario = model.normalize(body.scenario);
  if (body.requestId !== undefined && !scenario.requests.some(r => r.id === body.requestId)) fail(400, 'Request not found.', 'Select a request that exists in this scenario.');
  const request = scenario.requests.find(r => r.id === body.requestId) ?? scenario.requests.find(r => r.enabled);
  acceptWrites({ requests: [{ ...request, enabled: true }] }, body.acceptWrites);
  const release = operations.acquire('inspection', crypto.randomUUID());
  try {
    const tokens = await credentials(session, { requests: [{ ...request, enabled: true }] }, body.customerPassword);
    const exchange = model.materialize(scenario, request, 0, 1);
    const headers = { ...exchange.headers };
    if (tokens[request.role]) headers.Authorization = `Bearer ${tokens[request.role]}`;
    if (exchange.body && !Object.keys(headers).some(k => k.toLowerCase() === 'content-type')) headers['Content-Type'] = 'application/json';
    const started = performance.now();
    let response;
    try {
      response = await fetch(exchange.url, { method: exchange.method, headers, body: exchange.body || undefined, redirect: 'manual', signal: AbortSignal.timeout(30000) });
    } catch {
      return { method: request.method, url: exchange.url, status: 0, headers: {}, body: '', durationMs: performance.now() - started,
        checks: [{ label: 'The API answered', passed: false }], error: 'The request failed or timed out.' };
    }
    const reader = response.body?.getReader(), chunks = []; let size = 0, truncated = false;
    if (reader) while (true) {
      const next = await reader.read(); if (next.done) break;
      size += next.value.length;
      if (size > 262144) { truncated = true; await reader.cancel(); break; }
      chunks.push(Buffer.from(next.value));
    }
    const text = Buffer.concat(chunks).toString('utf8');
    let preview; try { preview = JSON.stringify(model.redact(JSON.parse(text)), null, 2); } catch { preview = model.redact(text); }
    return { method: request.method, url: exchange.url, status: response.status, headers: model.responseHeaders(response.headers),
      body: preview, truncated, durationMs: performance.now() - started, checks: model.checkResponse(request, response.status, text, exchange.vars),
      ...(truncated ? { note: 'Preview limited to 256 KB; body checks may fail on truncated JSON.' } : {}) };
  } finally { release(); }
}
function appendLog(state, line) {
  let output = String(line);
  for (const token of Object.values(state.tokens)) if (token) output = output.replaceAll(token, '[redacted]');
  state.run.logs = (state.run.logs + model.redact(output) + '\n').slice(-20000);
}
function record(state, event) {
  if (!state.run.scenario.requests.some(r => r.enabled && r.id === event.requestId) || !Number.isFinite(event.durationMs) || event.durationMs < 0 || !Array.isArray(event.checks)) throw new Error('Invalid k6 request record.');
  if (state.run.requestCount >= 250000) {
    state.run.error = 'Stopped at 250,000 recorded responses. Reduce duration or request rate.';
    state.child?.kill('SIGTERM'); return;
  }
  store.append(state, event);
  if (!state.requestStats.has(event.requestId)) state.requestStats.set(event.requestId, { values: [], errors: 0, checked: 0, passed: 0 });
  const failed = event.checks[0]?.passed !== true, passed = event.checks.filter(c => c.passed).length;
  for (const s of [state, state.requestStats.get(event.requestId)]) {
    s.values.push(event.durationMs); s.errors += Number(failed); s.checked += event.checks.length; s.passed += passed;
  }
  const second = Math.floor((state.measuredMs + Math.max(0, Date.parse(event.at) - Date.parse(state.run.current.startedAt))) / 1000);
  if (!state.buckets.has(second)) state.buckets.set(second, { values: [], errors: 0 });
  const bucket = state.buckets.get(second); bucket.values.push(event.durationMs); bucket.errors += Number(failed);
}
function runK6(state, phase, repetition) {
  return new Promise((resolve, reject) => {
    const run = state.run, temp = fs.mkdtempSync(path.join(os.tmpdir(), 'shop-lab-'));
    const config = path.join(temp, 'config.json'), summaryFile = path.join(temp, 'summary.json');
    fs.writeFileSync(config, JSON.stringify({ scenario: run.scenario, phase, repeat: repetition, baseUrl: new URL(APP_URL).origin }), { mode: 0o600 });
    const started = Date.now();
    run.current = { phase, repeat: repetition, seconds: phase === 'warmup' ? run.scenario.load.warmup : run.scenario.load.duration, startedAt: new Date(started).toISOString() };
    persist(state);
    let outputError = null, launchError = null;
    const child = spawn(K6_BIN, ['run', '--quiet', '--no-color', '--log-format=raw', '--log-output=stdout', '--new-machine-readable-summary=false', path.join(TASK3_DIR, 'custom.js')], {
      windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'],
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP,
        K6_NO_USAGE_REPORT: 'true', LAB_CONFIG: config, LAB_SUMMARY: summaryFile, LAB_ADMIN_TOKEN: state.tokens.admin, LAB_CUSTOMER_TOKEN: state.tokens.customer },
    });
    state.child = child;
    const output = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    output.on('line', line => {
      if (line.startsWith('LAB_EVENT ')) {
        try { if (phase === 'measure') record(state, JSON.parse(line.slice(10))); }
        catch (error) { outputError = error; child.kill('SIGTERM'); }
      } else if (line) appendLog(state, line);
    });
    const errors = readline.createInterface({ input: child.stderr, crlfDelay: Infinity });
    errors.on('line', line => appendLog(state, line));
    child.once('error', error => { launchError = error; });
    child.once('close', code => {
      state.child = null;
      const summary = store.read(summaryFile);
      if (phase === 'measure') {
        state.measuredMs += summary?.metrics?.durationMs ?? (Date.now() - started);
        state.dropped += summary?.metrics?.dropped ?? 0; state.bytes += summary?.metrics?.bytesReceived ?? 0;
      }
      run.current = null;
      // mkdtemp produces this exact child directory; it is never built from user input.
      fs.rmSync(temp, { recursive: true, force: true });
      if (launchError || outputError) reject(launchError ?? outputError); else resolve({ code, summary });
    });
    if (state.cancelled) child.kill('SIGTERM');
  });
}
async function sample(state) {
  if (state.sampling || state.run.current?.phase !== 'measure') return;
  state.sampling = true;
  try {
    const value = await hooks.sample(state.session);
    if (value && active === state && state.run.current?.phase === 'measure') state.run.observations.push({ ...value, repeat: state.run.current.repeat });
  } catch { state.run.monitoringNote = 'Backend monitoring is unavailable; HTTP measurements continue.'; }
  finally { state.sampling = false; }
}
async function execute(state) {
  const run = state.run;
  const timer = setInterval(() => {
    sample(state);
    try { persist(state); } catch { run.error = 'Could not save results.'; state.child?.kill('SIGTERM'); }
  }, 2000);
  try {
    for (let repeat = 1; repeat <= run.scenario.load.repeat; repeat++) {
      if (state.cancelled || run.error) break;
      if (run.scenario.load.warmup) {
        const warmup = await runK6(state, 'warmup', repeat);
        if (state.cancelled) break;
        if (warmup.code !== 0) { run.error = 'Warm-up could not complete. See the run output.'; break; }
      }
      // Prime process/database counters outside the measured interval so the first rate
      // sample cannot include idle time or the preceding warm-up.
      try { await hooks.resetSample(); await hooks.sample(state.session); }
      catch { run.monitoringNote = 'Backend monitoring is unavailable; HTTP measurements continue.'; }
      if (state.cancelled) break;
      const before = run.requestCount;
      const measured = await runK6(state, 'measure', repeat);
      const complete = measured.summary?.metrics?.requests === run.requestCount - before;
      const enough = run.scenario.load.mode !== 'iterations' || measured.summary?.metrics?.iterations === run.scenario.load.iterations;
      const status = state.cancelled ? 'cancelled' : measured.code === 0 && complete && enough && measured.summary?.metrics?.requests > 0 ? 'passed' : 'failed';
      run.repetitions.push({ repeat, status, metrics: measured.summary?.metrics ?? null });
      if (!state.cancelled && !complete) run.error = 'Request evidence is incomplete; this run cannot be compared.';
      if (!state.cancelled && !enough) run.error = 'The maximum duration was reached before all iterations finished.';
      persist(state);
    }
  } catch (error) {
    appendLog(state, error.message);
    run.error = error.code === 'ENOENT' ? 'k6 was not found. Rebuild the benchmark image.' : 'The run could not finish. See the output for details.';
  } finally {
    clearInterval(timer); run.current = null;
    run.status = state.cancelled ? 'cancelled' : run.error || run.repetitions.length !== run.scenario.load.repeat || run.repetitions.some(r => r.status !== 'passed') ? 'failed' : 'passed';
    run.finishedAt = new Date().toISOString();
    try {
      run.datasetChanged = ((await hooks.dataset())?.fingerprint ?? null) !== run.datasetFingerprint;
      if (run.datasetChanged) { run.status = 'failed'; run.error = 'The prepared dataset changed during the run.'; }
    } catch { run.monitoringNote = 'Could not verify the ending dataset snapshot.'; }
    fs.closeSync(state.fd);
    try { persist(state); } finally { active = null; state.release(); }
  }
}
async function start(session, body = {}) {
  store.initialize();
  if (typeof body.label !== 'string' || !LABEL.test(body.label)) fail(400, 'Name this run.', 'Use 1–40 letters, numbers, hyphens or underscores.');
  const scenario = model.normalize(body.scenario);
  acceptWrites(scenario, body.acceptWrites);
  if (body.sourceNote !== undefined && (typeof body.sourceNote !== 'string' || body.sourceNote.length > 500)) fail(400, 'Check the source note.', 'Use at most 500 characters.');
  if (store.allRuns().some(r => r.label === body.label)) fail(409, 'This label already has a saved run.', 'Use a new label to preserve the existing result and configuration.');
  const id = crypto.randomUUID(), release = operations.acquire('custom benchmark', id);
  let fd;
  try {
    const maximumMs = scenario.load.repeat * (scenario.load.warmup + scenario.load.duration + 60) * 1000;
    const tokens = await credentials(session, scenario, body.customerPassword, maximumMs), dataset = await hooks.dataset();
    const run = { id, label: body.label, scenario, sourceNote: model.redact(body.sourceNote ?? ''), status: 'running',
      createdAt: new Date().toISOString(), finishedAt: null, current: null, metrics: null, timeline: [], requestMetrics: [], observations: [],
      repetitions: [], requestCount: 0, error: null, logs: '', datasetFingerprint: dataset?.fingerprint ?? null,
      dataset: dataset ? { config: dataset.config, counts: dataset.counts, fingerprint: dataset.fingerprint, preparedAt: dataset.preparedAt } : null,
      workloadFingerprint: model.fingerprint(scenario, dataset?.fingerprint ?? null),
      notes: ['An iteration executes enabled requests in sequence. Warm-up is separate from measurements.',
        'Status and response headers are retained for every measured request. Recording has the same overhead in both runs.',
        'CPU and memory describe the API process; database counters cover the database, not individual requests.'] };
    if (writes(scenario)) run.notes.push('This test writes data. Restore the same starting fixture before another comparison run.');
    fd = store.openRequests(id);
    const state = { run, fd, release, tokens, session, child: null, cancelled: false, values: [], errors: 0, checked: 0, passed: 0,
      measuredMs: 0, dropped: 0, bytes: 0, buckets: new Map(), requestStats: new Map(), offsets: [], offset: 0, sampling: false };
    active = state; persist(state);
    execute(state).catch(error => console.error('Could not finish saving custom run:', error.message));
    return run;
  } catch (error) { if (fd !== undefined) fs.closeSync(fd); active = null; release(); throw error; }
}
function cancel(id) {
  const run = details(id);
  if (!active || active.run.id !== id) fail(409, 'This run is no longer active.', `Its status is ${run.status}.`);
  active.cancelled = true; active.child?.kill('SIGTERM'); return run;
}
function requests(id, query) { return store.page(details(id), query, active?.run.id === id ? active.offsets : undefined); }
function compare(beforeId, afterId) {
  const before = details(beforeId), after = details(afterId), reasons = [];
  if (before.id === after.id) reasons.push('Choose two different runs.');
  if (before.status !== 'passed' || after.status !== 'passed') reasons.push('Both runs must finish and pass their thresholds.');
  if (before.workloadFingerprint !== after.workloadFingerprint) reasons.push('The requests, load settings, thresholds or prepared dataset differ. Use the same configuration to calculate an improvement.');
  if (before.datasetChanged || after.datasetChanged) reasons.push('A dataset changed during the run.');
  if (writes(before.scenario) || writes(after.scenario)) {
    const preparedAt = Date.parse(after.dataset?.preparedAt ?? '');
    const baselineFinished = Date.parse(before.finishedAt ?? '');
    if (!Number.isFinite(preparedAt) || !Number.isFinite(baselineFinished) || preparedAt <= baselineFinished) {
      reasons.push('These requests change data. Prepare the same fixture again after the baseline and before the comparison run.');
    }
  }
  const definitions = [['p50', 'ms', true], ['p95', 'ms', true], ['p99', 'ms', true], ['throughput', 'requests/s', false],
    ['errors', 'ratio', true], ['checks', 'ratio', false], ['requests', 'count', false], ['dropped', 'count', true], ['bytesReceived', 'bytes', true],
    ['cpu', '% of one core', true], ['memory', 'bytes', true], ['dbTransactions', 'transactions/s', false], ['dbCacheHit', 'ratio', false], ['dbConnections', 'connections', true]];
  const metrics = definitions.map(([key, unit, lowerIsBetter]) => {
    const a = before.metrics?.[key] ?? null, b = after.metrics?.[key] ?? null;
    return { key, before: a, after: b, unit, lowerIsBetter,
      changePercent: reasons.length || !Number.isFinite(a) || !Number.isFinite(b) || !a ? null : 100 * (lowerIsBetter ? a - b : b - a) / a };
  });
  return { before, after, comparable: reasons.length === 0, reasons, metrics,
    notes: ['Fixture fingerprints do not detect manual database changes outside the dashboard.', 'Use the same laptop and comparable background activity. Resource changes alone do not prove a faster API.'] };
}
function report(id) {
  const r = details(id);
  return ['OnlineShop custom performance run', `Label: ${r.label}`, `Status: ${r.status}`, `Started: ${r.createdAt}`,
    `Source / optimization: ${r.sourceNote || '(not recorded)'}`, `Workload fingerprint: ${r.workloadFingerprint}`,
    `Dataset fingerprint: ${r.datasetFingerprint ?? '(no prepared dataset snapshot)'}`, '', 'Configuration', JSON.stringify(r.scenario, null, 2),
    '', 'Measurements', JSON.stringify(r.metrics, null, 2), '', 'Per-request measurements', JSON.stringify(r.requestMetrics, null, 2),
    '', 'Repetitions', JSON.stringify(r.repetitions, null, 2), '', 'Notes', ...r.notes,
    ...(r.error ? ['', 'Run error', r.error] : []), '', 'Monitoring', JSON.stringify(r.observations, null, 2), ''].join('\n');
}
function reportComparison(before, after) {
  const comparison = compare(before, after);
  return ['OnlineShop before / after comparison', `Baseline: ${comparison.before.label}`, `Comparison: ${comparison.after.label}`,
    `Comparable: ${comparison.comparable ? 'yes' : 'no'}`, ...comparison.reasons, '', 'Metric | Before | After | Improvement %',
    ...comparison.metrics.map(m => `${m.key} (${m.unit}) | ${m.before ?? 'unavailable'} | ${m.after ?? 'unavailable'} | ${m.changePercent === null ? 'not calculated' : m.changePercent.toFixed(2)}`),
    '', ...comparison.notes, '', report(before), '', report(after)].join('\n');
}
function busy() { return active?.run.id ?? null; }
function shutdown() { if (active) { active.cancelled = true; active.child?.kill('SIGTERM'); } }
module.exports = { setHooks, listScenarios, saveScenario, deleteScenario, start, runs, details, cancel, inspect, requests, compare, report, reportComparison, shutdown, busy };

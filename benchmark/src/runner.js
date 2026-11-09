const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { API, CASES, PROFILES, LABEL, RESULTS_DIR, TASK3_DIR, K6_BIN } = require('./config');
const store = require('./store');
const results = require('./results');
const shop = require('./shop');
const { preflight } = require('./preflight');
const { Problem } = require('./problem');

const SCRIPT = path.join(TASK3_DIR, 'benchmark.js');
const RATE = 20; // fixed in benchmark.js
const MINUTE = 60_000;

// One run at a time: two load tests at once would measure each other, not the shop.
let active = null; // { run, child, live, cancelled }

const busy = () => active?.run.id ?? null;
const seconds = (duration) => Number.parseFloat(duration) * (duration.endsWith('m') ? 60 : 1);
const percent = (rate) => `${(100 * rate).toFixed(1)}%`;

/** Reads the lines k6 appends to its JSON output, a little at a time while it runs. */
class Tail {
  constructor(file) {
    this.file = file;
    this.offset = 0;
    this.rest = '';
  }

  async read(onLine) {
    let handle;
    try {
      handle = await fsp.open(this.file, 'r');
    } catch {
      return; // k6 has not created the file yet
    }
    try {
      const { size } = await handle.stat();
      if (size <= this.offset) return;
      const buffer = Buffer.alloc(size - this.offset);
      await handle.read(buffer, 0, buffer.length, this.offset);
      this.offset = size;
      const lines = (this.rest + buffer.toString('utf8')).split('\n');
      this.rest = lines.pop();
      for (const line of lines) if (line) onLine(line);
    } finally {
      await handle.close();
    }
  }
}

/** Each request's duration goes into the bucket of the second it ended in. */
function ingest(live, line) {
  let point;
  try {
    point = JSON.parse(line);
  } catch {
    return;
  }
  if (point.type !== 'Point' || (point.metric !== 'http_req_duration' && point.metric !== 'http_req_failed')) return;
  const second = Math.max(0, Math.floor((Date.parse(point.data.time) - live.startMs) / 1000));
  let bucket = live.buckets.get(second);
  if (!bucket) live.buckets.set(second, (bucket = { durations: [], failed: 0 }));
  if (point.metric === 'http_req_duration') bucket.durations.push(point.data.value);
  else if (point.data.value === 1) bucket.failed++;
}

function quantile(sorted, q) {
  const position = (sorted.length - 1) * q;
  const low = Math.floor(position);
  const high = Math.ceil(position);
  return sorted[low] + (sorted[high] - sorted[low]) * (position - low);
}

const round = (value) => Math.round(value * 100) / 100;

/** The live view: per second, how many requests ended and how long they took (p50, p95, slowest). */
function timeline(live) {
  return [...live.buckets]
    .filter(([, bucket]) => bucket.durations.length)
    .sort(([a], [b]) => a - b)
    .map(([second, bucket]) => {
      const sorted = [...bucket.durations].sort((a, b) => a - b);
      return {
        second,
        requests: sorted.length,
        failed: bucket.failed,
        p50: round(quantile(sorted, 0.5)),
        p95: round(quantile(sorted, 0.95)),
        max: round(sorted[sorted.length - 1]),
      };
    });
}

/** Why k6 marked the run as failed, in words, from its own summary. */
function explainFailure(summary, code) {
  const m = summary?.metrics;
  if (!m) return `k6 stopped with exit code ${code}.`;
  const reasons = [];
  if (m.checkRate !== null && m.checkRate < 1) reasons.push(`${percent(1 - m.checkRate)} of the responses did not match the case`);
  if (m.failedRate > 0) reasons.push(`${percent(m.failedRate)} of the requests failed`);
  if (m.dropped > 0) reasons.push(`${m.dropped} requests were dropped: the API could not keep up with ${RATE} per second`);
  return reasons.length ? `${reasons.join('; ')}.` : `k6 stopped with exit code ${code}.`;
}

async function runK6(run, step, phase, env) {
  const duration = phase === 'warmup' ? run.plan.warmup : run.plan.duration;
  const summaryFile = phase === 'measure' ? path.join(RESULTS_DIR, run.label, `${step.case}.json.${process.pid}.partial`) : '';
  const stream = path.join(os.tmpdir(), `k6-${run.id}-${step.case}-${phase}.jsonl`);

  // Only what k6 needs: never this service's own environment. K6_NO_USAGE_REPORT keeps k6 from calling home.
  const child = spawn(K6_BIN, [
    'run', '--quiet', '--no-color', '--new-machine-readable-summary=false', '--out', `json=${stream}`, SCRIPT,
  ], {
    env: {
      PATH: process.env.PATH,
      HOME: os.tmpdir(),
      K6_NO_USAGE_REPORT: 'true',
      ...env,
      TASK3_CASE: step.case,
      TASK3_DURATION: duration,
      TASK3_WARMUP: run.plan.warmup,
      TASK3_BASE_URL: API,
      TASK3_SUMMARY_FILE: summaryFile,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const live = { case: step.case, phase, startMs: Date.now(), buckets: new Map(), tail: new Tail(stream) };
  active.child = child;
  active.live = live;
  step.status = phase === 'warmup' ? 'warmup' : 'measuring';
  run.current = { case: step.case, phase, startedAt: new Date(live.startMs).toISOString(), seconds: seconds(duration) };
  store.save();

  let output = '';
  const collect = (chunk) => {
    if (output.length < 1_000_000) output += chunk;
  };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);
  const poll = setInterval(() => live.tail.read((line) => ingest(live, line)).catch(() => {}), 1000);

  const code = await new Promise((resolve) => {
    child.on('error', (error) => {
      output += `\n${error.message}`;
      resolve(-1);
    });
    child.on('close', (exitCode) => resolve(exitCode ?? -1));
  });
  clearInterval(poll);
  await live.tail.read((line) => ingest(live, line)).catch(() => {});
  await fsp.rm(stream, { force: true });
  active.child = null;

  const points = timeline(live);
  store.saveTimeline(run.id, phase === 'warmup' ? `${step.case}-warmup` : step.case, points);

  let summary = null;
  if (summaryFile) {
    try {
      summary = JSON.parse(await fsp.readFile(summaryFile, 'utf8'));
    } catch {
      summary = null;
    }
  }
  return { code, output, summary, summaryFile };
}

async function execute(run, env) {
  const folder = path.join(RESULTS_DIR, run.label);
  try {
    await fsp.mkdir(folder, { recursive: true });
    for (const step of run.steps) {
      if (active.cancelled) break;
      step.startedAt = new Date().toISOString();
      const caseEnv = { ...env, TASK3_ETAG_REQUIRED: run.etag && step.case === 'product-etag' ? '1' : '0' };

      // The same order as run.mjs: a warm-up that is not saved, then the measured run.
      const warmup = await runK6(run, step, 'warmup', caseEnv);
      await fsp.writeFile(path.join(folder, `${step.case}-warmup.txt`), warmup.output);
      if (active.cancelled) {
        step.status = 'cancelled';
        break;
      }
      if (warmup.code !== 0) {
        step.status = 'failed';
        step.error = `The warm-up failed (k6 exit code ${warmup.code}). See task3-results/${run.label}/${step.case}-warmup.txt.`;
        break;
      }

      const measured = await runK6(run, step, 'measure', caseEnv);
      await fsp.writeFile(path.join(folder, `${step.case}.txt`), measured.output);
      step.finishedAt = new Date().toISOString();
      step.metrics = measured.summary?.metrics ?? null;

      if (active.cancelled) {
        step.status = 'cancelled';
        await fsp.rm(measured.summaryFile, { force: true });
        break;
      }
      // Like run.mjs, only a run that passed every threshold becomes a saved result.
      if (measured.code === 0 && measured.summary) {
        await fsp.rename(measured.summaryFile, results.resultPath(run.label, step.case));
        step.status = 'passed';
      } else {
        await fsp.rm(measured.summaryFile, { force: true });
        step.status = 'failed';
        step.error = explainFailure(measured.summary, measured.code);
        break;
      }
    }
  } catch (error) {
    console.error(`Run ${run.id} failed:`, error);
    run.error = 'The benchmark service hit an unexpected error. See its log.';
  } finally {
    for (const step of run.steps) {
      if (step.status === 'waiting') step.status = 'skipped';
      if (step.status === 'warmup' || step.status === 'measuring') step.status = active.cancelled ? 'cancelled' : 'failed';
    }
    run.status = active.cancelled
      ? 'cancelled'
      : run.error || run.steps.some((step) => step.status === 'failed') ? 'failed' : 'passed';
    run.current = null;
    run.finishedAt = new Date().toISOString();
    console.log(`Run ${run.id} (${run.label}) ${run.status}`);
    active = null;
    store.save();
  }
}

function invalid(field, detail) {
  return new Problem(400, 'Some fields need attention.', detail, { field });
}

/** Checks everything that can be checked before a minute of load, then starts the run in the background. */
async function start(session, body = {}) {
  const { label, cases, etag = false, profile = 'standard', productId, customerPassword } = body;

  if (typeof label !== 'string' || !LABEL.test(label)) {
    throw invalid('label', 'Use 1 to 40 letters, numbers, hyphens or underscores, starting with a letter or number (for example before or after-index).');
  }
  const known = CASES.map((c) => c.id);
  if (!Array.isArray(cases) || cases.length === 0 || new Set(cases).size !== cases.length || cases.some((c) => !known.includes(c))) {
    throw invalid('cases', `Pick one or more of: ${known.join(', ')}.`);
  }
  if (!Object.hasOwn(PROFILES, profile)) throw invalid('profile', 'Use standard or quick.');
  if (typeof etag !== 'boolean') throw invalid('etag', 'etag is true or false.');
  if (etag && !cases.includes('product-etag')) throw invalid('etag', 'Sending the ETag only applies to product-etag.');

  if (active) {
    throw new Problem(409, 'A run is already going.', 'Wait for it to finish, or cancel it, before starting another.', { runId: active.run.id });
  }
  const saved = cases.filter((c) => results.exists(label, c));
  if (saved.length) {
    throw new Problem(409, 'These results are already saved under this label.',
      `${saved.join(', ')} already ran as “${label}”. A saved result is never overwritten: pick a new label.`, { field: 'label', saved });
  }

  const ordered = known.filter((c) => cases.includes(c));
  const plan = { ...PROFILES[profile], rate: RATE };
  const needed = ordered.length * (plan.seconds + 10) * 1000;
  if (session.expiresAt && session.expiresAt - Date.now() < needed + MINUTE) {
    throw new Problem(400, 'Your session ends before this run would finish.',
      `The run needs about ${Math.ceil(needed / MINUTE)} min and your login ends in ${Math.max(0, Math.floor((session.expiresAt - Date.now()) / MINUTE))} min. Log out, log in again, then start it.`);
  }

  const ready = await preflight(session, { productId, customerPassword });
  const notReady = ordered.filter((c) => !ready.cases[c].ready);
  if (notReady.length) {
    throw new Problem(409, 'The benchmark data is not ready for these workloads.',
      notReady.map((c) => `${c}: ${ready.cases[c].reasons.join(' ')}`).join(' '),
      { reasons: Object.fromEntries(notReady.map((c) => [c, ready.cases[c].reasons])) });
  }

  const env = { PRODUCT_ID: ready.productId ?? '', ORDERS_TOKEN: session.token, CUSTOMER_TOKEN: '', TASK3_CUSTOMER_ID: '', TASK3_ETAG_VALUE: '' };
  if (ordered.includes('orders-customer')) {
    const customer = await shop.customerSession(customerPassword);
    env.CUSTOMER_TOKEN = customer.token;
    env.TASK3_CUSTOMER_ID = customer.id;
  }
  if (etag) {
    // Fetched outside the timed run, like run.mjs does.
    const current = await shop.call(`/products/${ready.productId}`);
    const tag = current.headers.get('etag');
    if (!tag) throw new Problem(409, 'The product has no ETag yet.', 'Send the ETag after ETags are implemented. Before that, run product-etag without it.');
    env.TASK3_ETAG_VALUE = tag;
  }

  const run = {
    id: crypto.randomUUID(),
    label,
    cases: ordered,
    etag,
    profile,
    plan,
    productId: ready.productId,
    status: 'running',
    startedBy: session.user.email,
    createdAt: new Date().toISOString(),
    finishedAt: null,
    error: null,
    current: null,
    steps: ordered.map((c) => ({ case: c, status: 'waiting', startedAt: null, finishedAt: null, metrics: null, error: null })),
  };
  store.addRun(run);
  active = { run, child: null, live: null, cancelled: false };
  console.log(`Run ${run.id} (${label}) started by ${run.startedBy}: ${ordered.join(', ')}`);
  execute(run, env);
  return run;
}

function cancel(id) {
  const run = store.findRun(id);
  if (!run) throw new Problem(404, 'Run not found.', `There is no run ${id}.`);
  if (!active || active.run.id !== id) throw new Problem(409, 'This run is not going.', `It is ${run.status}.`);
  active.cancelled = true;
  active.child?.kill('SIGTERM');
  return run;
}

/** A run, with its timelines: live for the step that is going, saved for the finished ones. */
function details(id) {
  const run = store.findRun(id);
  if (!run) throw new Problem(404, 'Run not found.', `There is no run ${id}.`);
  const isLive = active?.run.id === id && active.live;
  const timelines = {};
  for (const step of run.steps) {
    if (step.status === 'waiting' || step.status === 'skipped') continue;
    const saved = store.readTimeline(run.id, step.case);
    if (saved) timelines[step.case] = saved;
  }
  return {
    ...run,
    live: isLive
      ? {
          case: active.live.case,
          phase: active.live.phase,
          elapsedSeconds: Math.round((Date.now() - active.live.startMs) / 100) / 10,
          points: timeline(active.live),
        }
      : null,
    timelines,
  };
}

/** Stops k6 when the container stops, so it does not keep loading the API without anyone watching. */
function shutdown() {
  if (!active) return;
  active.cancelled = true;
  active.child?.kill('SIGTERM');
}

module.exports = { start, cancel, details, busy, shutdown };

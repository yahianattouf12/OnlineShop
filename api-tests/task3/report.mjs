import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';

const resultsDir = new URL('../../task3-results/', import.meta.url);
const cases = ['orders-first', 'orders-deep', 'orders-customer', 'product-hot', 'product-etag'];
const labels = process.argv.slice(2);

if (labels.length < 2 || new Set(labels).size !== labels.length ||
    labels.some(label => !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(label))) {
  console.error('Usage: node api-tests/task3/report.mjs <baseline-label> <comparison-label> [more-comparisons...]');
  console.error('Use distinct stage labels containing only letters, numbers, hyphens, and underscores.');
  process.exit(1);
}

const [baselineLabel, ...comparisonLabels] = labels;
const isNonnegative = value => Number.isFinite(value) && value >= 0;
const isCount = value => Number.isSafeInteger(value) && value >= 0;
const isRate = value => isNonnegative(value) && value <= 1;
const isDuration = value => typeof value === 'string' && /^(?:\d+(?:\.\d+)?(?:ms|s|m|h))+$/.test(value);
const percent = rate => `${(100 * rate).toFixed(2)}%`;
const ms = value => `${value.toFixed(2)} ms`;
const bytes = (count, requests) => `${count.toLocaleString('en-US')} B (${(count / requests).toFixed(1)} B/request)`;

function readResult(label, name) {
  let raw;
  try {
    raw = readFileSync(new URL(`${label}/${name}.json`, resultsDir), 'utf8');
  } catch (error) {
    return { problem: error.code === 'ENOENT' ? 'missing result' : 'could not read result' };
  }

  let result;
  try {
    result = JSON.parse(raw);
  } catch {
    return { problem: 'invalid JSON' };
  }

  const { workload, metrics } = result ?? {};
  if (result?.case !== name || !workload || typeof workload.url !== 'string' ||
      !workload.url || !(Number.isFinite(workload.rate) && workload.rate > 0) ||
      !isCount(workload.preAllocatedVUs) || workload.preAllocatedVUs === 0 ||
      !isDuration(workload.duration) ||
      (name.startsWith('orders-') && !isCount(workload.expectedOrders))) {
    return { problem: 'invalid workload metadata' };
  }

  if (!metrics || ![metrics.p50, metrics.p95, metrics.p99].every(isNonnegative) ||
      metrics.p50 > metrics.p95 || metrics.p95 > metrics.p99 ||
      ![metrics.requests, metrics.dropped, metrics.bytesReceived, metrics.status200, metrics.status304].every(isCount) ||
      metrics.requests === 0 || metrics.status200 + metrics.status304 > metrics.requests ||
      !(Number.isFinite(metrics.requestsPerSecond) && metrics.requestsPerSecond > 0) ||
      !isRate(metrics.failedRate) || !isRate(metrics.checkRate) ||
      (metrics.bodyBytesReceived !== undefined && !isCount(metrics.bodyBytesReceived))) {
    return { problem: 'missing or invalid measurements' };
  }

  const expectedStatus = name === 'product-etag' ? result.expectedStatus : 200;
  if (expectedStatus !== 200 && expectedStatus !== 304) {
    return { problem: 'invalid expected HTTP status' };
  }

  const expectedResponses = expectedStatus === 200 ? metrics.status200 : metrics.status304;
  const passed = metrics.checkRate === 1 && metrics.failedRate === 0 && metrics.dropped === 0 &&
    expectedResponses === metrics.requests;
  return { workload, metrics, expectedStatus, passed };
}

function describe(label, result) {
  if (result.problem) return [`  ${label}: ${result.problem}`];

  const m = result.metrics;
  const { rate, duration, preAllocatedVUs } = result.workload;
  const outcome = result.passed ? 'PASS' : 'FAILED CHECKS, HTTP STATUS, OR DROPS';
  const lines = [
    `  ${label} [${outcome}]: p50 ${ms(m.p50)} | p95 ${ms(m.p95)} | p99 ${ms(m.p99)}`,
    `    Configured ${rate}/s for ${duration} with ${preAllocatedVUs} preallocated VUs`,
    `    ${m.requests} requests, ${m.requestsPerSecond.toFixed(2)}/s | failures ${percent(m.failedRate)} | checks ${percent(m.checkRate)} | dropped ${m.dropped}`,
    `    HTTP 200: ${m.status200} | HTTP 304: ${m.status304} | network received: ${bytes(m.bytesReceived, m.requests)}`,
  ];
  if (m.bodyBytesReceived !== undefined) {
    lines.push(`    Response bodies: ${bytes(m.bodyBytesReceived, m.requests)}`);
  }
  return lines;
}

function reduction(before, after) {
  if (before === 0) return 'n/a (baseline is zero)';
  const change = 100 * (before - after) / before;
  if (Math.abs(change) < 0.05) return '0.0%';
  return change > 0 ? `+${change.toFixed(1)}%` : `${change.toFixed(1)}% (regression)`;
}

function compare(label, baseline, comparison) {
  const title = `  ${baselineLabel} -> ${label}`;
  if (baseline.problem || comparison.problem) return [`${title}: unavailable`];
  if (!isDeepStrictEqual(baseline.workload, comparison.workload)) {
    return [`${title}: workloads differ, so no comparison`];
  }
  if (!baseline.passed || !comparison.passed) {
    return [`${title}: both runs must pass their checks without HTTP failures or dropped iterations`];
  }

  const a = baseline.metrics;
  const b = comparison.metrics;
  const lines = [
    `${title}: latency reduction p50 ${reduction(a.p50, b.p50)} | p95 ${reduction(a.p95, b.p95)} | p99 ${reduction(a.p99, b.p99)}`,
    `    Network received per request: ${(a.bytesReceived / a.requests).toFixed(1)} -> ${(b.bytesReceived / b.requests).toFixed(1)} B`,
  ];
  if (a.bodyBytesReceived !== undefined && b.bodyBytesReceived !== undefined) {
    lines.push(`    Response body per request: ${(a.bodyBytesReceived / a.requests).toFixed(1)} -> ${(b.bodyBytesReceived / b.requests).toFixed(1)} B`);
  }
  if (baseline.expectedStatus !== comparison.expectedStatus) {
    lines.push(`    Conditional request outcome: HTTP ${baseline.expectedStatus} -> ${comparison.expectedStatus}`);
  }
  return lines;
}

const report = [
  'OnlineShop Task 3 performance report',
  `Baseline: ${baselineLabel} | Comparisons: ${comparisonLabels.join(', ')}`,
  'Latency reduction is relative to baseline. Network received includes HTTP overhead.',
];

for (const name of cases) {
  const baseline = readResult(baselineLabel, name);
  report.push('', name, ...describe(baselineLabel, baseline));
  for (const label of comparisonLabels) {
    const comparison = readResult(label, name);
    report.push(...describe(label, comparison), ...compare(label, baseline, comparison));
  }
}

report.push(
  '', 'Evidence to attach',
  '  PostgreSQL EXPLAIN ANALYZE plans and query counts before/after:',
  '  Read-replica routing and read-your-writes check:',
  '  Redis hits, TTL and invalidation after a product update:',
  '  Conditional GET returning updated content after an edit, then HTTP 304 with the new ETag:',
  '  Observations under load:',
);

mkdirSync(resultsDir, { recursive: true });
writeFileSync(new URL('report.txt', resultsDir), `${report.join('\n')}\n`, 'utf8');
console.log('Wrote task3-results/report.txt');

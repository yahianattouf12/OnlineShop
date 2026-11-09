const fs = require('node:fs');
const path = require('node:path');
const { isDeepStrictEqual } = require('node:util');
const { CASES, LABEL, RESULTS_DIR } = require('./config');

// The same checks as api-tests/task3/report.mjs, so the website and the text report never disagree.
const isNonnegative = (value) => Number.isFinite(value) && value >= 0;
const isCount = (value) => Number.isSafeInteger(value) && value >= 0;
const isRate = (value) => isNonnegative(value) && value <= 1;
const isDuration = (value) => typeof value === 'string' && /^(?:\d+(?:\.\d+)?(?:ms|s|m|h))+$/.test(value);

function resultPath(label, caseName) {
  return path.join(RESULTS_DIR, label, `${caseName}.json`);
}

function readResult(label, caseName) {
  let raw;
  let savedAt = null;
  try {
    raw = fs.readFileSync(resultPath(label, caseName), 'utf8');
    savedAt = fs.statSync(resultPath(label, caseName)).mtime.toISOString();
  } catch (error) {
    return { problem: error.code === 'ENOENT' ? 'missing result' : 'could not read result' };
  }

  let result;
  try {
    result = JSON.parse(raw);
  } catch {
    return { problem: 'invalid JSON', savedAt };
  }

  const { workload, metrics } = result ?? {};
  if (result?.case !== caseName || !workload || typeof workload.url !== 'string' ||
      !workload.url || !(Number.isFinite(workload.rate) && workload.rate > 0) ||
      !isCount(workload.preAllocatedVUs) || workload.preAllocatedVUs === 0 ||
      !isDuration(workload.duration) ||
      (caseName.startsWith('orders-') && !isCount(workload.expectedOrders))) {
    return { problem: 'invalid workload metadata', savedAt };
  }

  if (!metrics || ![metrics.p50, metrics.p95, metrics.p99].every(isNonnegative) ||
      metrics.p50 > metrics.p95 || metrics.p95 > metrics.p99 ||
      ![metrics.requests, metrics.dropped, metrics.bytesReceived, metrics.status200, metrics.status304].every(isCount) ||
      metrics.requests === 0 || metrics.status200 + metrics.status304 > metrics.requests ||
      !(Number.isFinite(metrics.requestsPerSecond) && metrics.requestsPerSecond > 0) ||
      !isRate(metrics.failedRate) || !isRate(metrics.checkRate)) {
    return { problem: 'missing or invalid measurements', savedAt };
  }

  const expectedStatus = caseName === 'product-etag' ? result.expectedStatus : 200;
  if (expectedStatus !== 200 && expectedStatus !== 304) return { problem: 'invalid expected HTTP status', savedAt };

  const expectedResponses = expectedStatus === 200 ? metrics.status200 : metrics.status304;
  const passed = metrics.checkRate === 1 && metrics.failedRate === 0 && metrics.dropped === 0 &&
    expectedResponses === metrics.requests;
  return {
    workload,
    metrics,
    expectedStatus,
    passed,
    savedAt,
    // Runs from this service call the API inside Docker (http://app:8080); the CLI calls localhost.
    runner: /\/\/(localhost|127\.0\.0\.1)[:/]/.test(workload.url) ? 'cli' : 'dashboard',
  };
}

function labels() {
  let entries;
  try {
    entries = fs.readdirSync(RESULTS_DIR, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.filter((entry) => entry.isDirectory() && LABEL.test(entry.name)).map((entry) => entry.name);
}

/** Every label with its saved cases, oldest label first (the order the stages were measured in). */
function listResults() {
  const list = [];
  for (const label of labels()) {
    const cases = {};
    let firstSaved = null;
    for (const { id } of CASES) {
      const result = readResult(label, id);
      if (result.problem === 'missing result') continue;
      cases[id] = result;
      if (result.savedAt && (!firstSaved || result.savedAt < firstSaved)) firstSaved = result.savedAt;
    }
    if (Object.keys(cases).length) list.push({ label, firstSaved, cases });
  }
  return list.sort((a, b) => (a.firstSaved ?? '').localeCompare(b.firstSaved ?? '') || a.label.localeCompare(b.label));
}

const exists = (label, caseName) => fs.existsSync(resultPath(label, caseName));

/** Positive = faster than the baseline. Rounded to one decimal, like the text report. */
function reduction(before, after) {
  if (before === 0) return null;
  return Math.round((1000 * (before - after)) / before) / 10;
}

/** The baseline against each comparison label, case by case, with the same rules as report.mjs. */
function compare(baselineLabel, comparisonLabels) {
  return CASES.map(({ id }) => {
    const baseline = readResult(baselineLabel, id);
    const comparisons = comparisonLabels.map((label) => {
      const result = readResult(label, id);
      let comparable = true;
      let reason = null;
      if (baseline.problem || result.problem) {
        comparable = false;
        reason = `Unavailable: ${baseline.problem ? `${baselineLabel} has ${baseline.problem}` : `${label} has ${result.problem}`}.`;
      } else if (!isDeepStrictEqual(baseline.workload, result.workload)) {
        comparable = false;
        reason = 'The workloads differ (URL, rate, length or fixtures), so the numbers are not comparable.';
      } else if (!baseline.passed || !result.passed) {
        comparable = false;
        reason = 'Both runs must pass their checks without HTTP failures or dropped requests.';
      }
      const change = comparable
        ? {
            p50: reduction(baseline.metrics.p50, result.metrics.p50),
            p95: reduction(baseline.metrics.p95, result.metrics.p95),
            p99: reduction(baseline.metrics.p99, result.metrics.p99),
            bytesPerRequest: {
              before: baseline.metrics.bytesReceived / baseline.metrics.requests,
              after: result.metrics.bytesReceived / result.metrics.requests,
            },
            status: baseline.expectedStatus !== result.expectedStatus ? { before: baseline.expectedStatus, after: result.expectedStatus } : null,
          }
        : null;
      return { label, result: result.problem === 'missing result' ? null : result, comparable, reason, change };
    });
    return { case: id, baseline: baseline.problem === 'missing result' ? null : baseline, comparisons };
  });
}

module.exports = { readResult, listResults, compare, exists, resultPath };

import http from 'k6/http';
import { check, sleep } from 'k6';
import execution from 'k6/execution';

// The server validates a JSON description. It never creates or executes user-supplied JavaScript.
const config = JSON.parse(open(__ENV.LAB_CONFIG));
const scenario = config.scenario;
const load = scenario.load;
const warmup = config.phase === 'warmup';
const plan = warmup
  ? load.mode === 'rate'
    ? { executor: 'constant-arrival-rate', rate: load.rate, timeUnit: '1s', duration: `${load.warmup}s`, preAllocatedVUs: load.concurrency, maxVUs: load.concurrency }
    : { executor: 'constant-vus', vus: load.concurrency, duration: `${load.warmup}s` }
  : load.mode === 'iterations'
    ? { executor: 'shared-iterations', vus: Math.min(load.concurrency, load.iterations), iterations: load.iterations, maxDuration: `${load.duration}s` }
    : load.mode === 'rate'
      ? { executor: 'constant-arrival-rate', rate: load.rate, timeUnit: '1s', duration: `${load.duration}s`, preAllocatedVUs: load.concurrency, maxVUs: load.concurrency }
      : { executor: 'constant-vus', vus: load.concurrency, duration: `${load.duration}s` };

export const options = {
  scenarios: { custom: { ...plan, gracefulStop: '30s' } },
  summaryTrendStats: ['med', 'p(95)', 'p(99)'],
  thresholds: warmup ? {} : {
    http_req_duration: [`p(95)<=${scenario.thresholds.p95}`],
    http_req_failed: [`rate<=${scenario.thresholds.errorRate}`],
    checks: [`rate>=${scenario.thresholds.checks}`],
    dropped_iterations: ['count==0'],
  },
  discardResponseBodies: true,
};

const sensitive = /authorization|cookie|password|secret|access.?token|refresh.?token|api.?key/i;
const token = /[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}/g;
function clean(value) { return String(value).replace(token, '[redacted]'); }
function headersForLog(headers) {
  const result = {};
  Object.keys(headers).forEach(key => { result[key] = sensitive.test(key) ? '[redacted]' : clean(headers[key]).slice(0, 4096); });
  return result;
}
function variables(iteration) {
  const data = scenario.data;
  const vars = { ...(data.rows.length ? data.rows[iteration % data.rows.length] : {}), iteration, vu: execution.vu.idInTest };
  data.ranges.forEach(r => { vars[r.name] = r.min + (iteration % (Math.floor((r.max - r.min) / r.step) + 1)) * r.step; });
  return vars;
}
function render(value, vars, encode) {
  return value.replace(/\{\{([\w.-]+)\}\}/g, (_, key) => {
    if (!Object.prototype.hasOwnProperty.call(vars, key)) throw new Error(`Missing variable ${key}`);
    return encode ? encodeURIComponent(String(vars[key])) : String(vars[key]);
  });
}
function urlFor(request, vars) {
  let path = render(request.path, vars, true);
  const decoded = decodeURIComponent(path);
  if (!path.startsWith('/api/') || path.includes('\\') || path.includes('#') || decoded.includes('\\') || /(?:^|\/)\.\.?(?:\/|\?|$)/.test(decoded) || /[\r\n\x00]/.test(decoded)) throw new Error('A data row produced an invalid API path');
  // Query fields override query values already present in the path, just as the HTTP inspector does.
  const split = path.indexOf('?');
  const existing = split < 0 ? [] : path.slice(split + 1).split('&').filter(part => {
    const key = decodeURIComponent(part.split('=')[0].replace(/\+/g, ' '));
    return !Object.prototype.hasOwnProperty.call(request.query, key);
  });
  if (split >= 0) path = path.slice(0, split);
  const query = Object.keys(request.query).map(key => `${encodeURIComponent(key)}=${encodeURIComponent(render(request.query[key], vars))}`).join('&');
  const combined = [...existing, query].filter(Boolean).join('&');
  if (combined) path += '?' + combined;
  return config.baseUrl + path;
}
function responseChecks(request, response, vars) {
  const checks = [{ label: `HTTP ${request.expectedStatuses.join(' or ')}`, passed: request.expectedStatuses.includes(response.status) }];
  let json;
  if (request.assertions.length) { try { json = response.json(); } catch { json = undefined; } }
  request.assertions.forEach(a => {
    let value = json;
    a.path.split('.').forEach(key => { value = value != null && Object.prototype.hasOwnProperty.call(Object(value), key) ? value[key] : undefined; });
    const expected = typeof a.value === 'string' ? render(a.value, vars) : a.value;
    const passed = a.operator === 'exists' ? value !== undefined : a.operator === 'eq' ? value !== undefined && String(value) === String(expected) : value != null && String(value).includes(String(expected));
    checks.push({ label: `${a.path} ${a.operator}${a.operator === 'exists' ? '' : ` ${expected}`}`, passed });
  });
  return checks;
}
export default function () {
  const iteration = execution.scenario.iterationInTest;
  const vars = variables(iteration);
  for (const request of scenario.requests.filter(r => r.enabled)) {
    const headers = {};
    Object.keys(request.headers).forEach(key => { headers[key] = render(request.headers[key], vars); });
    const accessToken = request.role === 'admin' ? __ENV.LAB_ADMIN_TOKEN : request.role === 'customer' ? __ENV.LAB_CUSTOMER_TOKEN : '';
    if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
    if (request.body && !Object.keys(headers).some(k => k.toLowerCase() === 'content-type')) headers['Content-Type'] = 'application/json';
    const url = urlFor(request, vars);
    const response = http.request(request.method, url, request.body ? render(request.body, vars) : null, {
      headers, redirects: 0, timeout: '30s', responseType: request.assertions.length ? 'text' : 'none',
      responseCallback: http.expectedStatuses(...request.expectedStatuses),
      tags: { requestId: request.id, name: request.name },
    });
    const checks = responseChecks(request, response, vars);
    checks.forEach(item => check(response, { [item.label]: () => item.passed }, { requestId: request.id }));
    if (!warmup) console.log('LAB_EVENT ' + JSON.stringify({
      requestId: request.id, name: request.name, method: request.method, url: clean(url),
      status: response.status, headers: headersForLog(response.headers), durationMs: response.timings.duration,
      checks, iteration, repeat: config.repeat, at: new Date().toISOString(), error: clean(response.error || ''),
    }));
  }
  if (load.pauseMs) sleep(load.pauseMs / 1000);
}

export function handleSummary(data) {
  const values = name => data.metrics[name]?.values ?? {};
  const latency = values('http_req_duration');
  const summary = {
    phase: config.phase, repeat: config.repeat,
    metrics: { p50: latency.med ?? null, p95: latency['p(95)'] ?? null, p99: latency['p(99)'] ?? null,
      throughput: values('http_reqs').rate ?? 0, requests: values('http_reqs').count ?? 0,
      errors: values('http_req_failed').rate ?? null, checks: values('checks').rate ?? null,
      dropped: values('dropped_iterations').count ?? 0, bytesReceived: values('data_received').count ?? 0,
      iterations: values('iterations').count ?? 0, durationMs: data.state?.testRunDurationMs ?? null },
  };
  return { [__ENV.LAB_SUMMARY]: JSON.stringify(summary) };
}

const crypto = require('node:crypto');
const { APP_URL } = require('./config');
const { Problem } = require('./problem');

const METRICS = ['p50', 'p95', 'p99', 'throughput', 'errors', 'checks', 'requests', 'dropped', 'bytesReceived', 'cpu', 'memory', 'database', 'dbTransactions', 'dbCacheHit', 'dbConnections'];
const ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,59}$/;
const SECRET = /authorization|cookie|password|secret|access.?token|refresh.?token|api.?key/i;
const TOKEN = /[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}/g;
const reserved = new Set(['__proto__', 'constructor', 'prototype', 'iteration', 'vu']);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const problem = (field, detail) => { throw new Problem(400, 'Check the test configuration.', detail, { field }); };
function number(value, field, min, max, fallback, integer = true) {
  const n = value === undefined ? fallback : value;
  if (!Number.isFinite(n) || (integer && !Number.isInteger(n)) || n < min || n > max) problem(field, `${field} must be ${integer ? 'a whole number' : 'a number'} from ${min} to ${max}.`);
  return n;
}
function text(value, field, max, fallback = '') {
  const v = value === undefined ? fallback : value;
  if (typeof v !== 'string' || v.length > max || /\x00/.test(v)) problem(field, `${field} must be text, at most ${max} characters.`);
  return v;
}
function safeKey(key, field) {
  if (typeof key !== 'string' || !/^[a-zA-Z][\w.-]{0,79}$/.test(key) || reserved.has(key) || SECRET.test(key)) problem(field, `“${key}” is not a supported field name. Keep credentials in the sign-in session, not saved test data.`);
}
function rejectSecrets(value, field) {
  if (typeof value === 'string' && TOKEN.test(value)) { TOKEN.lastIndex = 0; problem(field, 'Access tokens cannot be saved in tests. Select an authentication role instead.'); }
  TOKEN.lastIndex = 0;
  if (object(value)) for (const [key, item] of Object.entries(value)) {
    if (SECRET.test(key)) problem(field, 'Credential fields cannot be saved in a test. Use the signed-in admin or customer role.');
    rejectSecrets(item, field);
  }
  if (Array.isArray(value)) value.forEach(item => rejectSecrets(item, field));
}
function pairs(value, field, headers = false) {
  if (value === undefined) return {};
  if (!object(value) || Object.keys(value).length > 30) problem(field, `${field} must be an object with at most 30 fields.`);
  const result = {};
  for (const [key, v] of Object.entries(value)) {
    safeKey(key, field);
    if (headers && /^(host|connection|content-length|transfer-encoding|proxy-.*|forwarded|x-forwarded-.*)$/i.test(key)) problem(field, `The ${key} header is managed by the HTTP client.`);
    if (!['string', 'number', 'boolean'].includes(typeof v)) problem(field, `${field}.${key} must be text, a number or true/false.`);
    const s = String(v);
    if (s.length > 2048 || /[\r\n\x00]/.test(s)) problem(field, `${field}.${key} is too long or contains a line break.`);
    rejectSecrets(s, field);
    result[key] = s;
  }
  return result;
}
function target(path, query = {}) {
  // Check both the literal and decoded route. Never allow variables to change the origin or traverse out of /api/.
  if (typeof path !== 'string' || !path.startsWith('/api/') || path.includes('\\') || path.includes('#') || /[\r\n\x00]/.test(path)) problem('path', 'Use a relative shop API path beginning with /api/, for example /api/v1/products.');
  let decoded;
  try { decoded = decodeURIComponent(path); } catch { problem('path', 'The API path contains invalid URL encoding.'); }
  if (decoded.includes('\\') || /(?:^|\/)\.\.?(?:\/|\?|$)/.test(decoded) || /[\r\n\x00]/.test(decoded)) problem('path', 'The API path contains an unsupported path segment.');
  const base = new URL(APP_URL);
  const url = new URL(path, base.origin);
  if (url.origin !== base.origin || !url.pathname.startsWith('/api/')) problem('path', 'Requests must stay on this shop API.');
  for (const key of url.searchParams.keys()) if (SECRET.test(key)) problem('path', 'Credentials cannot be placed in query parameters.');
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  return url.href;
}
function normalize(input) {
  if (!object(input)) problem('scenario', 'Provide a scenario object.');
  const name = text(input.name, 'name', 100, 'Custom scenario').trim();
  if (!name) problem('name', 'Give this scenario a name.');
  if (!Array.isArray(input.requests) || input.requests.length < 1 || input.requests.length > 20) problem('requests', 'Choose between 1 and 20 requests.');
  const requests = input.requests.map((r, i) => {
    if (!object(r)) problem('requests', 'Each request must be an object.');
    const id = text(r.id, 'request ID', 60, `request-${i + 1}`);
    if (!ID.test(id)) problem('request ID', 'Use letters, numbers, hyphens and underscores for request IDs.');
    const method = text(r.method, 'method', 10, 'GET').toUpperCase();
    if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].includes(method)) problem('method', 'Choose GET, HEAD, OPTIONS, POST, PUT, PATCH or DELETE.');
    const path = text(r.path, 'path', 2048);
    target(path.replace(/\{\{[\w.-]+\}\}/g, '1'));
    const role = r.role ?? 'admin';
    if (!['admin', 'customer', 'anonymous'].includes(role)) problem('role', 'Choose admin, customer or anonymous.');
    const body = text(r.body, 'body', 16384);
    if (body && ['GET', 'HEAD'].includes(method)) problem('body', `${method} requests do not send a body.`);
    try { rejectSecrets(JSON.parse(body), 'body'); } catch (error) { if (error instanceof Problem) throw error; }
    if (/\b(password|secret|access.?token|refresh.?token|api.?key)\s*[=:]/i.test(body)) problem('body', 'Credential fields cannot be saved in request bodies.');
    rejectSecrets(body, 'body');
    const statuses = r.expectedStatuses ?? [200];
    if (!Array.isArray(statuses) || !statuses.length || statuses.length > 20 || statuses.some(n => !Number.isInteger(n) || n < 100 || n > 599)) problem('expectedStatuses', 'Provide one or more HTTP status codes from 100 to 599.');
    const assertions = r.assertions ?? [];
    if (!Array.isArray(assertions) || assertions.length > 20) problem('assertions', 'Use up to 20 JSON checks per request.');
    return { id, name: text(r.name, 'request name', 100, `Request ${i + 1}`), method, path, role,
      headers: pairs(r.headers, 'headers', true), query: pairs(r.query, 'query'), body,
      expectedStatuses: [...new Set(statuses)].sort((a, b) => a - b), enabled: r.enabled !== false,
      assertions: assertions.map(a => {
        if (!object(a) || !/^[\w]+(?:\.[\w]+)*$/.test(a.path ?? '') || a.path.length > 150 || !['eq', 'exists', 'contains'].includes(a.operator)) problem('assertions', 'A JSON check needs a dotted field path and eq, exists or contains.');
        if (a.path.split('.').some(k => reserved.has(k))) problem('assertions', 'Unsupported JSON field path.');
        if (!['string', 'number', 'boolean', 'undefined'].includes(typeof a.value) && a.value !== null) problem('assertions', 'Check values must be text, numbers, true/false or null.');
        return { path: a.path, operator: a.operator, value: a.value ?? null };
      }) };
  });
  if (new Set(requests.map(r => r.id)).size !== requests.length) problem('requests', 'Request IDs must be unique.');
  if (!requests.some(r => r.enabled)) problem('requests', 'Enable at least one request.');
  const rawData = input.data ?? {};
  if (!object(rawData)) problem('data', 'Test data must be an object.');
  const rows = rawData.rows ?? [];
  if (!Array.isArray(rows) || rows.length > 1000) problem('data.rows', 'Use at most 1,000 test-data rows.');
  const normalizedRows = rows.map(row => pairs(row, 'data.rows'));
  const ranges = rawData.ranges ?? [];
  if (!Array.isArray(ranges) || ranges.length > 20) problem('data.ranges', 'Use at most 20 ranges.');
  const normalizedRanges = ranges.map(r => {
    if (!object(r)) problem('data.ranges', 'Each range needs a name, minimum, maximum and step.');
    safeKey(r.name, 'range name');
    const min = number(r.min, 'range minimum', -1e9, 1e9);
    const max = number(r.max, 'range maximum', min, 1e9);
    return { name: r.name, min, max, step: number(r.step, 'range step', 1, 1e9, 1) };
  });
  if (new Set(normalizedRanges.map(r => r.name)).size !== normalizedRanges.length) problem('data.ranges', 'Range names must be unique.');
  const rawLoad = input.load ?? {};
  if (!object(rawLoad)) problem('load', 'Load settings must be an object.');
  const mode = rawLoad.mode ?? 'iterations';
  if (!['iterations', 'duration', 'rate'].includes(mode)) problem('mode', 'Choose iterations, duration or rate.');
  const load = { mode, iterations: number(rawLoad.iterations, 'iterations', 1, 100000, 100),
    duration: number(rawLoad.duration, 'duration', 1, 3600, 60), warmup: number(rawLoad.warmup, 'warmup', 0, 300, 5),
    concurrency: number(rawLoad.concurrency, 'concurrency', 1, 200, 5), rate: number(rawLoad.rate, 'rate', 1, 1000, 10),
    repeat: number(rawLoad.repeat, 'repeat', 1, 10, 1), pauseMs: number(rawLoad.pauseMs, 'pauseMs', 0, 60000, 0) };
  const estimate = (mode === 'iterations' ? load.iterations : mode === 'rate' ? load.rate * load.duration : 0) * requests.filter(r => r.enabled).length * load.repeat;
  if (estimate > 250000) problem('load', 'This configuration exceeds 250,000 recorded requests. Reduce iterations, rate, duration or repetitions.');
  const t = input.thresholds ?? {};
  if (!object(t)) problem('thresholds', 'Thresholds must be an object.');
  const thresholds = { p95: number(t.p95, 'p95', 1, 300000, 1000), errorRate: number(t.errorRate, 'errorRate', 0, 1, 0, false), checks: number(t.checks, 'checks', 0, 1, 1, false) };
  const metrics = input.metrics ?? ['p50', 'p95', 'p99', 'throughput', 'errors'];
  if (!Array.isArray(metrics) || metrics.some(m => !METRICS.includes(m))) problem('metrics', 'Choose supported metrics.');
  const output = { name, requests, data: { rows: normalizedRows, ranges: normalizedRanges }, load, thresholds,
    metrics: [...new Set(metrics)], datasetTag: text(input.datasetTag, 'datasetTag', 120) };
  if (input.id !== undefined) { if (!ID.test(input.id)) problem('id', 'The scenario ID is invalid.'); output.id = input.id; }
  // Validate all templates before a run spends time on warm-up.
  for (const r of requests) for (let row = 0; row < Math.max(1, normalizedRows.length); row++) materialize(output, r, row, 1);
  return output;
}
function variables(scenario, iteration, vu) {
  const values = { ...(scenario.data.rows.length ? scenario.data.rows[iteration % scenario.data.rows.length] : {}), iteration, vu };
  for (const r of scenario.data.ranges) values[r.name] = r.min + (iteration % (Math.floor((r.max - r.min) / r.step) + 1)) * r.step;
  return values;
}
function interpolate(value, vars, url = false) {
  return value.replace(/\{\{([\w.-]+)\}\}/g, (_, key) => {
    if (!Object.hasOwn(vars, key)) problem('data', `No test-data value was provided for {{${key}}}.`);
    return url ? encodeURIComponent(String(vars[key])) : String(vars[key]);
  });
}
function materialize(scenario, request, iteration, vu) {
  const vars = variables(scenario, iteration, vu);
  const query = Object.fromEntries(Object.entries(request.query).map(([k, v]) => [k, interpolate(v, vars)]));
  const headers = Object.fromEntries(Object.entries(request.headers).map(([k, v]) => [k, interpolate(v, vars)]));
  if (Object.values(headers).some(v => /[\r\n\x00]/.test(v))) problem('headers', 'A template produced an invalid header.');
  return { method: request.method, url: target(interpolate(request.path, vars, true), query), headers,
    body: interpolate(request.body, vars), vars };
}
function checkResponse(request, status, body, vars) {
  const checks = [{ label: `HTTP ${request.expectedStatuses.join(' or ')}`, passed: request.expectedStatuses.includes(status) }];
  let json;
  try { json = JSON.parse(body); } catch { json = undefined; }
  for (const a of request.assertions) {
    let value = json;
    for (const key of a.path.split('.')) value = value != null && Object.hasOwn(Object(value), key) ? value[key] : undefined;
    const expected = typeof a.value === 'string' ? interpolate(a.value, vars) : a.value;
    const passed = a.operator === 'exists' ? value !== undefined : a.operator === 'eq' ? value !== undefined && String(value) === String(expected) : value != null && String(value).includes(String(expected));
    checks.push({ label: `${a.path} ${a.operator}${a.operator === 'exists' ? '' : ` ${expected}`}`, passed });
  }
  return checks;
}
function redact(value) {
  if (typeof value === 'string') return value.replace(TOKEN, '[redacted]');
  if (Array.isArray(value)) return value.map(redact);
  if (object(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, SECRET.test(k) ? '[redacted]' : redact(v)]));
  return value;
}
function responseHeaders(headers) {
  return redact(Object.fromEntries([...headers.entries()].map(([k, v]) => [k, String(v).slice(0, 4096)])));
}
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  return object(value) ? Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])])) : value;
}
function fingerprint(scenario, dataset) {
  const { name, id, metrics, ...workload } = scenario;
  workload.requests = workload.requests.filter(r => r.enabled).map(({ name: n, id: i, enabled, ...request }) => request);
  return crypto.createHash('sha256').update(JSON.stringify(canonical({ app: APP_URL, workload, dataset }))).digest('hex');
}
module.exports = { normalize, materialize, checkResponse, redact, responseHeaders, fingerprint, target, METRICS, ID };

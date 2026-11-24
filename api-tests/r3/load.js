// Requirement 3: one load test for any GET endpoint. The same script is run before and after every change.
//
//   k6 run -e URL_PATH="/products?page=1&pageSize=12" api-tests/r3/load.js
//   k6 run -e URL_PATH="/orders?page=10000&pageSize=10" -e TOKEN=$adminToken api-tests/r3/load.js
//   k6 run -e URL_PATH="/products/<id>" -e ETAG='W/"..."' api-tests/r3/load.js
//
// Optional: RATE (requests per second, default 50), DURATION (default 30s), BASE (default http://localhost:8080/api/v1).
import http from 'k6/http';
import { check } from 'k6';

const base = __ENV.BASE || 'http://localhost:8080/api/v1';
const path = __ENV.URL_PATH;
if (!path) throw new Error('Set URL_PATH, for example -e URL_PATH="/products?page=1&pageSize=12"');

const headers = {};
if (__ENV.TOKEN) headers.Authorization = `Bearer ${__ENV.TOKEN}`;
if (__ENV.ETAG) headers['If-None-Match'] = __ENV.ETAG;

export const options = {
  scenarios: {
    load: {
      // A fixed number of requests per second, whatever the server does. So "before" and "after"
      // get exactly the same work, and a slow server shows up as a high latency, not as fewer requests.
      executor: 'constant-arrival-rate',
      rate: Number(__ENV.RATE || 50),
      timeUnit: '1s',
      duration: __ENV.DURATION || '30s',
      preAllocatedVUs: 50,
      maxVUs: 300,
    },
  },
  // Print exactly the numbers of the professor's table: p50 (= med), p95, p99.
  summaryTrendStats: ['med', 'p(95)', 'p(99)', 'max'],
};

export default function () {
  const res = http.get(base + path, { headers });
  // 200 = full answer; 304 = "not modified" (the ETag step). Anything else is an error.
  check(res, { 'status is 200 or 304': (r) => r.status === 200 || r.status === 304 });
}

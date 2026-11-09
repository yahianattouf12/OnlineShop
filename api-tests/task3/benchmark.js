import http from 'k6/http';
import { check } from 'k6';
import { Counter } from 'k6/metrics';

const caseName = __ENV.TASK3_CASE;
const orders = {
  'orders-first': { page: 1, total: 200000, role: 'admin' },
  'orders-deep': { page: 10000, total: 200000, role: 'admin' },
  'orders-customer': { page: 1, total: 4000, role: 'customer' },
}[caseName];
const productCase = caseName === 'product-hot' || caseName === 'product-etag';
if (!orders && !productCase) throw new Error('Select a Task 3 benchmark case with run.mjs.');

// The benchmark service (benchmark/) runs this script inside Docker and sets the API address; the CLI uses localhost.
const baseUrl = __ENV.TASK3_BASE_URL || 'http://localhost:8080/api/v1';
const pageSize = 10;
const productId = __ENV.PRODUCT_ID;
const customerId = __ENV.TASK3_CUSTOMER_ID;
const token = (orders?.role === 'customer' ? __ENV.CUSTOMER_TOKEN : __ENV.ORDERS_TOKEN)?.trim();
if (orders && !/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+){2}$/.test(token ?? '')) {
  throw new Error('Set the order case token to the accessToken value only.');
}
if (orders?.role === 'customer' && !customerId) throw new Error('Run the customer case through run.mjs.');
if (productCase && !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(productId ?? '')) {
  throw new Error('Set PRODUCT_ID to the UUID printed by the benchmark seeder.');
}

const expectedStatus = caseName === 'product-etag' && __ENV.TASK3_ETAG_REQUIRED === '1' ? 304 : 200;
const url = orders
  ? baseUrl + '/orders?page=' + orders.page + '&pageSize=' + pageSize
  : baseUrl + '/products/' + productId;
const headers = orders ? { Authorization: 'Bearer ' + token } : {};
if (caseName === 'product-etag') {
  headers['If-None-Match'] = __ENV.TASK3_ETAG_VALUE || '"task3-before-etag"';
}

const rate = 20;
const duration = __ENV.TASK3_DURATION || '60s';
const preAllocatedVUs = 20;
const status200 = new Counter('task3_status_200');
const status304 = new Counter('task3_status_304');
http.setResponseCallback(http.expectedStatuses(expectedStatus));

export const options = {
  scenarios: {
    task3: { executor: 'constant-arrival-rate', rate, timeUnit: '1s', duration, preAllocatedVUs },
  },
  summaryTrendStats: ['med', 'p(95)', 'p(99)'],
  thresholds: {
    checks: ['rate==1'],
    http_req_failed: ['rate==0'],
    dropped_iterations: ['count==0'],
  },
};

export default function () {
  const response = http.get(url, { headers, redirects: 0 });
  status200.add(response.status === 200 ? 1 : 0);
  status304.add(response.status === 304 ? 1 : 0);

  check(response, {
    'response matches the benchmark case': (res) => {
      if (res.status !== expectedStatus) return false;
      if (expectedStatus === 304) return res.body === '' || res.body === null;

      let body;
      try {
        body = res.json();
      } catch {
        return false;
      }
      if (productCase) return body?.id === productId && body.stock === 100;
      return body?.page === orders.page && body.pageSize === pageSize &&
        body.totalCount === orders.total && Array.isArray(body.items) && body.items.length === pageSize &&
        (orders.role !== 'customer' || body.items.every((item) => item.userId === customerId));
    },
  });
}

export function handleSummary(data) {
  const values = (metric) => data.metrics[metric]?.values ?? {};
  const latency = values('http_req_duration');
  const requests = values('http_reqs');
  const metrics = {
    p50: latency.med ?? null,
    p95: latency['p(95)'] ?? null,
    p99: latency['p(99)'] ?? null,
    requests: requests.count ?? 0,
    requestsPerSecond: requests.rate ?? 0,
    failedRate: values('http_req_failed').rate ?? null,
    checkRate: values('checks').rate ?? null,
    dropped: values('dropped_iterations').count ?? 0,
    bytesReceived: values('data_received').count ?? 0,
    status200: values('task3_status_200').count ?? 0,
    status304: values('task3_status_304').count ?? 0,
  };
  const summary = {
    case: caseName,
    workload: {
      url, rate, duration, preAllocatedVUs, warmup: __ENV.TASK3_WARMUP || '15s',
      role: orders?.role ?? 'anonymous',
      customerId: orders?.role === 'customer' ? customerId : null,
      expectedOrders: orders?.total ?? null,
      expectedStock: productCase ? 100 : null,
    },
    expectedStatus,
    metrics,
  };
  const output = {
    stdout: caseName + '\n' + JSON.stringify(summary, null, 2) + '\n',
  };
  if (__ENV.TASK3_SUMMARY_FILE) {
    output[__ENV.TASK3_SUMMARY_FILE] = JSON.stringify(summary, null, 2) + '\n';
  }
  return output;
}

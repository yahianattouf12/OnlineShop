const path = require('node:path');

// Where things are. Inside Docker the shop API is reached by its service name, never through localhost.
const APP_URL = (process.env.APP_URL ?? 'http://app:8080').replace(/\/+$/, '');
const API = `${APP_URL}/api/v1`;
const RESULTS_DIR = process.env.RESULTS_DIR ?? '/results';
const TASK3_DIR = process.env.TASK3_DIR ?? path.join(__dirname, '..', '..', 'api-tests', 'task3');
const K6_BIN = process.env.K6_BIN ?? 'k6';
const PORT = Number(process.env.PORT ?? 8090);

// The fixtures benchmark.js checks on every response. They come from seed/benchmark-all.mjs 200000.
const DATASET = {
  orders: 200000,
  customerOrders: 4000,
  productStock: 100,
  productName: 'Studio Headphones',
  customerEmail: 'benchmark-customer@example.invalid',
};

// The same five workloads as api-tests/task3/benchmark.js, described for people.
const CASES = [
  {
    id: 'orders-first',
    title: 'Admin order list, page 1',
    request: 'GET /api/v1/orders?page=1&pageSize=10',
    role: 'admin',
    layer: 'Database',
    measures: 'The reference read, and the workload to route to the read replica.',
  },
  {
    id: 'orders-deep',
    title: 'Admin order list, page 10,000',
    request: 'GET /api/v1/orders?page=10000&pageSize=10',
    role: 'admin',
    layer: 'Database',
    measures: 'The query skips 99,990 rows. Compare it after an index or query change.',
  },
  {
    id: 'orders-customer',
    title: 'The benchmark customer’s first page',
    request: 'GET /api/v1/orders?page=1&pageSize=10',
    role: 'customer',
    layer: 'Database',
    measures: 'An owner-filtered read: 4,000 matching orders, and every item checked to belong to the customer.',
  },
  {
    id: 'product-hot',
    title: 'The same product, again and again',
    request: 'GET /api/v1/products/{id}',
    role: 'anonymous',
    layer: 'Server cache (Redis)',
    measures: 'Repeated reads of one product: what Redis should speed up. Still expects 200 and the live stock.',
  },
  {
    id: 'product-etag',
    title: 'Conditional GET of that product',
    request: 'GET /api/v1/products/{id} with If-None-Match',
    role: 'anonymous',
    layer: 'HTTP cache (ETag)',
    measures: 'A full 200 before ETags. After them, with the matching tag: 304 and an empty body.',
  },
];

// Every run uses the same fixed rate (20 requests per second, set in benchmark.js); only the length changes.
// Results are compared only when their workloads are identical, so a quick run never compares with a standard one.
const PROFILES = {
  standard: { warmup: '15s', duration: '60s', seconds: 75 },
  quick: { warmup: '5s', duration: '20s', seconds: 25 },
};

const LABEL = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,39}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

module.exports = { APP_URL, API, RESULTS_DIR, TASK3_DIR, K6_BIN, PORT, DATASET, CASES, PROFILES, LABEL, UUID };

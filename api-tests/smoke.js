import http from 'k6/http';
import { check, sleep } from 'k6';

// Run from the project folder: k6 run .\api-tests\smoke.js
const baseUrl = (__ENV.BASE_URL || 'http://localhost:8080').replace(/\/+$/, '');

export const options = {
  vus: 1,
  duration: '10s',
  summaryTrendStats: ['med', 'p(95)', 'p(99)'],
  thresholds: { checks: ['rate==1'] },
};

export default function () {
  const response = http.get(`${baseUrl}/api/v1/products?page=1&pageSize=10`, { redirects: 0 });
  check(response, { 'product list returns HTTP 200': (res) => res.status === 200 });
  sleep(1);
}

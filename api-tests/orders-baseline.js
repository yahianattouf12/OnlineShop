import http from 'k6/http';
import { check } from 'k6';

const token = __ENV.ORDERS_TOKEN;
if (!token) throw new Error('Set ORDERS_TOKEN to your admin accessToken.');

export const options = {
  scenarios: {
    orders: {
      executor: 'constant-arrival-rate',
      rate: 20,
      timeUnit: '1s',
      duration: __ENV.DURATION || '60s',
      preAllocatedVUs: 20,
    },
  },
  summaryTrendStats: ['med', 'p(95)', 'p(99)'],
  thresholds: {
    checks: ['rate==1'],
    dropped_iterations: ['count==0'],
  },
};

export default function () {
  const response = http.get('http://localhost:8080/api/v1/orders?page=1&pageSize=10', {
    headers: { Authorization: `Bearer ${token}` },
    redirects: 0,
  });
  check(response, {
    'admin sees 200,000 orders': (res) => res.status === 200 && res.json('totalCount') === 200000,
  });
}

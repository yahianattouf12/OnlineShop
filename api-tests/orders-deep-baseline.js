import http from 'k6/http';
import { check } from 'k6';

const page = 10000;
const pageSize = 10;
const token = __ENV.ORDERS_TOKEN?.trim();
if (!token) throw new Error('Set ORDERS_TOKEN to your admin accessToken.');
if (!/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+){2}$/.test(token)) {
  throw new Error('Set ORDERS_TOKEN to the accessToken value only, without quotes or Bearer.');
}

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
  const response = http.get(`http://localhost:8080/api/v1/orders?page=${page}&pageSize=${pageSize}`, {
    headers: { Authorization: `Bearer ${token}` },
    redirects: 0,
  });
  check(response, {
    'admin receives page 10000 of 200,000 orders': (res) => {
      if (res.status !== 200) return false;

      const body = res.json();
      return body?.page === page && body.pageSize === pageSize &&
        body.totalCount === 200000 && body.items?.length === pageSize;
    },
  });
}

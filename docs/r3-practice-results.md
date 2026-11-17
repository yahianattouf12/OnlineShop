# Requirement 3: practice results

How we measure: `api-tests/r3/load.js` with k6, constant arrival rate of 50 requests/second for 30 s
(about 1,500 requests per run). Every command runs twice; only the second run (after the warm-up) is written here.
Data: 200,000 orders (400,000 items); the test customer owns 4,000 of them.

## D2. Before (no fixes yet)

| Endpoint | p50 | p95 | p99 | max | req/s | Failed | Dropped |
|---|---|---|---|---|---|---|---|
| `GET /products?page=1&pageSize=12` | 2.93 ms | 9.97 ms | 11.16 ms | 14.54 ms | 50.0 | 0 | 0 |
| `GET /products/{id}` | 3.90 ms | 13.29 ms | 14.84 ms | 23.78 ms | 50.0 | 0 | 0 |
| `GET /orders?page=1&pageSize=10` (admin) | 10.88 ms | 18.03 ms | 32.28 ms | 39.62 ms | 50.0 | 0 | 0 |
| **`GET /orders?page=10000&pageSize=10` (admin)** | **12.03 s** | **16.19 s** | **16.81 s** | **17.56 s** | **19.5** | 0 | **662** |
| `GET /orders?page=1&pageSize=10` (customer) | 4.08 ms | 13.42 ms | 15.25 ms | 17.59 ms | 50.0 | 0 | 0 |

**What we see:**

- Every endpoint keeps up with 50 requests/second and answers in a few milliseconds, except one.
- The admin order list, page 10,000, is about 1,100 times slower than page 1 (p50 12 s vs 10.9 ms).
  The server finished only 839 requests (19.5/s); k6 dropped 662 more, because all 300 virtual users
  were waiting for answers (`WARN Insufficient VUs, reached 300 active VUs`).
- No request failed: the deep page is not broken, it is just far too slow. Requests pile up in a queue,
  so each one waits 12 to 17 s.
- Next step (D3): find out why with `EXPLAIN ANALYZE`.

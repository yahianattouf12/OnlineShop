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

## D4. Fix 1: pick the page first, then count its items

EF used to put the item count inside the `LIMIT/OFFSET` query, so PostgreSQL counted the items of all
100,000 orders it walked past (`SubPlan loops=100000`). Now `Skip/Take` come before `Select`: the page is
picked in an inner query and the count runs only for its 10 orders (`SubPlan loops=10`).

| Endpoint | p50 | p95 | p99 | max | req/s | Failed | Dropped |
|---|---|---|---|---|---|---|---|
| **`GET /orders?page=10000&pageSize=10` (admin)** | **69.63 ms** | **139.44 ms** | **213.95 ms** | 312.53 ms | **49.9** | 0 | **0** |
| `GET /orders?page=1&pageSize=10` (admin) | 10.92 ms | 19.20 ms | 31.98 ms | 36.40 ms | 50.0 | 0 | 0 |

- The deep page: p50 12.03 s → 69.6 ms (about 170 times faster), and nothing is dropped any more.
- Page 1 did not change: it was never the problem.

## D5. Fix 2: an index in the exact order of the list, `(CreatedAt DESC, Id)`

The list is sorted by `CreatedAt DESC, Id`, but the old index was on `CreatedAt` only. So PostgreSQL still
sorted, by `Id`, every group of orders with the same `CreatedAt` (`Incremental Sort` over 100,000 rows).
New index in `OrdersDbContext` + migration `AddOrdersCreatedAtIdIndex`:
`CREATE INDEX "IX_Orders_CreatedAt_Id" ON orders."Orders" ("CreatedAt" DESC, "Id")`.

EXPLAIN ANALYZE of the page query, page 10,000 (`api-tests/r3/explain-admin-orders.sql`):

| | Plan | Execution time |
|---|---|---|
| Without the index | `Index Scan Backward (IX_Orders_CreatedAt)` → **`Incremental Sort`** (100,000 rows) → `Limit` | 79.6 ms |
| With the index | `Index Scan (IX_Orders_CreatedAt_Id)` → `Limit`, **no sort at all** | 39.4 ms |

k6, 50 requests/second:

| Endpoint | p50 | p95 | p99 | max | req/s | Failed | Dropped |
|---|---|---|---|---|---|---|---|
| **`GET /orders?page=10000&pageSize=10` (admin)** | **51.39 ms** | **70.88 ms** | **86.20 ms** | 116.69 ms | 49.9 | 0 | 0 |
| `GET /orders?page=1&pageSize=10` (admin) | 10.96 ms | 23.41 ms | 34.13 ms | 51.99 ms | 50.0 | 0 | 0 |

- The deep page: 69.6 ms → 51.4 ms p50, and p99 214 ms → 86 ms (the slow cases improved the most).
- Still left: `OFFSET 99990` must walk 100,000 index entries to skip them. The real fix is keyset
  pagination ("10 orders older than this one"), but it changes the API, so it is future work.
- Price of the index: every new order also writes into it, and it takes disk and memory.

## Demo: the old query and the new one side by side

`GET /orders/legacy` (admin, Development only) runs the order list exactly as it was before D4.
Same answer as `GET /orders` (same 10 orders, same total), only the query is different.

| Endpoint (page 10,000) | Rate | p50 | p95 | p99 | Failed | Dropped |
|---|---|---|---|---|---|---|
| `/orders/legacy` (old) | 50/s | 7.21 s | 14.09 s | 17.00 s | **408 of 1,070 (38%)** | 431 |
| `/orders` (new) | 50/s | 51.39 ms | 70.88 ms | 86.20 ms | 0 | 0 |
| `/orders/legacy` (old) | 5/s | 239.4 ms | 303.4 ms | 327.7 ms | 0 | 0 |
| `/orders` (new) | 5/s | 56.97 ms | 76.94 ms | 85.33 ms | 0 | 0 |

- At 50/s the old query does not just get slow, it breaks things: the slow requests hold every PostgreSQL
  connection (`max_connections = 100`), so new requests fail with `sorry, too many clients already`.
  One slow query can take the whole shop down. (After this test: `docker compose restart app`.)
- The old query is faster here than in D2 (it also uses the new index, so it has no sort any more),
  but it still counts the items of 100,000 orders per request.

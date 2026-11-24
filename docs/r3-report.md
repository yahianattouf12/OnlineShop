# Requirement 3: Performance & Caching, results

Machine: one Windows PC, Docker Desktop, the app, PostgreSQL 17, Redis and the replica all on it.
Tool: k6 (`api-tests/r3/load.js`), constant arrival rate of 50 requests/second for 30 s, after a warm-up run.
Data: 200,000 orders with 400,000 items (`seed/r3-orders.sql`), 20,012 products (`seed/r3-products.sql`).
Every step, with all the raw numbers: [`docs/r3-practice-results.md`](r3-practice-results.md).

## How to run it

```powershell
# data (once)
# (register customer@test.local first: it gets some of the fake orders)
Get-Content -Raw seed/r3-orders.sql   | docker compose exec -T app-db psql -U admin -d db_online_shop -v count=200000 -v customer=customer@test.local -f -
Get-Content -Raw seed/r3-products.sql | docker compose exec -T app-db psql -U admin -d db_online_shop -v count=20000 -f -

# everything on: Redis (docker-compose.cache.yml) + read replica (docker-compose.replica.yml)
docker compose -f docker-compose.yml -f docker-compose.cache.yml -f docker-compose.replica.yml up -d --build

# a load test of any GET endpoint
k6 run -e URL_PATH="/orders?page=10000&pageSize=10" -e TOKEN=$adminToken api-tests/r3/load.js
```

Plain `docker compose up` still works: without the override files there is no Redis and no replica, and the
app simply reads the primary database.

## 1. Before and after (50 requests/second)

| Endpoint | p50 before | p50 after | p95 before | p95 after | p99 before | p99 after | req/s before → after |
|---|---|---|---|---|---|---|---|
| `GET /products?page=1&pageSize=12` | 4.11 ms | 2.52 ms | 6.98 ms | 4.52 ms | 16.32 ms | 10.43 ms | 50 → 50 |
| `GET /products/{id}` | 3.96 ms | 3.86 ms | 7.91 ms | 6.36 ms | 14.80 ms | 14.50 ms | 50 → 50 |
| `GET /orders?page=1&pageSize=10` (admin) | 10.88 ms | 11.23 ms | 18.03 ms | 14.88 ms | 32.28 ms | 20.83 ms | 50 → 50 |
| **`GET /orders?page=10000&pageSize=10` (admin)** | **12.03 s** | **57.03 ms** | **16.19 s** | **70.18 ms** | **16.81 s** | **90.17 ms** | **19.5 → 50** |
| `GET /orders?page=1&pageSize=10` (customer) | 4.08 ms | 4.08 ms | 13.42 ms | 6.13 ms | 15.25 ms | 15.70 ms | 50 → 50 |

"Before" for the products is with 20,012 products and no Redis. Before the fixes, k6 had to drop 662 of the
1,501 requests to the deep page (all 300 virtual users were waiting); after, none.

## 2. Database: the admin order list (EXPLAIN ANALYZE)

**Found:** EF put the item count (`SELECT count(*) FROM "OrderItems"`) inside the `LIMIT/OFFSET` query, so
for page 10,000 PostgreSQL counted the items of all 100,000 orders it walked past (`SubPlan loops=100000`),
plus an `Incremental Sort`, because the only index was on `CreatedAt` and the list is sorted by `CreatedAt DESC, Id`.

| Step | Deep page p50 (k6) | What changed in the plan |
|---|---|---|
| Before | 12.03 s | `SubPlan loops=100000` + `Incremental Sort` (one request alone: about 1.4 s) |
| Fix 1: pick the page first, then count (`OrdersService.ListAsync`) | 69.6 ms | `SubPlan loops=10` |
| Fix 2: index `(CreatedAt DESC, Id)` (migration `AddOrdersCreatedAtIdIndex`) | 51.4 ms | no sort at all; 79.6 ms → 39.4 ms in EXPLAIN |

`api-tests/r3/explain-admin-orders.sql` shows the plan without and with the index (it drops the index inside
a transaction and rolls back). Still left: `OFFSET` walks 100,000 index entries; keyset pagination
("10 orders older than this one") would remove that, but it changes the API.
The price of an index: every insert also writes into it, and it takes disk and memory.

## 3. N+1

The order list is one query with a projection: **2 SQL queries** per request (count + page) for any page size.
The N+1 version written on purpose (1 query per order) made **52 queries** for 50 orders and was about
3 times slower (p50 33.2 ms vs 11.7 ms), although each query was fast: the round trips add up.

## 4. Redis (cache-aside)

- Cached: the product list pages and the product details, 60 s TTL. Not cached: the stock (it must be exact),
  personal data (orders, notifications), anything about login.
- On create/edit: delete the details key and start a new list "generation" (no slow key scans).
- Every product response says how it was answered: `X-Cache: HIT` (Redis), `MISS` (database, now cached) or
  `BYPASS` (Redis off or paused). The website's Performance checks show it on every request.
- Lists about 1.6 times faster (4.11 → 2.54 ms p50); product details barely change, because their slow part
  is the gRPC stock call, which is never cached. After the tests: 15,000 hits, 11 misses.
- Redis down: the shop keeps working from the database. At first every request waited for the Redis
  timeouts (about 3 s); now, after one error, reads skip Redis for 30 s: 1.4 s once, then 8 to 14 ms.

## 5. HTTP ETag

`GET /products/{id}` sends `ETag: W/"<SHA-256 of the JSON>"` and `Cache-Control: no-cache`; the same ETag in
`If-None-Match` gives `304 Not Modified` with no body. Same latency (3.66 vs 3.59 ms p50), but the data
received for 1,500 requests went from 1.1 MB to 483 kB: ETag saves the network, Redis saves the database.

## 6. Read replica

`app-db-replica` follows `app-db` with streaming replication (async). Only the admin's list of all orders is
read from it; the customer's own list, order details and all writes use the primary (read-your-own-writes).
Proof with the replica paused (`api-tests/r3/proof-replica.mjs`):

```
1. customer placed order ee7cd535
2. customer's own list (primary):  sees the new order? true
3. admin's list (replica):        total 200000 -> 200000
PROOF OK: the replica is behind (paused), the admin list does not have the order yet, but the customer sees it.
```

## 7. An edit shows at once (`api-tests/r3/proof-edit.mjs`, Redis and ETag on)

```
1. before: price 129, ETag W/"1652F412E40...
2. same ETag again -> 304 (nothing changed, no body)
3. admin PUT new price 130 -> 200
4. old ETag right after the edit -> 200, price 130
5. product list right after the edit -> price 130
PROOF OK: the edit shows at once, in the details and in the list.
```

## 8. What we observed

- A slow query does not only hurt itself. With the old query at 50/s (`GET /orders/legacy`, kept for the demo,
  admin and Development only), the slow requests held all 100 PostgreSQL connections and 38% of the requests
  failed with `sorry, too many clients already`. One slow page can take the whole shop down.
- Product details did not get faster with Redis: the slow part is the live stock call, which must stay live.
- On one PC the replica does not make one query faster; it spreads the reads over two databases.
- A cache must fail fast: without the 30 s pause, a dead Redis made every product request about 3 s slower.

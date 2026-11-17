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

## D6. N+1: measured on purpose (not committed)

The order list is ONE query with a projection (`Select`), plus the total count. To prove there is no N+1,
we count the SQL queries of one request (`Executed DbCommand` in the app log), then write the N+1 version on
purpose for a few minutes (1 query for the page + 1 query per order for its items) and measure it.

| Version (`GET /orders?page=1`, admin) | SQL queries, pageSize 10 | SQL queries, pageSize 50 | p50 (pageSize 50) | p95 | p99 |
|---|---|---|---|---|---|
| Projection (our code) | **2** | **2** | **11.65 ms** | 14.25 ms | 19.79 ms |
| N+1 (on purpose) | 12 | **52** | 33.18 ms | 42.03 ms | 60.62 ms |

- With the projection the number of queries does not grow with the page size: no N+1.
- The N+1 version makes 2 + N queries and is about 3 times slower, although every single query is fast:
  each query is a round trip to the database, and the round trips add up.
- D3 also found an N+1 hidden inside ONE SQL query (the item count ran 100,000 times); D4 fixed it.

## D7. Redis: cache-aside for the product list and the product details

`ProductsService`: look in Redis first; on a miss read the database and keep a copy for 60 s (TTL).
On create/edit: delete the product's details key and start a new list "generation" (all old list keys are
never read again). The stock is never cached. Turn Redis on with `docker-compose.cache.yml`.
Data: 20,012 products (`seed/r3-products.sql`). Same code with and without Redis.

| Endpoint | p50 no Redis | p50 Redis | p95 no Redis | p95 Redis | p99 no Redis | p99 Redis |
|---|---|---|---|---|---|---|
| `GET /products?page=1&pageSize=12` | 4.11 ms | **2.54 ms** | 6.98 ms | 5.62 ms | 16.32 ms | 10.47 ms |
| `GET /products?category=bulk-3&page=50&pageSize=12` | 3.86 ms | **2.49 ms** | 8.57 ms | 8.49 ms | 15.26 ms | 10.14 ms |
| `GET /products/{id}` | 3.96 ms | 3.78 ms | 7.91 ms | 6.53 ms | 14.80 ms | 12.61 ms |

- The lists are about 1.6 times faster: a hit skips both SQL queries (the `count(*)` and the page).
- The product details barely change: the slow part is the gRPC call for the stock, and the stock must not be cached.
- Inside Redis: `shop:products:list:generation`, `shop:products:list:<generation>:all:1:12`, `shop:products:details:<id>`,
  `TTL` counting down from 60. After the tests: **15,000 hits, 11 misses** (15,000 reads that did not touch PostgreSQL).
- Our database is small and on the same PC, so it is already fast; with a real network between app and
  database, every skipped query would save more.

**Redis down** (`docker compose stop redis`): the shop keeps working from the database.

| | Request 1 | Requests 2 to 5 |
|---|---|---|
| First version: every read waits for the Redis timeouts | 3,887 ms | about 3,000 ms each |
| With the 30 s pause after a Redis error ("circuit breaker") | 1,391 ms | **8 to 14 ms** |

After Redis is back and the 30 s pause ends, the app uses Redis again by itself.

## D8. HTTP ETag: 304 Not Modified on `GET /products/{id}`

The ETag is a SHA-256 of the answer's JSON (`W/"<hash>"`), sent with `Cache-Control: no-cache`
("keep it, but ask me before you use it again"). A client that sends the same ETag in `If-None-Match`
gets `304 Not Modified` with no body. The stock is part of the JSON, so a sale also gives a new ETag.

```
GET /products/{id}                              -> HTTP/1.1 200 OK, ETag: W/"1652F412...", Cache-Control: no-cache
GET /products/{id}  If-None-Match: W/"1652F412..." -> HTTP/1.1 304 Not Modified
```

| `GET /products/{id}`, 1,500 requests | p50 | p95 | p99 | Data received |
|---|---|---|---|---|
| Always 200 (no ETag sent) | 3.66 ms | 7.28 ms | 13.41 ms | 1.1 MB |
| With the ETag → 304 | 3.59 ms | 7.77 ms | 13.29 ms | **483 kB** |

- Same time: the server still builds the answer to compute its hash. What we save is the network:
  no body is sent (what is left is only the headers). Bigger answers save more. This matters for phones and
  slow connections; Redis is what saves work on the database.

## D9. Editing a product shows at once (despite Redis and the ETag)

New `PUT /api/v1/products/{id}` (admin): saves, then deletes the product's details key in Redis and starts a
new list generation. Proof (`node api-tests/r3/proof-edit.mjs`, Redis on):

```
1. before: price 129, ETag W/"1652F412E40...
2. same ETag again -> 304 (nothing changed, no body)
3. admin PUT new price 130 -> 200
4. old ETag right after the edit -> 200, price 130
5. product list right after the edit -> price 130

PROOF OK: the edit shows at once, in the details and in the list.
```

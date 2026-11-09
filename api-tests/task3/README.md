# Task 3 benchmark

Run each workload against the same Docker project, on the same machine and with the same fixtures before and after a change. The goal is to see which requests change when you turn on each optimization.

## Or use the dashboard

The website has an admin **Performance** page (`/admin/performance`) for the same workloads. A `benchmark` service runs k6 inside Docker, so you don't need k6 installed. It runs the same `benchmark.js` and `verify.mjs`, and writes the same `task3-results/<label>/<case>.json` files, so `report.mjs` reads them too.

```powershell
docker compose stop                                              # free ports 8080 and 5432 if the normal shop is running
docker compose -p onlineshop-bench --profile benchmark up -d --build
node seed/benchmark-all.mjs 200000                               # once per benchmark volume
```

Open http://localhost:3000, log in as the admin from `.env`, then open **Performance**:

- **Run**: checks the data first (200,000 orders, 4,000 for the customer, stock 100). Then you pick a label, the workloads and the length, and watch each second's p50 and p95 live. Enter the benchmark customer's password once for `orders-customer`.
- **Compare**: shows a baseline label against the others, with a chart and table for each workload. It uses the same rules as `report.mjs` (both runs must pass, with identical workloads), and **Copy as a Markdown table** gives you the numbers for the report.
- **Proofs**: runs `etag-stock` and `read-after-write`. The second one places a real order, so run it last.
- **History**: lists every run, with its per-second timelines.

The service's API is at `http://localhost:8090/benchmark-api/v1` (and `/benchmark-api/v1` through the website). It accepts the shop's admin token. `GET /benchmark-api/v1` lists every route, and [`api-tests/7-benchmark.http`](../7-benchmark.http) has ready requests.

Dashboard runs call the API inside Docker (`http://app:8080`), while CLI runs call `localhost:8080`. Their workloads differ, so the two are never compared with each other. Measure every stage of a comparison from the same place. **Quick** runs (5 s + 20 s) are only for trying things out. Report **Standard** runs (15 s + 60 s, the same as the CLI).

## Seed the benchmark

From the repository root, with Node.js 18+ and k6 2.3+ installed:

```powershell
# Free the ports used by the regular shop if it is running.
docker compose stop app app-db inventory
docker compose -p onlineshop-bench up -d --build app inventory
node seed/benchmark-all.mjs 200000
```

The combined command reuses the catalog and order seeders. It adds the 12 demo products with images, sets the stock of Studio Headphones to 100, and grows the historical order dataset to 200,000. Save the `PRODUCT_ID` printed by the command. On a fresh volume the order seeder also prints the new benchmark customer's local password. Existing accounts keep their passwords. You can pass `100` to check setup on a fresh volume before growing it.

Keep the same volume and product ID for every timed run. The suite checks the expected counts and stock so an accidental write can't silently change the workload. After timing runs, the read-after-write probe will create one extra order and consume one stock unit.

## Run the before measurements

Log in as admin in [Swagger](http://localhost:8080/swagger). Copy the full login response JSON, then run the first line. Log in as `benchmark-customer@example.invalid , PASSWORD: ChooseYourTestPassword123` and copy that login response before running the second line. Paste the UUID printed by the seeder into the third line.

```powershell
$env:ORDERS_TOKEN = (Read-Host "Enter admin accessToken:").Trim()
$env:CUSTOMER_TOKEN = (Read-Host "Enter customer accessToken").Trim()
$env:PRODUCT_ID = '<product UUID>'
```

Start with one case if you want to verify the setup:

```powershell
node api-tests/task3/run.mjs before orders-deep
```

Run the remaining cases under the same label:

```powershell
node api-tests/task3/run.mjs before orders-first orders-customer product-hot product-etag
```

On a fresh label, omitting the cases runs all five. Each case gets a separate 15-second warm-up and a 60-second measurement at 20 requests per second. The output goes to `task3-results/<label>/` as warm-up logs, measured TXT logs and JSON summaries. A completed result cannot be overwritten by another run with the same label and case.

| Case | Request | What it measures |
|---|---|---|
| `orders-first` | Admin order list, page 1 | Reference read and a workload for replica routing |
| `orders-deep` | Admin order list, page 10,000 | The query skips 99,990 rows, so compare its plan and timing after an index or query change |
| `orders-customer` | The benchmark customer's first order page | Owner-filtered read with 4,000 matching orders and an ownership check on all returned items |
| `product-hot` | Repeated unconditional GET of the same stocked product | Redis metadata cache under a workload that still expects HTTP 200 and live stock |
| `product-etag` | Conditional GET of that same product | Full HTTP 200 response before ETags, then HTTP 304 with an empty body when the matching tag is sent |

## Collect evidence for each change

**Query plan and N+1.** Watch EF's SQL with `docker compose -p onlineshop-bench logs -f app`. Make individual order-list calls in Swagger and capture the count and page SELECT with their parameter values. Compare page 1 and page 10,000 using `EXPLAIN (ANALYZE, BUFFERS)` in `docker compose -p onlineshop-bench exec app-db psql -U admin -d db_online_shop`. Save both plans before and after. For the N+1 check, make isolated calls with page sizes 10 and 50 and count the SQL commands per call. The current list is a count plus a projection query. A query count that stays flat as the page grows is evidence against an N+1 on that path.

**Read replica.** Repeat the admin workload routed to the replica with other optimizations held constant. Record evidence that the request actually used the standby, such as API route logs and PostgreSQL standby metrics. After the timing runs, use the order proof below. To demonstrate the consistency guarantee under lag, pause replay on the isolated test standby, confirm replay is paused, run the proof, verify the new ID is still absent on the standby, and resume replay.

**Redis.** Repeat `product-hot` with Redis enabled and verify that repeated requests hit the metadata cache. Record the cache hit evidence, configured expiry, and the TTL you observe. Use an actual metadata edit such as a price change, then make an immediate GET of the warmed product and check the new price. The current API only has a stock edit; the price or other metadata edit proof needs the corresponding route when implemented. Stock still comes from inventory.

**ETag.** After the feature exists, use the `--etag` flag for the conditional case. The runner fetches the current ETag outside the timed run. The before run sends an unmatched validator and expects a full 200; the after run sends the matching validator and requires an empty 304. The separate stock edit proof below checks that a changed representation is immediately visible when the old tag is sent.

Example stage commands to run **after** implementing each change:

```powershell
node api-tests/task3/run.mjs after-index orders-first orders-deep orders-customer
node api-tests/task3/run.mjs after-replica orders-first orders-deep
node api-tests/task3/run.mjs after-redis product-hot product-etag
node api-tests/task3/run.mjs after-etag product-etag --etag
```

Use the relevant preceding label when attributing a change. For example, compare `after-index` to `after-replica` for the replica effect. Compare `after-redis` to `after-etag` to isolate the ETag effect once Redis is already enabled.

## Run the correctness proofs

Run the stock edit probe after ETags are implemented. It restores the original stock quantity.

```powershell
node api-tests/task3/verify.mjs etag-stock 2>&1 | Tee-Object task3-results/etag-stock-proof.txt
```

Run the order proof after your last timed run, or on a separate disposable benchmark volume. It creates a real order and immediately checks both customer reads without a sleep or retry.

```powershell
node api-tests/task3/verify.mjs read-after-write 2>&1 | Tee-Object task3-results/read-after-write-proof.txt
```

## Save the comparison report

```powershell
node api-tests/task3/report.mjs before after-index after-replica after-redis after-etag
```

Open `task3-results/report.txt`. It includes p50, p95, p99, request rate, errors, dropped iterations, HTTP status counts, and bytes received per request. Missing or failed runs stay visible without a calculated speedup. Add the SQL plans, replica routing proof, Redis hit and edit evidence, ETag proof, and observations under load such as Docker CPU and memory. Run the reporter with a different first label for an isolated stage comparison; copy the generated report before generating another one if you want to keep both.

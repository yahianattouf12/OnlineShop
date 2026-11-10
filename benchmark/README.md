# Performance test studio

The website's **Performance → Test studio** runs configurable k6 tests through the benchmark service. Log in to the shop as an admin. The earlier five Task 3 workloads and their saved results remain available under the preset tabs.

Start the dedicated local benchmark stack after rebuilding these changes:

```powershell
docker compose -p onlineshop-bench --profile benchmark up -d --build
```

Open `http://localhost:3000/admin/performance`. Stop another OnlineShop stack first if it already owns the same ports.

## A repeatable experiment

1. Prepare test data in the studio, or use data already in the database. Fixture preparation is available only for the `onlineshop-bench` project. It manages its own records; existing demo and customer records are kept.
2. Choose a request example or create a scenario. Add requests, enable the ones to run, set parameters, headers, bodies and expected responses. Preview one request to inspect the actual status, headers, body and checks.
3. Set the load, warm-up and success thresholds. Give the run a label such as `before`, and record the application commit or optimization in its source note.
4. Run and monitor. Warm-up traffic is separate from measured traffic. Open HTTP exchanges to inspect each measured request's status and response headers.
5. Change the application or database, rebuild the changed services, and repeat the saved configuration under a new label such as `after-index`.
6. Compare saved runs and export the text report. Different workloads are explained instead of being reported as a speedup. Saved runs retain their configuration even when the reusable scenario is edited.

Labels describe a run; they do not change source code or switch optimizations. To reproduce an old run, restore its application version and database/index configuration too. Source notes are entered by the user, not automatic proof of the running image version.

## Load and request data

- **Iterations:** an exact total number of scenario iterations, shared across concurrent virtual users. One iteration executes every enabled request in order. With three requests and 100 iterations, the planned measured total is 300 requests per repetition.
- **Duration:** concurrent users repeat the scenario for the selected time. A slow API lowers the achieved throughput.
- **Arrival rate:** schedule scenario iterations per second for the selected time. With three enabled requests and a rate of ten, the nominal offered load is 30 requests per second. Insufficient concurrent users cause dropped iterations, which remain visible.
- **Repetitions:** repeat the whole test for multiple measurements. Each repetition has its own warm-up. Request pauses and request timeouts can make an iteration longer than the nominal duration.
- **Rows and ranges:** substitute `{{name}}` values in request inputs. Rows and numeric ranges cycle deterministically by iteration so the workload can be repeated. An unresolved variable is an error, not a literal value silently sent to the API.

The configured API is the target; request paths are relative to its `/api` routes. Redirects are disabled. Roles reuse the current admin session or the benchmark customer's session. Credentials are not saved in scenarios or result files. Stateful request bodies may change the database; the studio asks you to acknowledge writes before executing them.

Large database fixtures are prepared before a timed run, not through thousands of timed setup requests. The fixture manifest distinguishes owned fixture counts from total database counts. Shrinking a fixture does not remove unrelated records.

## Reading the measurements

`p50`, `p95` and `p99` are response-time percentiles in milliseconds, not page numbers. Throughput is completed HTTP requests per second. Error rate covers unexpected HTTP results and transport errors; assertion checks separately test response content. Dropped iterations mean scheduled scenario work did not start.

Monitoring reports **the API process's** CPU and memory, plus PostgreSQL database counters. It does not claim to measure the whole laptop or every container. Missing collectors appear as unavailable rather than zero. Database counters cover activity in that database, including monitoring and other connected clients; they are not individual query execution plans. Monitoring and per-request recording add overhead, so keep their settings and the runner consistent between stages.

The studio collects status and response headers for measured HTTP exchanges. Authentication and cookie headers are hidden. Request bodies and full response bodies are not stored for every load-test request; the single-request inspector displays a bounded response body.

## API and checks

`GET http://localhost:8090/benchmark-api/v1` lists the routes. Studio routes are under `/benchmark-api/v1/lab`; authenticated routes use the shop admin's Bearer token. Scenarios, run configurations, HTTP exchanges and monitoring history persist under `task3-results/.lab`; the existing Task 3 files keep their original layout.

From `benchmark/`, run `npm test` for backend validation. From `web/`, run `npm run build` for frontend type and production-build checks. The generic load script is `api-tests/task3/custom.js`; the server supplies its validated configuration, so editing JavaScript is not necessary for each experiment.

Executor behavior follows the [k6 scenario executors](https://grafana.com/docs/k6/latest/using-k6/scenarios/executors/). Database counters follow [PostgreSQL's statistics documentation](https://www.postgresql.org/docs/17/monitoring-stats.html).

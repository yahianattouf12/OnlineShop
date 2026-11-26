# API tests: Requirements 1 to 4

Ready requests that cover everything in Requirement 1, in two forms (Requirement 2 has [its own section](#requirement-2-the-inventory-service), Requirement 4 [too](#requirement-4-queues-and-live-updates); Requirement 3 is in `r3/`). The Requirement 1 and 2 files are in `r1-r2/`, the later ones in `r3/` and `r4/`:

- **`.http` files** for the VS Code **REST Client** extension: the quickest for a live demo. Click **Send Request** above each request.
- **A Postman collection** with automatic checks: run it once to prove everything is green.

## Files

| File | What it is |
|---|---|
| `r1-r2/0-api-rules.http` | Swagger/OpenAPI, the unified error format, the security headers |
| `r1-r2/1-users-auth.http` | Register, login (JWT), the two roles |
| `r1-r2/2-products.http` | Add a product with its image, list, filter by category, pagination |
| `r1-r2/3-orders.http` | Create, view, change status, and the **two proofs** (⭐) |
| `r1-r2/4-notifications.http` | Notified on order and status change, own notifications only (⭐), unread count, mark as read |
| `r1-r2/5-rate-limit.http` | Brute-force protection on login (429) |
| `r1-r2/6-inventory.http` | Requirement 2: stock in product details, all-or-nothing reservation (409), what the user sees when inventory is down (⭐) |
| `r1-r2/race-last-unit.mjs` | Requirement 2 proof (⭐): many orders at the same moment for the last unit, exactly one succeeds. Run: `node api-tests/r1-r2/race-last-unit.mjs` |
| `r4/proof-worker.mjs` | Requirement 4 proof 1 (⭐): stops the email worker, places 3 orders, starts it again; all 3 emails are sent. Run: `node api-tests/r4/proof-worker.mjs` |
| `r4/proof-realtime.mjs` | Requirement 4 proofs 2 and 3 (⭐): a new order reaches the admin at once, the admin's approval reaches the customer at once, and strangers cannot join the channels. Run: `node api-tests/r4/proof-realtime.mjs` |
| `r4/r4-demo-commands.txt` | Requirement 4: the commands for the demos by hand (worker down, wrong mail password, RabbitMQ down, Soketi down) |
| `r1-r2/.env.example` | Template for `r1-r2/.env`: the admin login that the `.http` files read |
| `r1-r2/OnlineShop-R1.postman_collection.json` | All the requests for Postman, in 6 folders, with checks |
| `r1-r2/OnlineShop-local.postman_environment.example.json` | Template for the Postman environment: `baseUrl` and the admin login |
| `r1-r2/product.png` | A real image for adding products |
| `r1-r2/not-an-image.png` | A text file renamed to `.png`, to show the upload check |

## One-time setup

Both files below hold the admin password, so git ignores them. Use the same values as `ADMIN_EMAIL` / `ADMIN_PASSWORD` in the root `.env`.

1. **For the `.http` files:** copy `r1-r2/.env.example` to `r1-r2/.env` (next to the `.http` files: REST Client reads `.env` from the folder of the file) and fill in the two values.
2. **For Postman:** in `r1-r2/`, copy `OnlineShop-local.postman_environment.example.json` to `OnlineShop-local.postman_environment.json` and fill in `adminPassword`.

## How the `.http` files work

- Each file stands on its own: it logs in and creates the users, products and orders it needs.
- Inside a file, send the requests **top to bottom** the first time. Later requests reuse earlier responses, for example `{{loginA.response.body.$.accessToken}}` is the token returned by the request named `loginA`. After that, any request can be sent again on its own.
- REST Client can only reuse responses from the **same** file, which is why each file does its own logins.
- **Login is limited to 5 per minute.** Each file says how many times it logs in (at most 3). If a login returns `429`, wait a minute and send it again.

## Before the interview

1. From the project folder: `docker compose up --build -d`
2. **Postman check:** in VS Code, open the **Postman** extension, import both JSON files, select the **OnlineShop local** environment, and run the whole collection. Everything should be green.
3. Wait **1 minute**: the collection ends with the rate-limit test on purpose.
4. **Live demo:** open the `.http` files in `r1-r2/` in order (0 → 5).

Without Postman, the same check from a terminal:

```bash
cd api-tests/r1-r2
npx newman run OnlineShop-R1.postman_collection.json -e OnlineShop-local.postman_environment.json
```

In the Postman collection every request checks its own result. These checks also run after **every** request:

- the path is versioned (`/api/v1`)
- the security headers are present and the `Server` header is hidden
- every error uses the unified Problem Details format

## What each requirement item maps to

| Requirement 1 item | Show this |
|---|---|
| Whole project runs in Docker, separate containers | `docker compose ps`: `app` and `app-db` |
| Versioning in the path | Any request (`/api/v1/...`). The OpenAPI document in `0-api-rules.http` lists only `/api/v1` paths |
| Easy-to-try documentation | http://localhost:8080/swagger, and these files |
| Correct status codes | 201 create · 401 no token · 403 wrong role · 404 not found · 409 duplicate · 422 invalid input · 429 rate limit |
| Unified error format | `0-api-rules.http`: always `type`, `title`, `status`, `instance`, `traceId` (plus `detail` / `errors` when there is more to say), as `application/problem+json` |
| Security headers | `0-api-rules.http`, first error request: look at the response headers |
| Users: registration, JWT, two roles | `1-users-auth.http` |
| Products: add with image, list, filter, pagination | `2-products.http` |
| Orders: create, view, change status | `3-orders.http` |
| Customer sees only their own orders | `3-orders.http`: ⭐ PROOF 1, and "Customer B lists orders" |
| Only the admin changes the status | `3-orders.http`: ⭐ PROOF 2 |
| Notifications module | `4-notifications.http` |
| Login rate limiting | `5-rate-limit.http` |

## The two proofs the brief asks for

> A user tries to access another user's order, or to perform an operation outside their permissions → the request is rejected.

1. **⭐ PROOF 1** (`3-orders.http`): customer B opens customer A's order → `404`.
   The query filters by the owner taken from the token, so for B the order does not exist. A 404 (not 403) also hides that the order exists at all.
2. **⭐ PROOF 2** (`3-orders.http`): customer A changes the status of their own order → `403`.
   Only the Admin role may change a status, even the owner cannot.

## Extra cases worth showing

- **Register customer B, trying to make itself Admin** (`1-users-auth.http`): the body sends `"role": "Admin"` and the account is still a Customer.
- **Create order with faked owner, total and status** (`3-orders.http`): the server ignores all three. The owner comes from the token and the price from the product.
- **Add product with a fake image** (`2-products.http`): the server checks the file's first bytes, not its name → `422`.
- **Admin: Confirmed → Delivered** (`3-orders.http`): skipping a step → `422`, and the response lists the allowed next steps.
- **Customer B marks A's notification as read** (`4-notifications.http`): `404`, the same owner check as orders. There is also no endpoint that creates a notification, so nobody can send fake ones.
- **Admin changes the status** (`4-notifications.http`): the order's owner is notified, not the admin.
- **Forged token** (Postman only): editing the role inside the JWT to `Admin` breaks the signature → `401`.

## Requirement 2: the inventory service

The stock lives in a separate service (Node.js, `inventory/`) with its own database. The app only talks to it
over gRPC, through the shared contract `proto/inventory.proto`. Every call has a 2-second deadline.

### Before the demo

1. `docker compose up --build -d`, and check `docker compose ps`: `inventory` and `inventory-db` are running.
2. There must be at least one product (send `6-inventory.http`, or run `docker compose --profile seed run --rm seed`).

### What each requirement item maps to

| Requirement 2 item | Show this |
|---|---|
| Separate service, another language, its own database | `docker compose ps`: `inventory` (Node.js) + `inventory-db`. The app has no connection string for it |
| Shared contract, both sides generated from it | `proto/inventory.proto`: the Node service loads it, the .NET build generates the client from it |
| Product details show the stock | `6-inventory.http`: "⭐ Product details show the stock" → `"stock": 5` |
| One reservation request for the whole order; saved only after the inventory agrees | `6-inventory.http`: "Enough stock → 201", then the stock drops |
| Not enough stock → clear refusal | `6-inventory.http`: "⭐ Not enough stock" → `409` naming the product, with `shortages` |
| All or nothing | `6-inventory.http`: after the `409`, the other product's stock is unchanged |
| ⭐ Many orders for the last unit → exactly one succeeds | `node api-tests/r1-r2/race-last-unit.mjs 50` → `1 × 201`, `49 × 409`, stock `0`, `PASS` |
| ⭐ Stop the inventory service → what the user sees | `docker compose stop inventory`, then the last section of `6-inventory.http` |
| Slow inventory → a deadline, clear answer | `docker compose pause inventory`: the order gets `503` after 2 s. `docker compose unpause inventory` |
| Saving fails after the reservation → the stock is given back | `app/Shop.Api/Modules/Orders/OrdersService.cs`: the `catch` around `SaveChangesAsync` calls Release |

### The two proofs the brief asks for

1. **⭐ Race on the last unit:** `node api-tests/r1-r2/race-last-unit.mjs 50`. The script sets a product's stock to 1, then sends
   50 orders at the same moment (`Promise.all`). Exactly one gets `201`, the other 49 get `409`, and the stock ends at `0`.
   Sequelize locks the stock row with `SELECT FOR UPDATE` before checking and deducting the quantity in the same
   transaction. A second order waits for the first to commit, then reads `quantity = 0` and reports a shortage.
2. **⭐ Inventory down:** `docker compose stop inventory`, then in `6-inventory.http`:
   - product details still answer `200`, with `"stock": null`
   - an order gets `503` "The inventory service is not available right now...", in about 2 seconds, and no order is saved
   - `docker compose start inventory`: within a few seconds everything works again

The race script logs in twice, and login is limited to 5 per minute: on `429`, wait a minute and run it again.
It reads the admin login from `api-tests/r1-r2/.env`, or else from the root `.env`.

## Requirement 4: queues and live updates

The order confirmation email goes through an outbox and RabbitMQ to a separate worker (`app/Shop.EmailWorker`);
new orders and status changes reach the browsers over WebSocket, through Soketi.

**Two ways to show it:**

1. **The website (easiest in front of the TA):** log in as the admin and open **Queue checks** (`/queue-checks`).
   The card at the top shows the outbox, RabbitMQ, the worker, the queue and the DLQ, every second. Then:
   - **Run all** runs checks 1, 3, 6, 7 and 8 (no setup needed).
   - Checks 2, 4, 5 and 9 show a command to run first (stop the worker, a wrong mail password, stop RabbitMQ,
     stop Soketi). Press **Run**; when the check says "Waiting for you", run the second command.
2. **The scripts:** `node api-tests/r4/proof-worker.mjs`, then (a minute later) `node api-tests/r4/proof-realtime.mjs`.
   Both end with `PROOF OK`. The commands for the demos by hand are in `r4/r4-demo-commands.txt`.

| Requirement 4 item | Show this |
|---|---|
| The order does not wait for the email | Queue checks 1: `201` in tens of ms, the worker acks seconds later |
| ⭐ Proof 1: stop the worker, no email is lost | Queue checks 2, or `node api-tests/r4/proof-worker.mjs` |
| Ack only after sending; retries; dead-letter queue | Queue checks 3 (a broken message → DLQ with `x-death`) and 4 (wrong mail password → 4 attempts → DLQ) |
| RabbitMQ down → orders still work | Queue checks 5: `201`, the event waits in the outbox, goes out when RabbitMQ is back |
| ⭐ Proof 2: a new order appears on the admin dashboard at once | Queue checks 6, or two browsers: admin on **Orders**, a customer orders in an InPrivate window |
| ⭐ Proof 3: the admin's approval appears on the customer's page at once | Queue checks 7, or the customer on their order page while the admin presses **Confirm** |
| Only the owner (or an admin) can listen | Queue checks 8: `403`, `403`, `401`, a forged signature refused by Soketi, the owner joins |
| Soketi down → orders still work, the page reconnects | Queue checks 9 |

## If something fails

- **Login returns 429:** the rate limit. Wait 1 minute (the Requirement 4 scripts log in 2 or 3 times each).
- **Orders get 503 although the inventory is running:** it was just restarted. Wait a few seconds; the app reconnects on its own.
- **`"stock": null` for every product:** the inventory service is down. `docker compose ps`, then `docker compose start inventory`.
- **A request sends `{{...}}` literally, or gets 401 / 404 unexpectedly:** an earlier request in the same file has not been sent yet. Send the file top to bottom.
- **Login admin returns 401:** the admin password in `api-tests/r1-r2/.env` or in the Postman environment does not match `ADMIN_PASSWORD` in the root `.env`, or the database was created with an older `.env`. Fix the value, or reset with `docker compose down -v` and `docker compose up -d`.
- **Postman: add product returns 422 "The Image field is required":** Postman could not find the image file. The collection points to `product.png` / `not-an-image.png` relative to `r1-r2/`: set that folder as Postman's working directory, or open the request's **Body** tab and re-select the file. (`newman` finds them when run from `r1-r2/`.)

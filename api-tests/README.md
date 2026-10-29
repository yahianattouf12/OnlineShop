# API tests: Requirement 1 (API Design & Security)

Ready requests that cover everything in Requirement 1, in two forms:

- **`.http` files** for the VS Code **REST Client** extension: the quickest for a live demo. Click **Send Request** above each request.
- **A Postman collection** with automatic checks: run it once to prove everything is green.

## Files

| File | What it is |
|---|---|
| `0-api-rules.http` | Swagger/OpenAPI, the unified error format, the security headers |
| `1-users-auth.http` | Register, login (JWT), the two roles |
| `2-products.http` | Add a product with its image, list, filter by category, pagination |
| `3-orders.http` | Create, view, change status, and the **two proofs** (⭐) |
| `4-notifications.http` | Notified on order and status change, own notifications only (⭐), unread count, mark as read |
| `5-rate-limit.http` | Brute-force protection on login (429) |
| `.env.example` | Template for `.env`: the admin login that the `.http` files read |
| `OnlineShop-R1.postman_collection.json` | All the requests for Postman, in 6 folders, with checks |
| `OnlineShop-local.postman_environment.example.json` | Template for the Postman environment: `baseUrl` and the admin login |
| `product.png` | A real image for adding products |
| `not-an-image.png` | A text file renamed to `.png`, to show the upload check |

## One-time setup

Both files below hold the admin password, so git ignores them. Use the same values as `ADMIN_EMAIL` / `ADMIN_PASSWORD` in the root `.env`.

1. **For the `.http` files:** copy `.env.example` to `.env` (in this folder) and fill in the two values.
2. **For Postman:** copy `OnlineShop-local.postman_environment.example.json` to `OnlineShop-local.postman_environment.json` and fill in `adminPassword`.

## How the `.http` files work

- Each file stands on its own: it logs in and creates the users, products and orders it needs.
- Inside a file, send the requests **top to bottom** the first time. Later requests reuse earlier responses, for example `{{loginA.response.body.$.accessToken}}` is the token returned by the request named `loginA`. After that, any request can be sent again on its own.
- REST Client can only reuse responses from the **same** file, which is why each file does its own logins.
- **Login is limited to 5 per minute.** Each file says how many times it logs in (at most 3). If a login returns `429`, wait a minute and send it again.

## Before the interview

1. From the project folder: `docker compose up --build -d`
2. **Postman check:** in VS Code, open the **Postman** extension, import both JSON files, select the **OnlineShop local** environment, and run the whole collection. Everything should be green.
3. Wait **1 minute**: the collection ends with the rate-limit test on purpose.
4. **Live demo:** open the `.http` files in order (0 → 5).

Without Postman, the same check from a terminal:

```bash
cd api-tests
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

## If something fails

- **Login returns 429:** the rate limit. Wait 1 minute.
- **A request sends `{{...}}` literally, or gets 401 / 404 unexpectedly:** an earlier request in the same file has not been sent yet. Send the file top to bottom.
- **Login admin returns 401:** the admin password in `api-tests/.env` or in the Postman environment does not match `ADMIN_PASSWORD` in the root `.env`, or the database was created with an older `.env`. Fix the value, or reset with `docker compose down -v` and `docker compose up -d`.
- **Postman: add product returns 422 "The Image field is required":** Postman could not find the image file. The collection points to `product.png` / `not-an-image.png` relative to this folder: set this folder as Postman's working directory, or open the request's **Body** tab and re-select the file. (`newman` finds them when run from this folder.)

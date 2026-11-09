# OnlineShop

Internet Applications course project: a small online shop built like a real system.
The focus is on security, inter-service communication and, later, performance, scaling and monitoring.

## Tech stack

| Part | Technology |
|---|---|
| Main application | ASP.NET Core Web API (.NET 10, C#) |
| Website | React + TypeScript (Vite), served by nginx |
| Database | PostgreSQL 17 in Docker |
| Inventory service (Requirement 2) | Node.js + gRPC, with its own PostgreSQL |
| API docs | OpenAPI + Swagger UI |

## Project structure

```
app/Shop.Api/
├── Common/            shared code: errors, auth (JWT), API docs, security, paging, image storage
├── Modules/
│   ├── Users/         register, login, roles
│   ├── Products/      products with images
│   ├── Orders/        orders and their status
│   └── Notifications/ messages to the user
└── Program.cs
web/                   the website (see web/README.md)
api-tests/             ready API requests (.http + Postman) and the Requirement 2 proofs
seed/                  demo catalog: products.json, images/, seed.mjs
inventory/             inventory service (Requirement 2)
proto/                 gRPC contract shared by both services (Requirement 2)
docker-compose.yml
```

Each module has its own `DbContext` and its own PostgreSQL schema.
No module reads another module's tables.

## Run everything with Docker (one command)

Needs only Docker Desktop.

```bash
cp .env.example .env      # then put your own values in .env
docker compose up --build
```

- Website: http://localhost:3000
- Swagger UI: http://localhost:8080/swagger
- Five separate containers: `web` (the website), `app` (the API) + `app-db`, and `inventory` (Node.js, gRPC) + `inventory-db`
- The app never reads the inventory database: it only talks to the inventory service over gRPC (contract: `proto/inventory.proto`)
- Tables are created automatically on startup, and the admin account comes from `ADMIN_EMAIL` / `ADMIN_PASSWORD`
- Product images are kept in the `uploads` volume, so they survive restarts

**Demo products (optional):** fill an empty shop with 12 products and their images, added through the API as the admin:

```bash
docker compose --profile seed run --rm seed
```

It is safe to run again (existing products are skipped). For a completely clean start: `docker compose down -v` (deletes all local data), `docker compose up -d`, then seed.

## Requirement 3: prepare the order benchmark

For all Task 3 workloads, the combined seeder, and the before-and-after report, see the [Task 3 benchmark guide](api-tests/task3/README.md).

To run them from the website instead, start the benchmark project with `--profile benchmark` and open **Performance** as the admin. The guide explains the dashboard and its API ([`api-tests/7-benchmark.http`](api-tests/7-benchmark.http)).

Run these commands from the project folder with your usual `.env`. The benchmark uses its own Docker project and database volume. Stop the normal API and database first so the benchmark can use ports 8080 and 5432.

```powershell
docker compose stop app app-db
docker compose -p onlineshop-bench up -d --build app
```

Once [Swagger](http://localhost:8080/swagger) opens, seed a small sample with Node.js 18 or newer:

```bash
node seed/benchmark-orders.mjs 100
```

The command creates `benchmark-customer@example.invalid` through the benchmark API and prints a generated test password. Save that password to log in later. If the account already exists, the command reuses it with its existing password. Each teammate can run the same command on a fresh benchmark volume.

On a fresh benchmark database the seed prints 100 orders across 99 customers, with 2 orders for the benchmark customer. In Swagger, call `GET /api/v1/orders?page=1&pageSize=10` as the admin from `.env` and check `totalCount: 100`. Log in as the benchmark customer, replace the admin token in Swagger, and check `totalCount: 2`. Open one of those orders by ID to see its items and status history.

After the sample works, run `node seed/benchmark-orders.mjs 200000`. The seed uses stable IDs, so rerunning it adds only missing rows. On a fresh benchmark dataset this gives 200,000 orders in total and 4,000 for the benchmark customer. The script also refreshes PostgreSQL's planner statistics. Run the [catalog smoke test](api-tests/smoke.js) with `k6 run api-tests/smoke.js` if you want to verify k6 can reach the API.

To switch back to the normal shop:

```powershell
docker compose -p onlineshop-bench down
docker compose up -d
```

The benchmark data stays in its separate volume for the next run.

## Run it locally (for development)

1. Start the database:
   ```bash
   cp .env.example .env          # then set your own password in .env
   docker compose up -d
   ```
2. Set the secrets (once), from `app/Shop.Api`:
   ```bash
   dotnet user-secrets set "ConnectionStrings:Default" "Host=localhost;Port=5432;Database=db_online_shop;Username=admin;Password=<the password from .env>"
   dotnet user-secrets set "Jwt:Key" "<a random string of at least 32 characters>"
   dotnet user-secrets set "Admin:Email" "admin@shop.local"
   dotnet user-secrets set "Admin:Password" "<a strong password>"
   ```
3. Run the API, from `app/Shop.Api`:
   ```bash
   dotnet run
   ```
   The tables are created automatically on startup, and the admin account is created from `Admin:Email` / `Admin:Password`.
4. Open Swagger UI: http://localhost:5279/swagger

## API (v1)

All routes start with `/api/v1`. Errors always use the same format (Problem Details).

| Method | Route | Who | Success |
|---|---|---|---|
| POST | `/auth/register` | anyone | 201 |
| POST | `/auth/login` | anyone | 200 + JWT |
| GET | `/auth/me` | logged in | 200 |
| GET | `/users` | admin only | 200 |
| GET | `/users/{id}` | admin only | 200 |
| POST | `/products` | admin only (multipart, image ≤ 5 MB) | 201 |
| GET | `/products?category=&page=&pageSize=` | anyone | 200, paged |
| GET | `/products/{id}` | anyone | 200, with `stock` from the inventory service (`null` when it is down) |
| GET | `/products/{id}/image` | anyone | 200, image file |
| PUT | `/products/{id}/stock` | admin only | 200 |
| POST | `/orders` | customer | 201, 409 not enough stock, 503 inventory down |

To call a protected route in Swagger: log in, copy `accessToken`, click **Authorize** and paste it.

## Team workflow

- `main` is protected: every change goes through a pull request reviewed by a teammate.
- One branch per task, e.g. `feat/r1-orders`. Pull requests are squash-merged.

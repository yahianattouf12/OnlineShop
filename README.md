# OnlineShop

Internet Applications course project: a small online shop built like a real system.
The focus is on security, inter-service communication, performance, asynchronous work and real-time updates,
and next scaling and monitoring.

## Requirements so far

| Requirement | What it added | Proofs and report |
|---|---|---|
| 1. API design and security | REST API (`/api/v1`), JWT and two roles, Problem Details errors, security headers, login rate limit | `api-tests/r1-r2/`, website page **Security checks** |
| 2. Inter-service communication | A separate inventory service (Node.js, gRPC) with its own database; stock reserved before an order is saved | `api-tests/r1-r2/race-last-unit.mjs`, page **Inventory checks** |
| 3. Performance and caching | Indexes and paging fixes, Redis cache for products, ETag, a read replica | `docs/r3-report.md`, `docs/r3-results/`, `api-tests/r3/`, page **Performance checks** |
| 4. Asynchronous queues and real time | Outbox + RabbitMQ, a separate email worker (ack, retries, DLQ), live updates through Soketi (WebSocket) | `docs/r4-report.md`, `api-tests/r4/`, page **Queue checks** |

## Tech stack

| Part | Technology |
|---|---|
| Main application | ASP.NET Core Web API (.NET 10, C#), EF Core |
| Website | React + TypeScript (Vite), served by nginx |
| Database | PostgreSQL 17 in Docker |
| Inventory service (Requirement 2) | Node.js + gRPC (Sequelize), with its own PostgreSQL |
| Cache (Requirement 3) | Redis (optional: `docker-compose.cache.yml`) |
| Message broker (Requirement 4) | RabbitMQ 4.1 with the management UI |
| Email worker (Requirement 4) | .NET worker service, MailKit (SMTP, e.g. Mailtrap) |
| Live updates (Requirement 4) | Soketi (Pusher protocol over WebSocket) + pusher-js |
| API docs | OpenAPI + Swagger UI |

## Project structure

```
app/
├── Shop.Api/              the main API
│   ├── Common/            shared code: errors, auth (JWT), API docs, security, paging, image storage, real time
│   ├── Integrations/      the gRPC client for the inventory service
│   ├── Modules/
│   │   ├── Users/         register, login, roles
│   │   ├── Products/      products with images
│   │   ├── Orders/        orders, their status, the outbox, live events
│   │   └── Notifications/ messages to the user
│   └── Program.cs
├── Shop.EmailWorker/      sends the order confirmation emails (Requirement 4)
└── Shop.Messaging/        shared by the API and the worker: the event and the RabbitMQ names
web/                       the website (see web/README.md)
inventory/                 inventory service (Requirement 2)
proto/                     gRPC contract shared by both services (Requirement 2)
api-tests/                 ready API requests and proof scripts, one folder per requirement (see api-tests/README.md)
deploy/                    config files mounted into containers (PostgreSQL replica, RabbitMQ)
docs/                      reports with measured results (r3, r4) and the raw load-test results (r3-results/)
seed/                      demo catalog: products.json, images/, seed.mjs, and the Requirement 3 data scripts
docker-compose.yml         everything; docker-compose.cache.yml and docker-compose.replica.yml add Requirement 3 parts
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
- RabbitMQ management UI: http://localhost:15672 (the `RABBITMQ_USER` / `RABBITMQ_PASSWORD` from `.env`)
- Containers: `web` (nginx: the website, and it forwards `/api/` to the API and `/app/` to Soketi), `app` (the API) + `app-db`,
  `inventory` (Node.js, gRPC) + `inventory-db`, `rabbitmq`, `email-worker`, `soketi`
- The app never reads the inventory database: it only talks to the inventory service over gRPC (contract: `proto/inventory.proto`)
- Tables are created automatically on startup, and the admin account comes from `ADMIN_EMAIL` / `ADMIN_PASSWORD`
- Product images are kept in the `uploads` volume, so they survive restarts
- Secrets (database, JWT, admin, RabbitMQ, SMTP, Soketi) are only in `.env`, which git ignores; `.env.example` lists them all

**Demo products (optional):** fill an empty shop with 12 products and their images, added through the API as the admin:

```bash
docker compose --profile seed run --rm seed
```

It also sets each product's stock in the inventory service. It is safe to run again (existing products are skipped; one with 0 in stock is restocked). For a completely clean start: `docker compose down -v` (deletes all local data), `docker compose up -d`, then seed.


## Run it locally (for development)

1. Start the database and the other services:
   ```bash
   cp .env.example .env          # then set your own values in .env
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
| POST | `/auth/login` | anyone (5 tries per minute) | 200 + JWT |
| GET | `/auth/me` | logged in | 200 |
| GET | `/users` | admin only | 200 |
| GET | `/users/{id}` | admin only | 200 |
| POST | `/products` | admin only (multipart, image ≤ 5 MB) | 201 |
| GET | `/products?category=&page=&pageSize=` | anyone | 200, paged |
| GET | `/products/{id}` | anyone | 200, with `stock` from the inventory service (`null` when it is down), ETag |
| GET | `/products/{id}/image` | anyone | 200, image file |
| PUT | `/products/{id}/stock` | admin only | 200 |
| POST | `/orders` | customer | 201 (the email is sent in the background), 409 not enough stock, 503 inventory down |
| GET | `/orders`, `/orders/{id}` | customer: own orders; admin: all | 200, paged |
| PATCH | `/orders/{id}/status` | admin only | 200 (the customer's page updates live) |
| GET | `/notifications` | logged in: own only | 200 |
| POST | `/realtime/auth` | logged in: only the order's owner or an admin | 200, the signature to join a private channel |

To call a protected route in Swagger: log in, copy `accessToken`, click **Authorize** and paste it.

## Team workflow

- `main` is protected: every change goes through a pull request reviewed by a teammate.
- One branch per task, e.g. `feat/r1-orders`. Pull requests are squash-merged.

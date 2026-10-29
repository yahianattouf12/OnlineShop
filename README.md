# OnlineShop

Internet Applications course project: a small online shop built like a real system.
The focus is on security, inter-service communication and, later, performance, scaling and monitoring.

## Tech stack

| Part | Technology |
|---|---|
| Main application | ASP.NET Core Web API (.NET 10, C#) |
| Website | React + TypeScript (Vite), served by nginx |
| Database | PostgreSQL 17 in Docker |
| Inventory service (Requirement 2) | Node.js + gRPC (coming next) |
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
api-tests/             ready API requests (.http + Postman) for Requirement 1
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
- Three separate containers: `web` (the website), `app` (the API) and `app-db` (PostgreSQL)
- Tables are created automatically on startup, and the admin account comes from `ADMIN_EMAIL` / `ADMIN_PASSWORD`
- Product images are kept in the `uploads` volume, so they survive restarts


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
| GET | `/products/{id}` | anyone | 200 |
| GET | `/products/{id}/image` | anyone | 200, image file |

To call a protected route in Swagger: log in, copy `accessToken`, click **Authorize** and paste it.

## Team workflow

- `main` is protected: every change goes through a pull request reviewed by a teammate.
- One branch per task, e.g. `feat/r1-orders`. Pull requests are squash-merged.

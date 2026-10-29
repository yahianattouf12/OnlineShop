# Website

The OnlineShop website: React + TypeScript, built with Vite. It only talks to the API (`/api/v1`); every rule
(who may see which order, who may change a status, prices, limits) is enforced by the API, not here.

## Run it

**With Docker** (from the project root): `docker compose up --build`, then open http://localhost:3000.
nginx serves the site and forwards `/api`, `/swagger` and `/openapi` to the API container, so the browser sees
one origin and the API needs no CORS settings.

**For development** (hot reload), with the API running on :8080 (e.g. `docker compose up -d app`):

```bash
cd web
npm install
npm run dev        # http://localhost:5173, /api is forwarded to http://localhost:8080
```

`npm run build` type-checks and builds into `dist/`.

## Pages

| Who | Page | Route |
|---|---|---|
| Everyone | Shop: products, category filter, pagination | `/products` |
| Everyone | Product details | `/products/:id` |
| Everyone | Log in · Sign up | `/login` · `/register` |
| Customer | Cart and checkout (cart kept in the browser) | `/cart` |
| Customer | My orders (status filter, pagination) | `/orders` |
| Customer | Notifications (unread badge in the nav) | `/notifications` |
| Customer, Admin | Order details with status timeline (admin: change status) | `/orders/:id` |
| Customer, Admin | Security checks: runs the Requirement 1 proofs live and shows each request and response | `/security` |
| Admin | All orders (with customer emails) | `/admin/orders` |
| Admin | Add a product with its image | `/admin/products/new` |
| Admin | Users | `/admin/users` |

Errors from the API are always Problem Details, so the site shows them the same way everywhere:
422 next to the right form field, 404/403 as a page, 401 sends you to log in, 429 on login shows a countdown.

## Code map

```
src/
├── api/          typed API client (client.ts turns every error into an ApiError), endpoints, response types
├── auth/         session (JWT in sessionStorage), RequireAuth route guard
├── cart/         cart state (localStorage)
├── components/   layout (nav + footer), form fields, badges, notices, toasts, icons
├── lib/          formatting, order status rules (mirrors the server), data loading hook
├── pages/        one file per page (or group of pages)
└── styles/       design tokens + styles from the team design system
```

## Design

Built on the team design system: a monochrome palette (ink `#141414` on white, light grey tints for structure),
pill-shaped controls, no shadows, and Inter (the documented substitute for Saans) with 650-weight headings that
end with a period. The system has no red/green state colors, so errors use the inverted ink style.

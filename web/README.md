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
| Everyone | Product details, with the stock from the inventory service (or "availability unknown" when it is down) | `/products/:id` |
| Everyone | Log in · Sign up | `/login` · `/register` |
| Customer | Cart and checkout (cart kept in the browser): a stock warning per line, and a clear message when the order is refused for stock (409) or the inventory service is down (503) | `/cart` |
| Customer | My orders (status filter, pagination) | `/orders` |
| Customer | Notifications (unread badge in the nav) | `/notifications` |
| Customer, Admin | Order details with status timeline (admin: change status) | `/orders/:id` |
| Customer, Admin | Security checks: runs the Requirement 1 proofs live and shows each request and response | `/security` |
| Admin | All orders (with customer emails) | `/admin/orders` |
| Admin | Inventory: every product's stock, read from and saved to the inventory service | `/admin/inventory` |
| Admin | Add a product with its image and its starting stock | `/admin/products/new` |
| Admin | Inventory checks: runs the Requirement 2 proofs live (not enough stock, all or nothing, the race on the last unit, the inventory service stopped or slow) | `/inventory-checks` |
| Admin | Users | `/admin/users` |

Errors from the API are always Problem Details, so the site shows them the same way everywhere:
422 next to the right form field, 404/403 as a page, 401 sends you to log in, 429 on login shows a countdown,
409 "not enough stock" lists each short product with a one-click fix, and 503 says the inventory service is not answering.

The stock is never stored here or in the app's database: the product details endpoint asks the inventory service
for it on every call, and the shop treats it as a hint. The real check happens when the order is placed, all at once.

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
end with a period. The one addition is red for errors (`--color-error*` in `tokens.css`): invalid field
outlines, field messages, error notices and failed security checks, so a problem stands out from normal content.
Order status badges are color-coded too (`--color-status-*`): pending amber, confirmed blue, shipped purple,
delivered green, cancelled red, each as strong text on a translucent tint. Stock badges reuse those hues:
in stock green, "only N left" amber, out of stock red, availability unknown grey.

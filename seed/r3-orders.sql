-- Requirement 3: fills the database with many fake orders, so slow queries really show.
-- Run (PowerShell, from the project folder):
--   Get-Content -Raw seed/r3-orders.sql | docker compose exec -T app-db psql -U admin -d db_online_shop -v count=200000 -v customer=customer@test.local -f -
-- Safe to run again: every row has a fixed id, so existing rows are skipped (ON CONFLICT DO NOTHING).

\set ON_ERROR_STOP on

BEGIN;

-- 1. Orders. Every 50th order belongs to our test customer (so they have their own list to read);
--    the others belong to 1,000 fake customers. md5(text)::uuid gives the same id every run.
INSERT INTO orders."Orders" ("Id", "UserId", "Status", "TotalAmount", "CreatedAt", "UpdatedAt")
SELECT
    md5('r3-order-' || n)::uuid,
    CASE WHEN n % 50 = 0
         THEN (SELECT "Id" FROM users."Users" WHERE "Email" = :'customer')
         ELSE md5('r3-user-' || n % 1000)::uuid
    END,
    (ARRAY['Pending', 'Confirmed', 'Shipped', 'Delivered', 'Cancelled'])[1 + n % 5],
    0,                                                      -- the real total is set in step 3
    timestamptz '2025-01-01' + n * interval '2 minutes',   -- each order 2 minutes after the previous one
    timestamptz '2025-01-01' + n * interval '2 minutes'
FROM generate_series(1, :count) AS n
ON CONFLICT ("Id") DO NOTHING;

-- 2. One to three items per order (n % 3 decides how many).
INSERT INTO orders."OrderItems" ("Id", "OrderId", "ProductId", "ProductName", "UnitPrice", "Quantity")
SELECT
    md5('r3-item-' || n || '-' || line)::uuid,
    md5('r3-order-' || n)::uuid,
    md5('r3-product-' || (n + line) % 12)::uuid,
    'Test product ' || (n + line) % 12,
    10 + (n + line) % 12,
    1 + line % 3
FROM generate_series(1, :count) AS n,
     generate_series(1, 1 + n % 3) AS line
ON CONFLICT ("Id") DO NOTHING;

-- 3. Each order's total = the sum of its items.
UPDATE orders."Orders" o
SET "TotalAmount" = t.total
FROM (
    SELECT "OrderId", sum("UnitPrice" * "Quantity") AS total
    FROM orders."OrderItems"
    GROUP BY "OrderId"
) t
WHERE t."OrderId" = o."Id" AND o."TotalAmount" = 0;

-- 4. Each order's first history entry (created as Pending, by its customer).
INSERT INTO orders."OrderStatusHistory" ("Id", "OrderId", "Status", "ChangedAt", "ChangedByUserId")
SELECT md5('r3-history-' || o."Id")::uuid, o."Id", 'Pending', o."CreatedAt", o."UserId"
FROM orders."Orders" o
ON CONFLICT ("Id") DO NOTHING;

COMMIT;

-- Refresh PostgreSQL's statistics, so the planner knows the tables are big now.
ANALYZE orders."Orders", orders."OrderItems", orders."OrderStatusHistory";

SELECT count(*) AS orders,
       count(*) FILTER (WHERE "UserId" = (SELECT "Id" FROM users."Users" WHERE "Email" = :'customer')) AS customer_orders
FROM orders."Orders";

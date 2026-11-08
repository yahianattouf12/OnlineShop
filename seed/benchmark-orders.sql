-- Run with benchmark-orders.mjs, which ensures the benchmark customer exists.
\set ON_ERROR_STOP on

BEGIN;

CREATE TEMP TABLE benchmark_settings (
    order_count integer NOT NULL CHECK (order_count BETWEEN 100 AND 200000),
    benchmark_customer_id uuid NOT NULL,
    admin_id uuid NOT NULL
) ON COMMIT DROP;

INSERT INTO benchmark_settings
SELECT
    :'order_count'::integer,
    (SELECT "Id" FROM users."Users"
     WHERE "Email" = 'benchmark-customer@example.invalid' AND "Role" = 'Customer'),
    (SELECT "Id" FROM users."Users" WHERE "Role" = 'Admin' ORDER BY "Id" LIMIT 1);

-- The registered customer owns every 50th order. Spread the rest across up to 1,000 fixture users.
CREATE TEMP TABLE benchmark_orders ON COMMIT DROP AS
SELECT
    n,
    md5('benchmark-order-' || n)::uuid AS id,
    CASE WHEN n % 50 = 0 THEN NULL ELSE 1 + (n - n / 50 - 1) % 1000 END AS fixture_customer,
    timestamptz '2024-01-01 00:00:00+00' + n * interval '4 minutes' AS created_at,
    CASE n % 8
        WHEN 0 THEN ARRAY['Pending']
        WHEN 1 THEN ARRAY['Pending', 'Confirmed']
        WHEN 2 THEN ARRAY['Pending', 'Confirmed', 'Shipped']
        WHEN 3 THEN ARRAY['Pending', 'Cancelled']
        ELSE ARRAY['Pending', 'Confirmed', 'Shipped', 'Delivered']
    END AS statuses
FROM benchmark_settings
CROSS JOIN LATERAL generate_series(1, order_count) AS series(n);

-- These fixture owners have no usable password. The benchmark customer has a normal API login.
INSERT INTO users."Users" ("Id", "Email", "PasswordHash", "Role", "CreatedAt")
SELECT DISTINCT
    md5('benchmark-owner-' || fixture_customer)::uuid,
    'benchmark-owner-' || fixture_customer || '@example.invalid',
    '', 'Customer', timestamptz '2024-01-01 00:00:00+00'
FROM benchmark_orders
WHERE fixture_customer IS NOT NULL
ON CONFLICT ("Id") DO NOTHING;

-- Historical product snapshots are sufficient for order list and detail reads.
CREATE TEMP TABLE benchmark_items ON COMMIT DROP AS
SELECT
    md5('benchmark-item-' || o.n || '-' || line)::uuid AS id,
    o.id AS order_id,
    1 + (o.n + line) % 12 AS product_number,
    9.95 + 2 * ((o.n + line) % 12) AS unit_price,
    1 + (o.n + 2 * line) % 4 AS quantity
FROM benchmark_orders o
CROSS JOIN LATERAL generate_series(1, 1 + o.n % 3) AS lines(line);

INSERT INTO orders."Orders" ("Id", "UserId", "Status", "TotalAmount", "CreatedAt", "UpdatedAt")
SELECT
    o.id,
    coalesce(md5('benchmark-owner-' || o.fixture_customer)::uuid, settings.benchmark_customer_id),
    o.statuses[cardinality(o.statuses)],
    totals.total_amount,
    o.created_at,
    o.created_at + (cardinality(o.statuses) - 1) * interval '1 day'
FROM benchmark_orders o
CROSS JOIN benchmark_settings settings
JOIN (
    SELECT order_id, sum(unit_price * quantity) AS total_amount
    FROM benchmark_items
    GROUP BY order_id
) totals ON totals.order_id = o.id
ON CONFLICT ("Id") DO NOTHING;

INSERT INTO orders."OrderItems" ("Id", "OrderId", "ProductId", "ProductName", "UnitPrice", "Quantity")
SELECT id, order_id, md5('benchmark-product-' || product_number)::uuid,
       'Benchmark product ' || product_number, unit_price, quantity
FROM benchmark_items
ON CONFLICT ("Id") DO NOTHING;

INSERT INTO orders."OrderStatusHistory" ("Id", "OrderId", "Status", "ChangedAt", "ChangedByUserId")
SELECT
    md5('benchmark-history-' || o.n || '-' || step)::uuid,
    o.id,
    status,
    o.created_at + (step - 1) * interval '1 day',
    CASE WHEN step = 1 THEN stored."UserId" ELSE settings.admin_id END
FROM benchmark_orders o
JOIN orders."Orders" stored ON stored."Id" = o.id
CROSS JOIN benchmark_settings settings
CROSS JOIN LATERAL unnest(o.statuses) WITH ORDINALITY AS history(status, step)
ON CONFLICT ("Id") DO NOTHING;

COMMIT;

ANALYZE orders."Orders", orders."OrderItems", orders."OrderStatusHistory";

SELECT count(*) AS orders,
       count(DISTINCT "UserId") AS customers,
       count(*) FILTER (WHERE "UserId" = (
           SELECT "Id" FROM users."Users" WHERE "Email" = 'benchmark-customer@example.invalid'
       )) AS benchmark_customer_orders
FROM orders."Orders";

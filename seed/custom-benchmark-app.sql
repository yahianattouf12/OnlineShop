-- Called only by the benchmark service after validating all numeric parameters.
-- This namespace is separate from the older benchmark-orders.sql fixture.
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '180s';
SELECT pg_advisory_xact_lock(76483011);
CREATE SCHEMA IF NOT EXISTS benchmark_lab;
CREATE TABLE IF NOT EXISTS benchmark_lab.entities (
  kind text NOT NULL, n integer NOT NULL CHECK(n > 0), id uuid NOT NULL,
  PRIMARY KEY(kind, n), UNIQUE(kind, id)
);
CREATE TEMP TABLE lab_settings ON COMMIT DROP AS
SELECT :'orders'::integer AS orders, :'products'::integer AS products,
       :'customers'::integer AS customers, :'customer_every'::integer AS customer_every,
       (SELECT "Id" FROM users."Users" WHERE "Email" = 'benchmark-customer@example.invalid' AND "Role" = 'Customer') AS customer_id,
       (SELECT "Id" FROM users."Users" WHERE "Role" = 'Admin' ORDER BY "Id" LIMIT 1) AS admin_id;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM lab_settings WHERE admin_id IS NULL OR (orders > 0 AND customer_id IS NULL)) THEN
    RAISE EXCEPTION 'The admin and benchmark customer must exist before preparing orders.';
  END IF;
END $$;

-- Refuse a deterministic ID collision with a row that the studio does not own.
CREATE TEMP TABLE lab_ids ON COMMIT DROP AS
SELECT 'product'::text AS kind, n, md5('studio-product-v1-' || n)::uuid AS id
FROM lab_settings CROSS JOIN LATERAL generate_series(1, products) AS s(n)
UNION ALL
SELECT 'order', n, md5('studio-order-v1-' || n)::uuid
FROM lab_settings CROSS JOIN LATERAL generate_series(1, orders) AS s(n)
UNION ALL
SELECT 'customer', n, md5('studio-owner-v1-' || n)::uuid
FROM lab_settings CROSS JOIN LATERAL generate_series(1, least(orders, customers)) AS s(n);
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM lab_ids i LEFT JOIN benchmark_lab.entities own ON own.kind = i.kind AND own.n = i.n AND own.id = i.id
    WHERE own.id IS NULL AND (
      (i.kind = 'product' AND EXISTS (SELECT 1 FROM products."Products" p WHERE p."Id" = i.id)) OR
      (i.kind = 'order' AND EXISTS (SELECT 1 FROM orders."Orders" o WHERE o."Id" = i.id)) OR
      (i.kind = 'customer' AND EXISTS (SELECT 1 FROM users."Users" u WHERE u."Id" = i.id))
    )
  ) THEN RAISE EXCEPTION 'A studio fixture ID conflicts with an existing row. Nothing was changed.'; END IF;
END $$;

-- A resize replaces only tracked studio orders (their own items/history cascade).
DELETE FROM orders."Orders" o USING benchmark_lab.entities own
WHERE own.kind = 'order' AND own.id = o."Id" AND own.id = md5('studio-order-v1-' || own.n)::uuid;
DELETE FROM products."Products" p USING benchmark_lab.entities own, lab_settings settings
WHERE own.kind = 'product' AND own.id = p."Id" AND own.n > settings.products
  AND own.id = md5('studio-product-v1-' || own.n)::uuid;
DELETE FROM benchmark_lab.entities own USING lab_settings settings
WHERE (own.kind = 'order' AND own.n > settings.orders) OR (own.kind = 'product' AND own.n > settings.products);

INSERT INTO users."Users" ("Id", "Email", "PasswordHash", "Role", "CreatedAt")
SELECT id, 'studio-owner-' || n || '@example.invalid', '', 'Customer', timestamptz '2024-01-01 00:00:00+00'
FROM lab_ids WHERE kind = 'customer'
ON CONFLICT ("Id") DO NOTHING;

INSERT INTO products."Products" ("Id", "Name", "Description", "Price", "Category", "ImageFileName", "ImageContentType", "CreatedAt")
SELECT id, 'Studio fixture product ' || n, 'Synthetic metadata for repeatable performance tests. No image asset.',
       9.95 + (n % 10000) * 0.25, 'studio-' || (n % 10), '', '',
       timestamptz '2024-01-01 00:00:00+00' + n * interval '1 minute'
FROM lab_ids WHERE kind = 'product'
ON CONFLICT ("Id") DO UPDATE SET "Name" = EXCLUDED."Name", "Description" = EXCLUDED."Description",
  "Price" = EXCLUDED."Price", "Category" = EXCLUDED."Category", "CreatedAt" = EXCLUDED."CreatedAt";

CREATE TEMP TABLE lab_orders ON COMMIT DROP AS
SELECT n, id,
       CASE WHEN n % settings.customer_every = 0 THEN settings.customer_id
            ELSE md5('studio-owner-v1-' || (1 + (n - 1) % settings.customers))::uuid END AS owner,
       timestamptz '2024-01-01 00:00:00+00' + n * interval '4 minutes' AS created_at,
       CASE n % 5 WHEN 0 THEN ARRAY['Pending'] WHEN 1 THEN ARRAY['Pending', 'Confirmed']
         WHEN 2 THEN ARRAY['Pending', 'Confirmed', 'Shipped']
         WHEN 3 THEN ARRAY['Pending', 'Cancelled'] ELSE ARRAY['Pending', 'Confirmed', 'Shipped', 'Delivered'] END AS statuses
FROM lab_ids CROSS JOIN lab_settings settings WHERE kind = 'order';

CREATE TEMP TABLE lab_items ON COMMIT DROP AS
SELECT md5('studio-item-v1-' || o.n || '-' || line)::uuid AS id, o.id AS order_id,
       1 + (o.n + line - 2) % settings.products AS product_number,
       1 + (o.n + line) % 4 AS quantity
FROM lab_orders o CROSS JOIN lab_settings settings
CROSS JOIN LATERAL generate_series(1, 1 + o.n % 3) AS s(line);

INSERT INTO orders."Orders" ("Id", "UserId", "Status", "TotalAmount", "CreatedAt", "UpdatedAt")
SELECT o.id, o.owner, o.statuses[cardinality(o.statuses)], sum(p."Price" * i.quantity),
       o.created_at, o.created_at + (cardinality(o.statuses) - 1) * interval '1 day'
FROM lab_orders o JOIN lab_items i ON i.order_id = o.id
JOIN products."Products" p ON p."Id" = md5('studio-product-v1-' || i.product_number)::uuid
GROUP BY o.id, o.owner, o.statuses, o.created_at;

INSERT INTO orders."OrderItems" ("Id", "OrderId", "ProductId", "ProductName", "UnitPrice", "Quantity")
SELECT i.id, i.order_id, p."Id", p."Name", p."Price", i.quantity
FROM lab_items i JOIN products."Products" p ON p."Id" = md5('studio-product-v1-' || i.product_number)::uuid;

INSERT INTO orders."OrderStatusHistory" ("Id", "OrderId", "Status", "ChangedAt", "ChangedByUserId")
SELECT md5('studio-history-v1-' || o.n || '-' || step)::uuid, o.id, status,
       o.created_at + (step - 1) * interval '1 day', CASE WHEN step = 1 THEN o.owner ELSE settings.admin_id END
FROM lab_orders o CROSS JOIN lab_settings settings
CROSS JOIN LATERAL unnest(o.statuses) WITH ORDINALITY AS h(status, step);

INSERT INTO benchmark_lab.entities (kind, n, id)
SELECT kind, n, id FROM lab_ids ON CONFLICT (kind, n) DO NOTHING;
COMMIT;
ANALYZE orders."Orders", orders."OrderItems", orders."OrderStatusHistory", products."Products", users."Users";
SELECT json_build_object(
 'counts', json_build_object('orders', (SELECT count(*) FROM orders."Orders"), 'products', (SELECT count(*) FROM products."Products"),
   'customerOrders', (SELECT count(*) FROM orders."Orders" WHERE "UserId" = (SELECT "Id" FROM users."Users" WHERE "Email" = 'benchmark-customer@example.invalid'))),
 'fixture', json_build_object('orders', (SELECT count(*) FROM benchmark_lab.entities WHERE kind = 'order'),
   'products', (SELECT count(*) FROM benchmark_lab.entities WHERE kind = 'product'),
   'customers', (SELECT count(*) FROM benchmark_lab.entities WHERE kind = 'customer')),
 'samples', json_build_object('productIds', (SELECT coalesce(json_agg(id), '[]'::json) FROM (SELECT id FROM benchmark_lab.entities WHERE kind = 'product' ORDER BY n LIMIT 10) s),
   'orderIds', (SELECT coalesce(json_agg(id), '[]'::json) FROM (SELECT id FROM benchmark_lab.entities WHERE kind = 'order' ORDER BY n LIMIT 10) s),
   'customerId', (SELECT "Id" FROM users."Users" WHERE "Email" = 'benchmark-customer@example.invalid'))
);

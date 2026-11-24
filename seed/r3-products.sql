-- Requirement 3: adds many test products, so the product list has real work to do (for the Redis test).
-- Run (PowerShell, from the project folder):
--   Get-Content -Raw seed/r3-products.sql | docker compose exec -T app-db psql -U admin -d db_online_shop -v count=20000 -f -
-- These products have no real image file; they are only for measuring the list.

\set ON_ERROR_STOP on

INSERT INTO products."Products"
    ("Id", "Name", "Description", "Price", "Category", "ImageFileName", "ImageContentType", "CreatedAt")
SELECT
    md5('r3-bulk-product-' || n)::uuid,
    'Bulk product ' || n,
    'A test product for the Requirement 3 measurements.',
    1 + n % 500,
    'bulk-' || n % 20,                                      -- 20 categories, 1,000 products each
    'missing.png',
    'image/png',
    timestamptz '2024-01-01' + n * interval '1 minute'      -- older than the 12 demo products
FROM generate_series(1, :count) AS n
ON CONFLICT ("Id") DO NOTHING;

ANALYZE products."Products";

SELECT count(*) AS products FROM products."Products";

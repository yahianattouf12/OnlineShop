\set ON_ERROR_STOP on
BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '180s';
SELECT pg_advisory_xact_lock(76483012);
CREATE SCHEMA IF NOT EXISTS benchmark_lab;
CREATE TABLE IF NOT EXISTS benchmark_lab.stock_fixture (
  n integer PRIMARY KEY CHECK(n > 0), product_id uuid NOT NULL UNIQUE
);
CREATE TEMP TABLE lab_stock ON COMMIT DROP AS
SELECT n, md5('studio-product-v1-' || n)::uuid AS product_id,
  :'stock_min'::integer + (n - 1) % (:'stock_max'::integer - :'stock_min'::integer + 1) AS quantity
FROM generate_series(1, :'products'::integer) AS s(n);
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM lab_stock desired JOIN stock existing USING (product_id)
    LEFT JOIN benchmark_lab.stock_fixture own ON own.product_id = desired.product_id AND own.n = desired.n
    WHERE own.n IS NULL) THEN
    RAISE EXCEPTION 'A studio inventory ID conflicts with an existing row. Nothing was changed.';
  END IF;
END $$;
DELETE FROM stock s USING benchmark_lab.stock_fixture own
WHERE s.product_id = own.product_id AND own.n > :'products'::integer
  AND own.product_id = md5('studio-product-v1-' || own.n)::uuid;
DELETE FROM benchmark_lab.stock_fixture WHERE n > :'products'::integer;
INSERT INTO stock (product_id, quantity, updated_at)
SELECT product_id, quantity, now() FROM lab_stock
ON CONFLICT (product_id) DO UPDATE SET quantity = EXCLUDED.quantity, updated_at = now();
INSERT INTO benchmark_lab.stock_fixture (n, product_id)
SELECT n, product_id FROM lab_stock ON CONFLICT(n) DO NOTHING;
COMMIT;
ANALYZE stock;
SELECT json_build_object('inventory', (SELECT count(*) FROM stock),
  'fixtureInventory', (SELECT count(*) FROM benchmark_lab.stock_fixture),
  'stockMin', (SELECT min(quantity) FROM stock s JOIN benchmark_lab.stock_fixture f USING(product_id)),
  'stockMax', (SELECT max(quantity) FROM stock s JOIN benchmark_lab.stock_fixture f USING(product_id)));

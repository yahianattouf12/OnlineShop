-- Requirement 3 demo: the admin order list, page 10,000 (10 per page), WITHOUT and WITH the new index.
-- Nothing is changed for good: the index is dropped inside a transaction and the ROLLBACK brings it back.
--
--   Get-Content api-tests/r3/explain-admin-orders.sql | docker compose exec -T app-db psql -U admin -d db_online_shop
--
-- The query is the inner part of what EF sends for GET /orders?page=10000&pageSize=10 ("page first, then count").

\echo '=== 1. WITHOUT the (CreatedAt DESC, Id) index ==='
BEGIN;
DROP INDEX orders."IX_Orders_CreatedAt_Id";
EXPLAIN (ANALYZE, COSTS OFF)
SELECT o0.*, (SELECT count(*)::int FROM orders."OrderItems" o1 WHERE o0."Id" = o1."OrderId") AS c
FROM (SELECT o."Id", o."CreatedAt", o."Status", o."TotalAmount", o."UserId"
      FROM orders."Orders" AS o
      ORDER BY o."CreatedAt" DESC, o."Id"
      LIMIT 10 OFFSET 99990) AS o0;
ROLLBACK;

\echo '=== 2. WITH the (CreatedAt DESC, Id) index ==='
EXPLAIN (ANALYZE, COSTS OFF)
SELECT o0.*, (SELECT count(*)::int FROM orders."OrderItems" o1 WHERE o0."Id" = o1."OrderId") AS c
FROM (SELECT o."Id", o."CreatedAt", o."Status", o."TotalAmount", o."UserId"
      FROM orders."Orders" AS o
      ORDER BY o."CreatedAt" DESC, o."Id"
      LIMIT 10 OFFSET 99990) AS o0;

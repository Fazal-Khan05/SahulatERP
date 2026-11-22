-- Reverses drizzle/0038_sales_tax_return.sql. Never run automatically. Run it by hand, as postgres,
-- only after showing it to the founder and getting a yes. It DELETES the province each company
-- gave for its sales tax return. Nothing else is lost: the annexes are read from the invoices,
-- bills, receipts, shipments and stock moves, which stay as they are.

BEGIN;
DROP FUNCTION app.tax_return_ledger(date, date);
DROP FUNCTION app.annex_h1_rows(date, date);
DROP FUNCTION app.annex_b_rows(date, date);
DROP FUNCTION app.annex_a_rows(date, date);
DROP FUNCTION app.annex_c1_rows(date, date);
DROP FUNCTION app.annex_c_rows(date, date);
DROP FUNCTION app.tax_return_tenant();
DROP TABLE public.tax_return_settings;
-- The row drizzle-kit wrote for 0038_sales_tax_return (its "when" in drizzle/meta/_journal.json).
DELETE FROM drizzle.__drizzle_migrations WHERE created_at = 1795355841995;
COMMIT;

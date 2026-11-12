-- Reverses drizzle/0008_numbering.sql. Never run automatically. This DELETES every company's
-- warehouses, fiscal periods and document number counters. Run it by hand, as postgres, only
-- after showing it to the founder and getting a yes. Once documents exist, deleting the counters
-- would let numbers be reused: do not run it then.

BEGIN;

DROP FUNCTION app.next_document_number(text, date);
DROP TABLE public.number_series, public.fiscal_periods, public.warehouses;

-- The row drizzle-kit wrote for 0008_numbering (its "when" in drizzle/meta/_journal.json).
DELETE FROM drizzle.__drizzle_migrations WHERE created_at = 1794520106602;

COMMIT;

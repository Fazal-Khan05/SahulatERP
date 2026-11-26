-- Reverses drizzle/0047_data_imports.sql. Never run automatically. Run it by hand, as postgres,
-- only after showing it to the founder and getting a yes. It DELETES the record of every file
-- imported under Settings, Import data (each import's kind, file name and SHA-256, row count and
-- column mapping). What those imports brought in (customers, suppliers, items, opening stock and
-- opening balances) stays where it is.

BEGIN;
DROP TABLE public.data_imports;
DELETE FROM drizzle.__drizzle_migrations WHERE created_at = 1795701252849;
COMMIT;

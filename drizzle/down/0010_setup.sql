-- Reverses drizzle/0010_setup.sql. Never run automatically. This DELETES every company's setup
-- answers (whether it is registered for sales tax, its own NTN and STRN). Run it by hand, as
-- postgres, only after showing it to the founder and getting a yes.

BEGIN;

DROP TABLE public.company_setup;

-- The row drizzle-kit wrote for 0010_setup (its "when" in drizzle/meta/_journal.json).
DELETE FROM drizzle.__drizzle_migrations WHERE created_at = 1794524291414;

COMMIT;

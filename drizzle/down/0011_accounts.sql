-- Reverses drizzle/0011_accounts.sql. Never run automatically. This DELETES every company's chart
-- of accounts. Run it by hand, as postgres, only after showing it to the founder and getting a
-- yes. Once journals exist the accounts are in use: reverse the later migrations first.

BEGIN;

DROP FUNCTION app.seed_accounts(text);
DROP TABLE public.accounts;
DROP FUNCTION app.check_account();

-- The row drizzle-kit wrote for 0011_accounts (its "when" in drizzle/meta/_journal.json).
DELETE FROM drizzle.__drizzle_migrations WHERE created_at = 1794539928873;

COMMIT;

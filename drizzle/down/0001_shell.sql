-- Reverses drizzle/0001_shell.sql. Never run automatically. This DELETES every company's product
-- name, logo and module switches. Run it by hand, as postgres, only after showing it to the
-- founder and getting a yes.

BEGIN;

DROP TABLE public.modules_enabled, public.settings;
DROP TYPE public.module_key;

-- The row drizzle-kit wrote for 0001_shell (its "when" in drizzle/meta/_journal.json).
DELETE FROM drizzle.__drizzle_migrations WHERE created_at = 1794413137113;

COMMIT;

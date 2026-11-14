-- Reverses drizzle/0023_safe_search_path.sql. Never run automatically, and there is no good
-- reason to run it: it puts back the hole that migration closed (a session of the app's role
-- making code of its own run as postgres). It exists because every migration has a file that
-- reverses it. Run it by hand, as postgres, only after showing it to the founder and getting a
-- yes.
--
-- It gives PUBLIC back the right to make temporary objects, and gives every function in schema
-- app that searches "pg_catalog, pg_temp" an empty search path again. That includes functions
-- written after 0023 with that path on purpose, so run it only on a database that has no
-- migration later than 0023.

BEGIN;

DO $undo$
DECLARE
  f record;
BEGIN
  FOR f IN
    SELECT p.oid::regprocedure AS signature
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'app' AND p.proname <> 'audit_action_reserved'
      AND EXISTS (SELECT 1 FROM unnest(p.proconfig) c WHERE c = 'search_path=pg_catalog, pg_temp')
  LOOP
    EXECUTE format('ALTER FUNCTION %s SET search_path = %L', f.signature, '');
  END LOOP;
  EXECUTE format('GRANT TEMPORARY ON DATABASE %I TO PUBLIC', current_database());
END $undo$;

-- The row drizzle-kit wrote for 0023_safe_search_path (its "when" in drizzle/meta/_journal.json).
DELETE FROM drizzle.__drizzle_migrations WHERE created_at = 1794691803336;

COMMIT;

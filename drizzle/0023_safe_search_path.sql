-- Security: a session of the app's role could make code of its own run as the owner of the
-- database functions.
-- track: joint
--
-- Hand-written; nothing here is managed by Drizzle. No table changes, no data changes.
-- Reverse with drizzle/down/0023_safe_search_path.sql.
--
-- Every function in schema app was written with SET search_path = ''. With an empty path
-- Postgres still looks in the session's temporary schema, and looks there FIRST, for the names
-- of tables and types. A session of app_runtime could therefore make a temporary type of its own
-- called "uuid", with a check that calls a function of its own. The next SECURITY DEFINER
-- function that wrote "::uuid" (app.tenant_id(), which every row-level-security policy asks)
-- then used that type, and ran the session's function as the definer: as postgres, past
-- row-level security and every grant. Found by the reviewer of Step 33 and reproduced on a
-- local database on 2026-11-15; drizzle/0019_journal_documents.sql had met one case of it (a
-- temporary table called "text") and closed only that one.
--
-- Two changes, each enough by itself:
--
--   1. Every function in schema app now searches pg_catalog first and the temporary schema
--      last: SET search_path = pg_catalog, pg_temp. A name such as uuid or text is then always
--      the system's own. Nothing else changes for these functions: they already name app. and
--      public. in full wherever they use them, because the path was empty.
--
--   2. The app's roles can no longer make temporary objects in this database at all. The app
--      uses none. Every other role that had the right through PUBLIC is given it by name, so
--      nothing that Supabase itself runs is changed.
--
-- From here on a function is written with SET search_path = pg_catalog, pg_temp, never with an
-- empty path (npm run check refuses the empty one in a new migration, and
-- src/modules/tenant/policies.test.ts reads the database's own list of functions).

DO $fix$
DECLARE
  f record;
BEGIN
  FOR f IN
    SELECT p.oid::regprocedure AS signature
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'app'
      AND p.prokind IN ('f', 'p')
      -- An empty path, or none at all.
      AND (EXISTS (SELECT 1 FROM unnest(p.proconfig) c WHERE c = 'search_path=""')
           OR NOT EXISTS (SELECT 1 FROM unnest(coalesce(p.proconfig, '{}')) c WHERE c LIKE 'search_path=%'))
  LOOP
    EXECUTE format('ALTER FUNCTION %s SET search_path = pg_catalog, pg_temp', f.signature);
  END LOOP;
END $fix$;
--> statement-breakpoint

DO $fix$
DECLARE
  r record;
BEGIN
  -- Whoever has the right only through PUBLIC keeps it by name, except the app's own roles.
  FOR r IN
    SELECT rolname FROM pg_catalog.pg_roles
    WHERE rolname !~ '^pg_' AND rolname NOT IN ('app_runtime', 'anon', 'authenticated')
      AND pg_catalog.has_database_privilege(rolname, current_database(), 'TEMPORARY')
  LOOP
    EXECUTE format('GRANT TEMPORARY ON DATABASE %I TO %I', current_database(), r.rolname);
  END LOOP;
  EXECUTE format('REVOKE TEMPORARY ON DATABASE %I FROM PUBLIC', current_database());
  EXECUTE format('REVOKE TEMPORARY ON DATABASE %I FROM app_runtime, anon, authenticated', current_database());
  IF pg_catalog.has_database_privilege('app_runtime', current_database(), 'TEMPORARY') THEN
    RAISE EXCEPTION 'app_runtime can still make temporary objects in this database';
  END IF;
END $fix$;

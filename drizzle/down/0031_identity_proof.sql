-- Reverses drizzle/0031_identity_proof.sql. Never run automatically, and there is no good reason
-- to run it: it puts back both holes that migration closed (a session of the app's role naming
-- any user, and one statement answered for two companies). It exists because every migration
-- has a file that reverses it. Run it by hand, as postgres, only after showing it to the founder
-- and getting a yes, and only with a version of the web app that writes the two settings
-- app.user_id and app.tenant_id again (the app from 0030 on calls app.enter, which this removes).
--
-- It removes the installed keys (the secret itself stays wherever the web app keeps it). No
-- company data is touched.

BEGIN;

-- The five functions as drizzle/0000_tenancy.sql wrote them, reading the two settings, with the
-- search path drizzle/0023_safe_search_path.sql gave them.
CREATE OR REPLACE FUNCTION app.current_user_id() RETURNS uuid
  LANGUAGE sql STABLE SECURITY INVOKER SET search_path = pg_catalog, pg_temp
  AS $$ SELECT nullif(current_setting('app.user_id', true), '')::uuid $$;

CREATE OR REPLACE FUNCTION app.tenant_id() RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
  AS $$
    SELECT m.tenant_id
    FROM public.memberships m
    WHERE m.tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
      AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
      AND m.active
  $$;

CREATE OR REPLACE FUNCTION app.tenant_role() RETURNS public.member_role
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
  AS $$
    SELECT m.role
    FROM public.memberships m
    WHERE m.tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
      AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
      AND m.active
  $$;

CREATE OR REPLACE FUNCTION app.tenant_branch_ids() RETURNS uuid[]
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
  AS $$
    SELECT m.branch_ids
    FROM public.memberships m
    WHERE m.tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
      AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
      AND m.active
  $$;

CREATE OR REPLACE FUNCTION app.member_tenant_ids() RETURNS SETOF uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
  AS $$
    SELECT m.tenant_id
    FROM public.memberships m
    WHERE m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
      AND m.active
  $$;

DROP FUNCTION app.identity_now();
DROP FUNCTION app.enter(uuid, uuid, bigint, text);
DROP TABLE app.identity_sessions;
DROP TABLE app.identity_keys;

-- The row drizzle-kit wrote for 0031_identity_proof (its "when" in drizzle/meta/_journal.json).
DELETE FROM drizzle.__drizzle_migrations WHERE created_at = 1794917214189;
COMMIT;

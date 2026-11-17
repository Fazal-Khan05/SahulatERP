-- Security: the database asks for proof of who is signed in, and no longer takes it on trust.
-- track: joint
--
-- Hand-written; nothing here is managed by Drizzle. Two small tables in schema app, no change to
-- any company table, no data changes. Reverse with drizzle/down/0030_identity_proof.sql.
--
-- Until now the web app told the database who was signed in by writing two settings at the start
-- of each transaction (app.user_id, app.tenant_id), and five functions read them. Any session of
-- the app's role can write those settings, so a session running SQL of its own choosing could:
--
--   1. name any user, and read and write as that user (docs/later/preparation.md, tried on a
--      local database on 2026-11-13);
--   2. change app.tenant_id part-way through ONE statement, so that a policy's two questions
--      ("which company?", "which role?") were answered for two different companies: a
--      salesperson in company A who owns a company B read A's owner-only rows
--      (docs/later/step-25.md, found by the reviewer of Step 25 and reproduced on 2026-11-15).
--
-- Neither can be done from the app's screens: both need a way to run one's own SQL as
-- app_runtime. This migration closes both for that case too.
--
-- How it works now:
--
--   * The app calls app.enter(user, tenant, expires, signature) at the start of a transaction
--     (src/db/with-tenant.ts). The signature is an HMAC-SHA256, made with a secret the web app
--     holds, over those three values.
--   * The database holds the same secret in app.identity_keys, which the app's role cannot read,
--     and app.enter checks the signature. If it is right, app.enter writes "this transaction is
--     user U in company T" into app.identity_sessions, which only it can write.
--   * The five functions every policy and guard asks (app.current_user_id, app.tenant_id,
--     app.tenant_role, app.tenant_branch_ids, app.member_tenant_ids) answer from that row. They
--     are STABLE, so within one statement they all see the row as it was when the statement
--     began: a switch made inside a statement is not seen by that statement, which is what
--     closes (2). No policy is rewritten.
--
-- Until a key is installed (npm run db:identity -- install) the database behaves as before: an
-- unsigned app.enter is accepted, and a transaction that never called app.enter is still read
-- from the two settings. That is what lets this migration be applied before the new app is
-- deployed, and lets a development database run without a secret. Installing the key is the
-- moment the proof becomes required; from then on the two settings mean nothing.
--
-- The signature is passed as a bind parameter, never written into the statement: a session can
-- see the text of other sessions' statements of the same role (pg_stat_activity), but not their
-- parameters.

-- The secret, as the two padded halves HMAC needs (the key XOR 0x36 and XOR 0x5c, 64 bytes
-- each), so that the check needs only the built-in sha256 and no extension. Two slots, so a
-- key can be changed without a moment in which neither the old nor the new one is accepted.
CREATE TABLE app.identity_keys (
  slot smallint PRIMARY KEY CHECK (slot IN (1, 2)),
  inner_key bytea NOT NULL CHECK (octet_length(inner_key) = 64),
  outer_key bytea NOT NULL CHECK (octet_length(outer_key) = 64),
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE app.identity_keys ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON TABLE app.identity_keys FROM PUBLIC, app_runtime, anon, authenticated;
--> statement-breakpoint

-- Who each open transaction is. One row for each database connection, written over at the
-- start of every transaction, so it never grows; a row counts only for the transaction that
-- wrote it (xid). Unlogged: nothing in it outlives its transaction.
CREATE UNLOGGED TABLE app.identity_sessions (
  pid integer PRIMARY KEY,
  xid xid8 NOT NULL,
  user_id uuid NOT NULL,
  tenant_id uuid
) WITH (fillfactor = 50);
--> statement-breakpoint
ALTER TABLE app.identity_sessions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON TABLE app.identity_sessions FROM PUBLIC, app_runtime, anon, authenticated;
--> statement-breakpoint

-- Says who this transaction is, and moves it to another company when called again. Returns the
-- company as text ('' for none), as set_config did.
CREATE FUNCTION app.enter(p_user uuid, p_tenant uuid, p_expires bigint, p_signature text) RETURNS text
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_message bytea;
  v_given bytea;
  v_valid boolean := false;
  k record;
BEGIN
  IF p_user IS NULL THEN
    RAISE EXCEPTION 'who is signed in is needed' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF EXISTS (SELECT 1 FROM app.identity_keys) THEN
    IF p_expires IS NULL OR p_signature IS NULL OR p_signature !~ '^[0-9a-f]{64}$' THEN
      RAISE EXCEPTION 'the proof of who is signed in is missing' USING ERRCODE = 'insufficient_privilege';
    END IF;
    -- A proof is made for the transaction it opens and is good for a short while only.
    IF p_expires <= extract(epoch FROM clock_timestamp()) OR p_expires > extract(epoch FROM clock_timestamp()) + 600 THEN
      RAISE EXCEPTION 'the proof of who is signed in is out of date' USING ERRCODE = 'insufficient_privilege';
    END IF;
    v_message := convert_to(format('sahulaterp-identity-v1|%s|%s|%s', p_user::text, coalesce(p_tenant::text, ''), p_expires::text), 'UTF8');
    v_given := decode(p_signature, 'hex');
    -- Every key is tried and the two are compared by their hashes, so the time this takes says
    -- nothing about how much of a guessed signature was right.
    FOR k IN SELECT inner_key, outer_key FROM app.identity_keys LOOP
      IF sha256(sha256(k.outer_key || sha256(k.inner_key || v_message))) = sha256(v_given) THEN
        v_valid := true;
      END IF;
    END LOOP;
    IF NOT v_valid THEN
      RAISE EXCEPTION 'the proof of who is signed in is not valid' USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  INSERT INTO app.identity_sessions AS s (pid, xid, user_id, tenant_id)
  VALUES (pg_backend_pid(), pg_current_xact_id(), p_user, p_tenant)
  ON CONFLICT (pid) DO UPDATE SET xid = excluded.xid, user_id = excluded.user_id, tenant_id = excluded.tenant_id;
  RETURN coalesce(p_tenant::text, '');
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.enter(uuid, uuid, bigint, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.enter(uuid, uuid, bigint, text) TO app_runtime;
--> statement-breakpoint

-- Who this transaction is: the row app.enter wrote for it. Without one, and only while no key
-- is installed, the two settings, as before this migration. Always one row; both columns null
-- for nobody. For the five functions below only: nobody else may call it.
CREATE FUNCTION app.identity_now() RETURNS TABLE (user_id uuid, tenant_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
  AS $$
    SELECT CASE WHEN s.pid IS NOT NULL THEN s.user_id ELSE f.user_id END,
           CASE WHEN s.pid IS NOT NULL THEN s.tenant_id ELSE f.tenant_id END
    FROM (SELECT 1) one
    LEFT JOIN app.identity_sessions s ON s.pid = pg_backend_pid() AND s.xid = pg_current_xact_id_if_assigned()
    LEFT JOIN LATERAL (
      SELECT nullif(current_setting('app.user_id', true), '')::uuid AS user_id,
             nullif(current_setting('app.tenant_id', true), '')::uuid AS tenant_id
      WHERE s.pid IS NULL AND NOT EXISTS (SELECT 1 FROM app.identity_keys)
    ) f ON true
  $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.identity_now() FROM PUBLIC;
--> statement-breakpoint

-- The five functions of drizzle/0000_tenancy.sql, each answering as it did, from app.identity_now()
-- where it read the settings. Replaced in place, so every grant and every policy that names them
-- stays as it is.
CREATE OR REPLACE FUNCTION app.current_user_id() RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
  AS $$ SELECT i.user_id FROM app.identity_now() i $$;
--> statement-breakpoint

-- The tenant this transaction runs in, or null unless the current user is an active member of it.
CREATE OR REPLACE FUNCTION app.tenant_id() RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
  AS $$
    SELECT m.tenant_id
    FROM app.identity_now() i
    JOIN public.memberships m ON m.tenant_id = i.tenant_id AND m.user_id = i.user_id
    WHERE m.active
  $$;
--> statement-breakpoint

-- The current user's role in that tenant, or null.
CREATE OR REPLACE FUNCTION app.tenant_role() RETURNS public.member_role
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
  AS $$
    SELECT m.role
    FROM app.identity_now() i
    JOIN public.memberships m ON m.tenant_id = i.tenant_id AND m.user_id = i.user_id
    WHERE m.active
  $$;
--> statement-breakpoint

-- The current user's branch scope in that tenant: null = every branch, a list = only those.
-- Also null for a non-member, so policies always pair it with tenant_id = app.tenant_id().
CREATE OR REPLACE FUNCTION app.tenant_branch_ids() RETURNS uuid[]
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
  AS $$
    SELECT m.branch_ids
    FROM app.identity_now() i
    JOIN public.memberships m ON m.tenant_id = i.tenant_id AND m.user_id = i.user_id
    WHERE m.active
  $$;
--> statement-breakpoint

-- Every tenant the current user is an active member of (for the tenant switcher).
CREATE OR REPLACE FUNCTION app.member_tenant_ids() RETURNS SETOF uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
  AS $$
    SELECT m.tenant_id
    FROM app.identity_now() i
    JOIN public.memberships m ON m.user_id = i.user_id
    WHERE m.active
  $$;
--> statement-breakpoint

-- The app's roles must have no way to the secret or to the record of who each transaction is,
-- and no way to ask app.identity_now() themselves.
DO $check$
DECLARE
  r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['app_runtime', 'anon', 'authenticated'] LOOP
    IF pg_catalog.has_table_privilege(r, 'app.identity_keys', 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE')
       OR pg_catalog.has_table_privilege(r, 'app.identity_sessions', 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE')
       OR pg_catalog.has_function_privilege(r, 'app.identity_now()', 'EXECUTE') THEN
      RAISE EXCEPTION '% can reach the proof of who is signed in', r;
    END IF;
  END LOOP;
END $check$;

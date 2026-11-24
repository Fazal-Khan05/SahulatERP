-- Reverses drizzle/0043_security_clean_up.sql. Never run automatically. Run it by hand, as
-- postgres, only after showing it to the founder and getting a yes. No row of any company
-- changes. It puts back every weakness that migration closed: a member can again take a
-- document number and throw it away, an audit action can again look like the database's own,
-- the app's role has no time limits, and a database with no shared secret installed takes the
-- app's word for who is signed in.
--
-- BEFORE running it: the app must be signing with the shared secret (IDENTITY_SIGNING_SECRET)
-- and that secret must be installed, or every page comes back empty; a proof signed with a
-- private key means nothing to the database afterwards. And put the earlier app back first: the
-- app of this migration asks for app.next_journal_number, which this removes.

BEGIN;
-- 4 and 5: the flag and its question, then the two functions as they were in 0031.
CREATE SEQUENCE app.identity_proof_flag AS smallint MINVALUE 1 MAXVALUE 2 START 1 NO CYCLE;
REVOKE ALL ON SEQUENCE app.identity_proof_flag FROM PUBLIC, app_runtime, anon, authenticated, service_role;
SELECT setval('app.identity_proof_flag', 2) WHERE EXISTS (SELECT 1 FROM app.identity_keys);
CREATE FUNCTION app.identity_proof_wanted() RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
  AS $$ SELECT (SELECT f.last_value FROM app.identity_proof_flag f) > 1 OR EXISTS (SELECT 1 FROM app.identity_keys) $$;
REVOKE ALL ON FUNCTION app.identity_proof_wanted() FROM PUBLIC;

CREATE OR REPLACE FUNCTION app.enter(p_user uuid, p_tenant uuid, p_expires bigint, p_signature text)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE
  v_message bytea;
  v_given bytea;
  v_valid boolean := false;
  v_wanted boolean := app.identity_proof_wanted();
  k record;
BEGIN
  IF p_user IS NULL THEN
    RAISE EXCEPTION 'who is signed in is needed' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF v_wanted THEN
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
  -- Reached with a proof wanted only if one was checked: v_wanted is then what "proven" means.
  INSERT INTO app.identity_sessions AS s (pid, xid, user_id, tenant_id, proven)
  VALUES (pg_backend_pid(), pg_current_xact_id(), p_user, p_tenant, v_wanted)
  ON CONFLICT (pid) DO UPDATE SET xid = excluded.xid, user_id = excluded.user_id, tenant_id = excluded.tenant_id, proven = excluded.proven;
  RETURN coalesce(p_tenant::text, '');
END $function$
;

CREATE OR REPLACE FUNCTION app.identity_now()
 RETURNS TABLE(user_id uuid, tenant_id uuid)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
    SELECT CASE WHEN s.pid IS NOT NULL THEN s.user_id ELSE f.user_id END,
           CASE WHEN s.pid IS NOT NULL THEN s.tenant_id ELSE f.tenant_id END
    FROM (SELECT 1) one
    LEFT JOIN app.identity_sessions s ON s.pid = pg_backend_pid() AND s.xid = pg_current_xact_id_if_assigned()
      AND (s.proven OR NOT app.identity_proof_wanted())
    LEFT JOIN LATERAL (
      SELECT CASE WHEN v.user_id ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN v.user_id::uuid END AS user_id,
             CASE WHEN v.tenant_id ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN v.tenant_id::uuid END AS tenant_id
      FROM (SELECT current_setting('app.user_id', true) AS user_id, current_setting('app.tenant_id', true) AS tenant_id) v
      WHERE s.pid IS NULL AND NOT app.identity_proof_wanted()
    ) f ON true
  $function$
;

DROP FUNCTION app.identity_signature_valid(numeric, integer, bytea, bytea);
DROP FUNCTION app.identity_number(bytea);
DROP TABLE app.identity_public_keys;
ALTER TABLE app.identity_sessions DROP COLUMN proof, DROP COLUMN proof_expires;

-- 3: the role's limits in this database.
DO $$
BEGIN
  EXECUTE format('ALTER ROLE app_runtime IN DATABASE %I RESET statement_timeout', current_database());
  EXECUTE format('ALTER ROLE app_runtime IN DATABASE %I RESET lock_timeout', current_database());
  EXECUTE format('ALTER ROLE app_runtime IN DATABASE %I RESET idle_in_transaction_session_timeout', current_database());
END $$;

-- 2: the shape of an audit action.
ALTER TABLE public.audit_log DROP CONSTRAINT audit_log_action_format;

-- 1: the app's role may call the numbering function again.
DROP TRIGGER number_series_journal_number_used ON public.number_series;
DROP FUNCTION app.check_journal_number_used();
DROP FUNCTION app.next_journal_number(date);
GRANT EXECUTE ON FUNCTION app.next_document_number(text, date) TO app_runtime;

-- The row drizzle-kit wrote for 0043_security_clean_up (its "when" in drizzle/meta/_journal.json).
DELETE FROM drizzle.__drizzle_migrations WHERE created_at = 1795529384925;
COMMIT;

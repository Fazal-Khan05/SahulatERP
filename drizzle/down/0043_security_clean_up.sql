-- Reverses drizzle/0043_security_clean_up.sql. Never run automatically. Run it by hand, as
-- postgres, only after showing it to the founder and getting a yes. No row of any company
-- changes. It puts back every weakness that migration closed: a member can again take a
-- document number and throw it away, an audit action can again look like the database's own,
-- the app's role has no time limits, and a database with no shared secret installed takes the
-- app's word for who is signed in.
--
-- BEFORE running it: the app must be signing with the shared secret (IDENTITY_SIGNING_SECRET)
-- and that secret must be installed in this database: a proof signed with a private key means
-- nothing to the database afterwards. This file REFUSES TO RUN on a database with no shared
-- secret installed, because the functions it puts back would then take anyone's word for who
-- they are (found by the reviewer of the migration). And put the earlier app back first: the app
-- of this migration lets the database number a manual journal, and the earlier one names the number.

BEGIN;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM app.identity_keys) THEN
    RAISE EXCEPTION 'no shared secret is installed in this database: reversing now would make it believe anyone. Install one first (npm run db:identity -- install --with-secret, with IDENTITY_SIGNING_SECRET set), and have the app sign with it.';
  END IF;
END $$;
-- 4 and 5: the flag and its question, then the two functions as they were in 0031.
CREATE SEQUENCE app.identity_proof_flag AS smallint MINVALUE 1 MAXVALUE 2 START 1 NO CYCLE;
REVOKE ALL ON SEQUENCE app.identity_proof_flag FROM PUBLIC, app_runtime, anon, authenticated, service_role;
-- A proof is wanted from the first moment: a shared secret is installed (checked above).
SELECT setval('app.identity_proof_flag', 2);
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
  IF current_setting('server_version_num')::int >= 170000 THEN
    EXECUTE format('ALTER ROLE app_runtime IN DATABASE %I RESET transaction_timeout', current_database());
  END IF;
  EXECUTE format('ALTER ROLE app_runtime IN DATABASE %I RESET statement_timeout', current_database());
  EXECUTE format('ALTER ROLE app_runtime IN DATABASE %I RESET lock_timeout', current_database());
  EXECUTE format('ALTER ROLE app_runtime IN DATABASE %I RESET idle_in_transaction_session_timeout', current_database());
END $$;

-- 2: the shape of an audit action.
ALTER TABLE public.audit_log DROP CONSTRAINT audit_log_action_format;

-- 1: the app's role may call the numbering function again, and app.post_journal writes the
-- number it is given, as in drizzle/0018_sales_invoices.sql.
CREATE OR REPLACE FUNCTION app.post_journal(p_date date, p_source_type text, p_source_id uuid, p_lines jsonb, p_memo text DEFAULT NULL::text, p_branch_id uuid DEFAULT NULL::uuid, p_document_number text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE
  v_tenant uuid := app.tenant_id();
  v_user uuid := app.current_user_id();
  v_role public.member_role := app.tenant_role();
  v_scope uuid[] := app.tenant_branch_ids();
  v_roles public.member_role[] := app.journal_source_roles(p_source_type);
  v_journal uuid;
  v_lines integer;
  v_debit numeric;
  v_credit numeric;
  v_blocked text;
BEGIN
  IF v_tenant IS NULL OR v_user IS NULL OR v_role IS NULL THEN
    RAISE EXCEPTION 'not a member of this company' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF v_roles IS NULL THEN
    RAISE EXCEPTION 'unknown kind of journal source' USING ERRCODE = 'check_violation';
  END IF;
  -- The balance is checked when the transaction ends, whatever the caller set before this.
  SET CONSTRAINTS public.journals_balanced, public.journal_lines_balanced, public.journals_with_document DEFERRED;
  IF NOT (v_role = ANY (v_roles)) THEN
    RAISE EXCEPTION 'this role cannot post that kind of journal' USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- A member limited to some branches posts to one of them, never company-wide.
  IF v_scope IS NOT NULL AND (p_branch_id IS NULL OR NOT (p_branch_id = ANY (v_scope))) THEN
    RAISE EXCEPTION 'a member limited to some branches posts to one of them' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_date IS NULL OR p_source_id IS NULL THEN
    RAISE EXCEPTION 'a journal needs a date and a source' USING ERRCODE = 'check_violation';
  END IF;
  IF p_lines IS NULL OR jsonb_typeof(p_lines) <> 'array' OR jsonb_array_length(p_lines) NOT BETWEEN 2 AND 1000 THEN
    RAISE EXCEPTION 'a journal has between 2 and 1,000 lines' USING ERRCODE = 'SE003';
  END IF;
  -- An amount is a real number ("not a number" is a value numeric accepts) and is never rounded
  -- behind anyone's back: more than four decimals is refused.
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_lines) AS l(value)
    WHERE coalesce((l.value->>'debit')::numeric, 0) = 'NaN'::numeric
       OR coalesce((l.value->>'credit')::numeric, 0) = 'NaN'::numeric
       OR coalesce((l.value->>'debit')::numeric, 0) <> round(coalesce((l.value->>'debit')::numeric, 0), 4)
       OR coalesce((l.value->>'credit')::numeric, 0) <> round(coalesce((l.value->>'credit')::numeric, 0), 4)
  ) THEN
    RAISE EXCEPTION 'an amount is a number with at most four decimals' USING ERRCODE = 'check_violation';
  END IF;
  -- Cost centres do not exist yet; a line can never be corrected, so none is accepted.
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_lines) AS l(value) WHERE nullif(l.value->>'cost_centre_id', '') IS NOT NULL) THEN
    RAISE EXCEPTION 'cost centres are not available yet' USING ERRCODE = 'check_violation';
  END IF;
  -- Before anything is written: an account this kind of journal may not touch.
  SELECT a.code INTO v_blocked
    FROM jsonb_array_elements(p_lines) AS l(value)
    JOIN public.accounts a ON a.tenant_id = v_tenant AND a.id = (l.value->>'account_id')::uuid
    WHERE a.control_type = ANY (app.journal_source_blocked_controls(p_source_type))
    LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'account % cannot be posted to by this kind of journal', v_blocked USING ERRCODE = 'SE005';
  END IF;
  PERFORM app.require_open_period(v_tenant, p_date);

  INSERT INTO public.journals (tenant_id, journal_date, source_type, source_id, document_number, memo, branch_id, created_by)
    VALUES (v_tenant, p_date, p_source_type, p_source_id, nullif(btrim(p_document_number), ''), nullif(btrim(p_memo), ''), p_branch_id, v_user)
    RETURNING id INTO v_journal;
  INSERT INTO public.journal_lines (tenant_id, journal_id, line_no, account_id, debit, credit, description, customer_id, supplier_id)
    SELECT v_tenant, v_journal, l.line_no,
      (l.value->>'account_id')::uuid,
      coalesce((l.value->>'debit')::numeric, 0),
      coalesce((l.value->>'credit')::numeric, 0),
      nullif(btrim(l.value->>'description'), ''),
      (l.value->>'customer_id')::uuid,
      (l.value->>'supplier_id')::uuid
    FROM jsonb_array_elements(p_lines) WITH ORDINALITY AS l(value, line_no);

  SELECT count(*), sum(l.debit), sum(l.credit) INTO v_lines, v_debit, v_credit
    FROM public.journal_lines l WHERE l.tenant_id = v_tenant AND l.journal_id = v_journal;
  IF v_debit IS DISTINCT FROM v_credit OR v_debit = 'NaN'::numeric THEN
    RAISE EXCEPTION 'the journal does not balance: debits %, credits %', v_debit, v_credit USING ERRCODE = 'SE003';
  END IF;

  INSERT INTO public.audit_log (tenant_id, actor_user_id, actor_role, action, entity, entity_id, after)
    VALUES (v_tenant, v_user, v_role, 'journal.post', 'journal', v_journal,
      jsonb_build_object('date', p_date, 'source', p_source_type, 'sourceId', p_source_id,
        'number', nullif(btrim(p_document_number), ''), 'lines', v_lines, 'total', v_debit::text));
  RETURN v_journal;
END $function$
;
GRANT EXECUTE ON FUNCTION app.next_document_number(text, date) TO app_runtime;

-- The row drizzle-kit wrote for 0043_security_clean_up (its "when" in drizzle/meta/_journal.json).
DELETE FROM drizzle.__drizzle_migrations WHERE created_at = 1795529384925;
COMMIT;

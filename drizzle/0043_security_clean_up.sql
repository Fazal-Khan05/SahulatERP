-- The security clean-up after Step 47: five things earlier reviews found and left
-- (docs/later/security-clean-up.md has each as it was, as it is now, and what it does not do).
-- track: joint
--
-- Hand-written but for the one rule on audit_log (Drizzle's). No row of any company changes.
-- Reverse with drizzle/down/0043_security_clean_up.sql.
--
--   1. A member could take a document number and throw it away.
--   2. An audit row could carry a name that only looks like one the database writes.
--   3. The app's database role had no time limits.
--   4. A database with no key installed took the app's word for who is signed in.
--   5. Whoever can read every table could read the key the proof is signed with.
--
-- Functions of earlier steps written again: app.enter(uuid, uuid, bigint, text) and
-- app.identity_now() (both drizzle/0031_identity_proof.sql). Removed: app.identity_proof_wanted()
-- and the sequence app.identity_proof_flag (0031). app.next_document_number is not written
-- again; the app's role loses the right to call it.
--
-- BEFORE THIS IS APPLIED TO A DATABASE, that database needs something installed to check a
-- proof against (npm run db:identity -- status says; install puts it in). After it, a database
-- with nothing installed shows nothing to anyone.

-- ── 1. A document number is taken only by what writes the document ──────────────────────────────
-- Any member but the auditor could call app.next_document_number directly and leave a gap in a
-- series (found by the reviewer of Step 24). It was open to the app's role because a manual
-- journal took its number through it from the app. Every other caller is a function that posts
-- a document and runs as the owner, so the app's role no longer needs it. The function itself
-- is not written again (it never is: drizzle/0019_journal_documents.sql); only who may call it.
REVOKE EXECUTE ON FUNCTION app.next_document_number(text, date) FROM app_runtime;
--> statement-breakpoint

-- The one number the app takes for itself: a manual journal's, by those who write journals.
-- It must be used: see the trigger below.
CREATE FUNCTION app.next_journal_number(p_date date) RETURNS text
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  IF app.tenant_id() IS NULL OR app.tenant_role() IS NULL OR app.tenant_role() NOT IN ('owner', 'accountant') THEN
    RAISE EXCEPTION 'not allowed to number a journal' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN app.next_document_number('JV', p_date);
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.next_journal_number(date) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.next_journal_number(date) TO app_runtime;
--> statement-breakpoint

-- Asked when the transaction ends, for every journal number taken in it: a journal of the
-- company carries that number, or the transaction does not end and the number goes back. The
-- number is built here exactly as app.next_document_number builds it. (A journal that carries a
-- number is itself held to its manual journal by the checks of drizzle/0019_journal_documents.sql.)
CREATE FUNCTION app.check_journal_number_used() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_taken bigint := NEW.next_number - 1;
  v_number text := NEW.document_type || '-' || NEW.year_code || '-' || CASE WHEN v_taken < 100000 THEN lpad(v_taken::text, 5, '0') ELSE v_taken::text END;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.journals j WHERE j.tenant_id = NEW.tenant_id AND j.document_number = v_number) THEN
    RAISE EXCEPTION 'the number % was taken and no journal carries it', v_number USING ERRCODE = 'SE004';
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.check_journal_number_used() FROM PUBLIC;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER number_series_journal_number_used
  AFTER INSERT OR UPDATE ON public.number_series
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (NEW.document_type = 'JV') EXECUTE FUNCTION app.check_journal_number_used();
--> statement-breakpoint
ALTER TABLE public.number_series ENABLE ALWAYS TRIGGER number_series_journal_number_used;
--> statement-breakpoint

-- ── 2. An audit action has one shape ────────────────────────────────────────────────────────────
-- The audit rows only the database may write are protected by their exact names
-- (app.audit_action_reserved). 'journal.post ' with a space at the end, a capital, or a letter of
-- another alphabet went in as the app's role. An action is now lower-case words joined by full
-- stops and nothing else. NOT VALID: the rows already in the log are not looked at (the log
-- cannot be changed, so one that did not fit could not be put right); every new row is.
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_action_format" CHECK ("audit_log"."action" ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$' and length("audit_log"."action") <= 80) NOT VALID;
--> statement-breakpoint

-- ── 3. Time limits for the app's role ───────────────────────────────────────────────────────────
-- A statement that runs away, a wait for a lock that never comes, and a transaction left open
-- (which, holding a document number, stops a whole company posting) each waited for ever. These
-- are the role's starting values in this database. A session can set them aside for itself, so
-- they bound accidents and not someone running SQL of their own (docs/later/security-clean-up.md).
DO $$
BEGIN
  EXECUTE format('ALTER ROLE app_runtime IN DATABASE %I SET statement_timeout = %L', current_database(), '60s');
  EXECUTE format('ALTER ROLE app_runtime IN DATABASE %I SET lock_timeout = %L', current_database(), '15s');
  EXECUTE format('ALTER ROLE app_runtime IN DATABASE %I SET idle_in_transaction_session_timeout = %L', current_database(), '60s');
END $$;
--> statement-breakpoint

-- ── 4 and 5. Who is signed in: always proven, and provable with a key that is no secret ─────────

-- A public key the proof can be checked against: the modulus of an RSA key (its exponent is
-- always 65537) and its length in bytes. Nothing here is secret: whoever reads this table can
-- check a proof and cannot make one. Two slots, as for the secret, so a key can be changed
-- without a moment in which neither is accepted. Only the owner of the database writes it
-- (npm run db:identity).
CREATE TABLE app.identity_public_keys (
  slot smallint PRIMARY KEY CHECK (slot IN (1, 2)),
  modulus numeric NOT NULL,
  bytes integer NOT NULL CHECK (bytes IN (256, 384, 512)),
  created_at timestamptz NOT NULL DEFAULT now(),
  -- A modulus of exactly that many bytes, and odd, as every RSA modulus is.
  CONSTRAINT identity_public_keys_modulus_fits CHECK (modulus = trunc(modulus) AND modulus >= power(2::numeric, bytes * 8 - 1) AND modulus < power(2::numeric, bytes * 8) AND modulus % 2 = 1)
);
--> statement-breakpoint
ALTER TABLE app.identity_public_keys ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON TABLE app.identity_public_keys FROM PUBLIC, app_runtime, anon, authenticated, service_role;
--> statement-breakpoint

-- The proof last checked on each connection: the hash of its signature and when it runs out.
-- The same proof shown again on the same connection is not worked out again (the app shows one
-- proof for a minute, and checking a public-key signature takes about a millisecond).
ALTER TABLE app.identity_sessions ADD COLUMN proof bytea, ADD COLUMN proof_expires bigint;
--> statement-breakpoint

-- Bytes as a whole number, most significant first. For app.identity_signature_valid only.
CREATE FUNCTION app.identity_number(p_bytes bytea) RETURNS numeric
  LANGUAGE plpgsql IMMUTABLE STRICT SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_number numeric := 0;
  v_length integer := octet_length(p_bytes);
  v_at integer := 0;
  v_take integer;
BEGIN
  -- Seven bytes at a time: each piece fits a bigint with room to spare.
  WHILE v_at < v_length LOOP
    v_take := least(7, v_length - v_at);
    v_number := v_number * (256::numeric ^ v_take)::numeric(20, 0)
      + ('x' || lpad(encode(substring(p_bytes FROM v_at + 1 FOR v_take), 'hex'), 16, '0'))::bit(64)::bigint;
    v_at := v_at + v_take;
  END LOOP;
  RETURN v_number;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.identity_number(bytea) FROM PUBLIC;
--> statement-breakpoint

-- Is this the signature of this message by the key with this modulus? RSA with SHA-256 and
-- the padding of PKCS #1 v1.5 (what Node's "RSA-SHA256" makes), exponent 65537, with nothing
-- but the built-in numbers and sha256, so no extension is needed.
--
-- The signature is raised to the exponent, and the result is compared WHOLE with what the
-- signed message must give: 00 01 FF..FF 00, the name of SHA-256, the hash. Nothing of the
-- result is read or taken apart, which is where checks of this padding have gone wrong before.
CREATE FUNCTION app.identity_signature_valid(p_modulus numeric, p_bytes integer, p_message bytea, p_signature bytea) RETURNS boolean
  LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_signature numeric;
  v_result numeric;
  v_expected bytea;
BEGIN
  IF p_modulus IS NULL OR p_bytes IS NULL OR p_message IS NULL OR p_signature IS NULL
     OR p_bytes NOT IN (256, 384, 512) OR octet_length(p_signature) <> p_bytes THEN
    RETURN false;
  END IF;
  v_signature := app.identity_number(p_signature);
  IF v_signature >= p_modulus THEN
    RETURN false;
  END IF;
  -- To the power 65537: squared sixteen times, then once more by itself.
  v_result := v_signature;
  FOR i IN 1..16 LOOP
    v_result := (v_result * v_result) % p_modulus;
  END LOOP;
  v_result := (v_result * v_signature) % p_modulus;
  v_expected := '\x0001'::bytea || decode(repeat('ff', p_bytes - 54), 'hex') || '\x00'::bytea
    || '\x3031300d060960864801650304020105000420'::bytea || sha256(p_message);
  RETURN v_result = app.identity_number(v_expected);
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.identity_signature_valid(numeric, integer, bytea, bytea) FROM PUBLIC;
--> statement-breakpoint

-- app.enter of drizzle/0031_identity_proof.sql, with two changes.
--
-- It no longer takes anyone's word. Until now a database with no key installed accepted an
-- unsigned call, which let 0031 go in before the app that signs was deployed and let a
-- development database run without a secret. Every database now has a key (npm run db:local
-- installs one), so a call without a valid proof is refused everywhere, and a database with no
-- key shows nothing.
--
-- And a proof may be signed with a private key whose public half is in
-- app.identity_public_keys, as well as with the shared secret of app.identity_keys. The two are
-- told apart by their length and are over different texts ("...-v1|" and "...-v2|"), so one is
-- never taken for the other. Once the app signs with the private key, the secret is removed
-- from the database (npm run db:identity -- retire-secret), and nothing that can be read here
-- is of any use to someone who wants to say they are somebody else.
CREATE OR REPLACE FUNCTION app.enter(p_user uuid, p_tenant uuid, p_expires bigint, p_signature text) RETURNS text
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_message bytea;
  v_given bytea;
  v_proof bytea;
  v_valid boolean := false;
  k record;
BEGIN
  IF p_user IS NULL THEN
    RAISE EXCEPTION 'who is signed in is needed' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  -- 64 characters for the shared secret's signature; 512, 768 or 1024 for a key of 2048, 3072 or 4096 bits.
  IF p_expires IS NULL OR p_signature IS NULL OR p_signature !~ '^[0-9a-f]+$' OR length(p_signature) NOT IN (64, 512, 768, 1024) THEN
    RAISE EXCEPTION 'the proof of who is signed in is missing' USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- A proof is good for a short while only.
  IF p_expires <= extract(epoch FROM clock_timestamp()) OR p_expires > extract(epoch FROM clock_timestamp()) + 600 THEN
    RAISE EXCEPTION 'the proof of who is signed in is out of date' USING ERRCODE = 'insufficient_privilege';
  END IF;
  v_given := decode(p_signature, 'hex');
  v_proof := sha256(v_given);
  -- The proof this connection checked last, shown again for the same user and company: it was
  -- valid then and has not run out. (Whoever shows it has it; a proof is good wherever it is shown.)
  SELECT true INTO v_valid FROM app.identity_sessions s
    WHERE s.pid = pg_backend_pid() AND s.proven AND s.user_id = p_user AND s.tenant_id IS NOT DISTINCT FROM p_tenant
      AND s.proof_expires = p_expires AND s.proof = v_proof;
  IF v_valid IS NOT TRUE THEN
    v_valid := false;
    IF octet_length(v_given) = 32 THEN
      v_message := convert_to(format('sahulaterp-identity-v1|%s|%s|%s', p_user::text, coalesce(p_tenant::text, ''), p_expires::text), 'UTF8');
      -- Every key is tried and the two are compared by their hashes, so the time this takes says
      -- nothing about how much of a guessed signature was right.
      FOR k IN SELECT inner_key, outer_key FROM app.identity_keys LOOP
        IF sha256(sha256(k.outer_key || sha256(k.inner_key || v_message))) = v_proof THEN
          v_valid := true;
        END IF;
      END LOOP;
    ELSE
      v_message := convert_to(format('sahulaterp-identity-v2|%s|%s|%s', p_user::text, coalesce(p_tenant::text, ''), p_expires::text), 'UTF8');
      FOR k IN SELECT modulus, bytes FROM app.identity_public_keys LOOP
        IF app.identity_signature_valid(k.modulus, k.bytes, v_message, v_given) THEN
          v_valid := true;
        END IF;
      END LOOP;
    END IF;
  END IF;
  IF NOT v_valid THEN
    RAISE EXCEPTION 'the proof of who is signed in is not valid' USING ERRCODE = 'insufficient_privilege';
  END IF;
  INSERT INTO app.identity_sessions AS s (pid, xid, user_id, tenant_id, proven, proof, proof_expires)
  VALUES (pg_backend_pid(), pg_current_xact_id(), p_user, p_tenant, true, v_proof, p_expires)
  ON CONFLICT (pid) DO UPDATE SET xid = excluded.xid, user_id = excluded.user_id, tenant_id = excluded.tenant_id, proven = true, proof = excluded.proof, proof_expires = excluded.proof_expires;
  RETURN coalesce(p_tenant::text, '');
END $$;
--> statement-breakpoint

-- Who this transaction is: the row app.enter wrote for it, after checking a proof. Nothing else
-- is believed: not the two settings of before 0031, and not a row written before this migration
-- without a proof. Always one row; both columns null for nobody.
CREATE OR REPLACE FUNCTION app.identity_now() RETURNS TABLE (user_id uuid, tenant_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
  AS $$
    SELECT s.user_id, s.tenant_id
    FROM (SELECT 1) one
    LEFT JOIN app.identity_sessions s ON s.pid = pg_backend_pid() AND s.xid = pg_current_xact_id_if_assigned() AND s.proven
  $$;
--> statement-breakpoint
-- "Is a proof wanted?" has one answer now, so nothing asks.
DROP FUNCTION app.identity_proof_wanted();
--> statement-breakpoint
DROP SEQUENCE app.identity_proof_flag;

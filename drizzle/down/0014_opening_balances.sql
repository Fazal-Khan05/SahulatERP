-- Reverses drizzle/0014_opening_balances.sql. Never run automatically. This DELETES every
-- company's opening entry and its lines, including each unpaid invoice and bill brought in at
-- opening. The journals they posted stay in the ledger. Run it by hand, as postgres, only after
-- showing it to the founder and getting a yes, and never once a real company has posted its
-- opening balances.

BEGIN;

DROP TABLE public.opening_balances, public.opening_entries;
DROP FUNCTION app.check_opening_balance();
DROP FUNCTION app.check_opening_entry();

-- The engine's check of a journal's date and the three lists of what may post, as
-- drizzle/0012_ledger.sql left them.
CREATE OR REPLACE FUNCTION app.require_open_period(p_tenant uuid, p_date date) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
  AS $$
DECLARE
  v_locked timestamptz;
BEGIN
  SELECT p.locked_at INTO v_locked FROM public.fiscal_periods p
    WHERE p.tenant_id = p_tenant AND p.starts_on <= p_date AND p.ends_on >= p_date
    FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no fiscal period covers %', p_date USING ERRCODE = 'SE001';
  END IF;
  IF v_locked IS NOT NULL THEN
    RAISE EXCEPTION 'the fiscal period of % is locked', p_date USING ERRCODE = 'SE002';
  END IF;
END $$;
CREATE OR REPLACE FUNCTION app.journal_source_roles(p_source_type text) RETURNS public.member_role[]
  LANGUAGE sql IMMUTABLE SET search_path = ''
  AS $$
    SELECT CASE p_source_type
      WHEN 'manual_journal' THEN ARRAY['owner', 'accountant']::public.member_role[]
    END
  $$;
CREATE OR REPLACE FUNCTION app.journal_source_reversal_roles(p_source_type text) RETURNS public.member_role[]
  LANGUAGE sql IMMUTABLE SET search_path = ''
  AS $$
    SELECT CASE p_source_type
      WHEN 'manual_journal' THEN ARRAY['owner', 'accountant']::public.member_role[]
    END
  $$;
CREATE OR REPLACE FUNCTION app.journal_source_blocked_controls(p_source_type text) RETURNS text[]
  LANGUAGE sql IMMUTABLE SET search_path = ''
  AS $$
    SELECT CASE p_source_type
      WHEN 'manual_journal' THEN ARRAY['ar', 'ap', 'inventory', 'customer_advances', 'supplier_advances', 'grni', 'goods_in_transit', 'cheques_in_hand']
      ELSE ARRAY[]::text[]
    END
  $$;

-- The row drizzle-kit wrote for 0014_opening_balances (its "when" in drizzle/meta/_journal.json).
DELETE FROM drizzle.__drizzle_migrations WHERE created_at = 1794543881442;

COMMIT;

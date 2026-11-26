-- Reverses drizzle/0046_daily_expenses.sql. Never run automatically. Run it by hand, as postgres,
-- only after showing it to the founder and getting a yes. It DELETES the record of which file is
-- the receipt of which expense (the files themselves stay, as files of the company the owner and
-- the auditor see), and an accountant can no longer store or read a receipt. Expenses that name
-- nobody stay as they are: the old rule is put back for new expenses only (NOT VALID), since a
-- posted expense is never changed.

BEGIN;
CREATE OR REPLACE FUNCTION app.record_expense(p_key uuid, p_date date, p_account uuid, p_supplier uuid, p_payee text, p_branch uuid, p_reference text, p_memo text, p_lines jsonb,
                                   p_income_tax_code text, p_provincial_tax_code text) RETURNS text
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_tenant uuid := app.tenant_id();
  v_user uuid := app.current_user_id();
  v_scope uuid[] := app.tenant_branch_ids();
  v_paid_from public.accounts%ROWTYPE;
  v_supplier public.suppliers%ROWTYPE;
  v_id uuid := coalesce(p_key, gen_random_uuid());
  v_line jsonb;
  v_ord bigint;
  v_shares jsonb := '{}'::jsonb;
  v_sent public.expenses%ROWTYPE;
  v_target public.accounts%ROWTYPE;
  v_count integer := 0;
  v_amount numeric := 0;
  v_provincial numeric := 0;
  v_provincial_rule public.withholding_rules%ROWTYPE;
  v_rule public.withholding_rules%ROWTYPE;
  v_rate numeric;
  v_base numeric;
  v_total numeric;
  v_withheld numeric := 0;
  v_on_list boolean := false;
  v_entries jsonb := '[]'::jsonb;
  v_entry jsonb;
  v_number text;
  v_journal uuid;
  v_no integer := 0;
  v_seen integer := 0;
  v_share numeric;
  v_shared numeric := 0;
  v_name text;
BEGIN
  PERFORM app.cash_bank_may_write(p_date);
  IF v_scope IS NOT NULL AND (p_branch IS NULL OR NOT (p_branch = ANY (v_scope))) THEN
    RAISE EXCEPTION 'choose one of your branches' USING ERRCODE = 'SE336';
  END IF;
  IF p_branch IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.branches b WHERE b.tenant_id = v_tenant AND b.id = p_branch) THEN
    RAISE EXCEPTION 'choose one of your branches' USING ERRCODE = 'SE336';
  END IF;
  v_paid_from := app.cash_bank_account(v_tenant, p_account);
  -- Paid to a supplier on the list, or to someone named in words; never both, never neither.
  IF (p_supplier IS NULL) = (nullif(btrim(p_payee), '') IS NULL) THEN
    RAISE EXCEPTION 'an expense is paid to a supplier on the list or to someone named' USING ERRCODE = 'SE337';
  END IF;
  IF p_supplier IS NOT NULL THEN
    SELECT s.* INTO v_supplier FROM public.suppliers s WHERE s.tenant_id = v_tenant AND s.id = p_supplier AND s.archived_at IS NULL;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'choose one of the company''s suppliers' USING ERRCODE = 'SE337';
    END IF;
    v_on_list := v_supplier.atl_status = 'active';
    v_name := v_supplier.name;
  ELSE
    IF char_length(btrim(p_payee)) NOT BETWEEN 2 AND 120 THEN
      RAISE EXCEPTION 'name who was paid' USING ERRCODE = 'SE337';
    END IF;
    v_name := btrim(p_payee);
  END IF;
  IF (p_income_tax_code IS NOT NULL OR p_provincial_tax_code IS NOT NULL) THEN
    IF p_supplier IS NULL THEN
      RAISE EXCEPTION 'tax is withheld from a supplier on the list' USING ERRCODE = 'SE338';
    END IF;
    IF NOT coalesce((SELECT p.withholding_on FROM public.purchase_settings p WHERE p.tenant_id = v_tenant), false) THEN
      RAISE EXCEPTION 'this company does not withhold tax from its suppliers' USING ERRCODE = 'SE338';
    END IF;
  END IF;

  -- The lines: an expense or asset account of the chart that takes postings and is no one's
  -- control (Bank charges, which is locked, may be spent on too); a description; an amount.
  IF p_lines IS NULL OR jsonb_typeof(p_lines) <> 'array' OR jsonb_array_length(p_lines) NOT BETWEEN 1 AND 50 THEN
    RAISE EXCEPTION 'an expense has from 1 to 50 lines' USING ERRCODE = 'SE339';
  END IF;
  FOR v_line IN SELECT e.value FROM jsonb_array_elements(p_lines) AS e(value)
  LOOP
    v_count := v_count + 1;
    SELECT a.* INTO v_target FROM public.accounts a WHERE a.tenant_id = v_tenant AND a.id = (v_line->>'account')::uuid;
    IF NOT FOUND OR v_target.is_group OR v_target.archived_at IS NOT NULL OR v_target.type NOT IN ('expense', 'asset')
       OR (v_target.control_type IS NOT NULL AND v_target.control_type <> 'bank_charges') THEN
      RAISE EXCEPTION 'line %: choose an expense or asset account that takes postings', v_count USING ERRCODE = 'SE339';
    END IF;
    IF char_length(btrim(coalesce(v_line->>'description', ''))) NOT BETWEEN 2 AND 200 THEN
      RAISE EXCEPTION 'line %: say what it was for', v_count USING ERRCODE = 'SE339';
    END IF;
    IF (v_line->>'amount')::numeric IS NULL OR (v_line->>'amount')::numeric <= 0 OR (v_line->>'amount')::numeric >= 1e14
       OR round((v_line->>'amount')::numeric, 2) <> (v_line->>'amount')::numeric THEN
      RAISE EXCEPTION 'line %: an amount in rupees and paisa, above nothing', v_count USING ERRCODE = 'SE339';
    END IF;
    v_amount := v_amount + (v_line->>'amount')::numeric;
  END LOOP;

  -- The province's tax on the services, at its rate on the day, withheld whole.
  IF p_provincial_tax_code IS NOT NULL THEN
    v_provincial_rule := app.withholding_rule_on(v_tenant, 'provincial_sales_tax', p_provincial_tax_code, p_date);
    v_provincial := round(v_amount * v_provincial_rule.rate / 100, 2);
    v_entries := v_entries || jsonb_build_object('kind', 'provincial_sales_tax', 'control', 'wht_provincial_tax', 'rule', v_provincial_rule.id,
      'code', v_provincial_rule.code, 'law', v_provincial_rule.legal_reference, 'base', v_amount, 'rate', v_provincial_rule.rate, 'amount', v_provincial);
  END IF;
  v_total := v_amount + v_provincial;
  IF v_provincial > 0 THEN
    WITH l AS (
      SELECT e.ord, v_provincial * (e.value->>'amount')::numeric * 100 / v_amount AS exact
      FROM jsonb_array_elements(p_lines) WITH ORDINALITY AS e(value, ord)
    ), f AS (
      SELECT l.ord, floor(l.exact) AS cents, l.exact - floor(l.exact) AS cut FROM l
    ), r AS (
      SELECT f.ord, f.cents, row_number() OVER (ORDER BY f.cut DESC, f.ord) AS rank,
             round(v_provincial * 100) - sum(f.cents) OVER () AS spare
      FROM f
    )
    SELECT jsonb_object_agg(r.ord::text, (r.cents + CASE WHEN r.rank <= r.spare THEN 1 ELSE 0 END) / 100.0) INTO v_shares FROM r;
  END IF;
  -- Income tax at the supplier's rate: whether it is on the Active Taxpayers List as recorded today.
  IF p_income_tax_code IS NOT NULL THEN
    v_rule := app.withholding_rule_on(v_tenant, 'income_tax', p_income_tax_code, p_date);
    v_rate := CASE WHEN v_on_list THEN v_rule.rate ELSE coalesce(v_rule.rate_non_atl, v_rule.rate) END;
    v_base := CASE v_rule.base::text WHEN 'gross_amount' THEN v_total WHEN 'taxable_value' THEN v_amount ELSE NULL END;
    IF v_base IS NULL OR v_base <= 0 OR v_rate <= 0 THEN
      RAISE EXCEPTION 'that income tax line is not one an expense is withheld under' USING ERRCODE = 'SE339';
    END IF;
    v_entries := v_entries || jsonb_build_object('kind', 'income_tax', 'control', 'wht_income_tax', 'rule', v_rule.id, 'code', v_rule.code,
      'law', v_rule.legal_reference, 'base', v_base, 'rate', v_rate, 'amount', round(v_base * v_rate / 100, 2));
  END IF;
  SELECT coalesce(sum((e.value->>'amount')::numeric), 0) INTO v_withheld FROM jsonb_array_elements(v_entries) AS e(value);
  IF v_withheld > v_total OR EXISTS (SELECT 1 FROM jsonb_array_elements(v_entries) AS e(value) WHERE (e.value->>'amount')::numeric <= 0) THEN
    RAISE EXCEPTION 'what would be withheld is not an amount between nothing and the expense' USING ERRCODE = 'SE339';
  END IF;

  -- Sent again with the same key, after every check above: the first is the one recorded, if it is the same expense.
  PERFORM pg_advisory_xact_lock(hashtextextended('expense:' || v_id::text, 0));
  SELECT e.* INTO v_sent FROM public.expenses e WHERE e.tenant_id = v_tenant AND e.id = v_id;
  IF FOUND THEN
    IF v_sent.expense_date IS DISTINCT FROM p_date OR v_sent.account_id IS DISTINCT FROM p_account OR v_sent.supplier_id IS DISTINCT FROM p_supplier
       OR v_sent.payee IS DISTINCT FROM (CASE WHEN p_supplier IS NULL THEN btrim(p_payee) END) OR v_sent.amount IS DISTINCT FROM v_amount OR v_sent.total IS DISTINCT FROM v_total THEN
      RAISE EXCEPTION 'already recorded as % with other figures', v_sent.number USING ERRCODE = 'SE342';
    END IF;
    RETURN v_sent.number;
  END IF;
  v_number := app.next_document_number('EX', p_date);
  SET CONSTRAINTS public.journals_balanced, public.journal_lines_balanced, public.journals_with_document DEFERRED;
  INSERT INTO public.journals (tenant_id, journal_date, source_type, source_id, document_number, memo, branch_id, created_by)
    VALUES (v_tenant, p_date, 'expense', v_id, v_number, left('Paid to ' || v_name, 500), p_branch, v_user)
    RETURNING id INTO v_journal;
  INSERT INTO public.expenses (id, tenant_id, number, expense_date, account_id, supplier_id, payee, branch_id, reference, memo, amount, provincial_tax, total, withheld, paid, status, journal_id, created_by)
    VALUES (v_id, v_tenant, v_number, p_date, v_paid_from.id, p_supplier, CASE WHEN p_supplier IS NULL THEN btrim(p_payee) END, p_branch,
            nullif(btrim(p_reference), ''), nullif(btrim(p_memo), ''), v_amount, v_provincial, v_total, v_withheld, v_total - v_withheld, 'posted', v_journal, v_user);
  -- Each line with its share of the province's tax, worked out above.
  FOR v_line, v_ord IN SELECT e.value, e.ord FROM jsonb_array_elements(p_lines) WITH ORDINALITY AS e(value, ord)
  LOOP
    v_seen := v_seen + 1;
    v_share := coalesce((v_shares->>v_ord::text)::numeric, 0);
    v_shared := v_shared + v_share;
    INSERT INTO public.expense_lines (tenant_id, expense_id, line_no, account_id, description, amount, provincial_share)
      VALUES (v_tenant, v_id, v_seen, (v_line->>'account')::uuid, btrim(v_line->>'description'), (v_line->>'amount')::numeric, v_share);
    v_no := v_no + 1;
    INSERT INTO public.journal_lines (tenant_id, journal_id, line_no, account_id, debit, credit, description)
      VALUES (v_tenant, v_journal, v_no, (v_line->>'account')::uuid, (v_line->>'amount')::numeric + v_share, 0, left(btrim(v_line->>'description'), 300));
  END LOOP;
  FOR v_entry IN SELECT e.value FROM jsonb_array_elements(v_entries) AS e(value)
  LOOP
    v_no := v_no + 1;
    INSERT INTO public.journal_lines (tenant_id, journal_id, line_no, account_id, debit, credit, description)
      VALUES (v_tenant, v_journal, v_no, app.control_account(v_tenant, v_entry->>'control'), 0, (v_entry->>'amount')::numeric,
              'Withheld from ' || v_name || ' at ' || trim_scale((v_entry->>'rate')::numeric)::text || '%');
    INSERT INTO public.expense_withholdings (tenant_id, expense_id, supplier_id, entry_date, kind, rule_id, code, legal_reference, on_active_list, base_amount, rate, amount, journal_id, created_by)
      VALUES (v_tenant, v_id, p_supplier, p_date, v_entry->>'kind', (v_entry->>'rule')::uuid, v_entry->>'code', v_entry->>'law', v_on_list,
              (v_entry->>'base')::numeric, (v_entry->>'rate')::numeric, (v_entry->>'amount')::numeric, v_journal, v_user);
  END LOOP;
  IF v_total - v_withheld > 0 THEN
    v_no := v_no + 1;
    INSERT INTO public.journal_lines (tenant_id, journal_id, line_no, account_id, debit, credit, description)
      VALUES (v_tenant, v_journal, v_no, v_paid_from.id, 0, v_total - v_withheld, 'Paid to ' || v_name);
  END IF;
  INSERT INTO public.audit_log (tenant_id, actor_user_id, actor_role, action, entity, entity_id, after)
    VALUES (v_tenant, v_user, app.tenant_role(), 'journal.post', 'journal', v_journal,
      jsonb_build_object('date', p_date, 'source', 'expense', 'sourceId', v_id, 'number', v_number, 'lines', v_no, 'total', v_total::text)),
           (v_tenant, v_user, app.tenant_role(), 'expense.record', 'expense', v_id,
      jsonb_build_object('number', v_number, 'date', p_date, 'paidTo', v_name, 'from', v_paid_from.name, 'total', v_total::text, 'withheld', v_withheld::text, 'paid', (v_total - v_withheld)::text));
  RETURN v_number;
END $$;
ALTER TABLE public.expenses DROP CONSTRAINT expenses_paid_to_one_at_most;
ALTER TABLE public.expenses ADD CONSTRAINT expenses_paid_to_someone CHECK ((supplier_id is null) <> (payee is null)) NOT VALID;
DROP POLICY files_bucket_select_receipt ON storage.objects;
DROP POLICY files_bucket_insert_receipt ON storage.objects;
DROP FUNCTION app.storage_receipt_reader(text);
DROP FUNCTION app.storage_receipt_writer(text);
DROP POLICY files_update_receipt ON public.files;
DROP POLICY files_select_receipt ON public.files;
DROP POLICY files_insert_receipt ON public.files;
DROP FUNCTION app.receipt_file_visible(uuid, uuid);
DROP FUNCTION app.audit_reserved_expense_receipt(text);
DROP FUNCTION app.attach_expense_receipt(uuid, uuid);
DROP TABLE public.expense_receipts;
DELETE FROM drizzle.__drizzle_migrations WHERE created_at = 1795673420652;
COMMIT;

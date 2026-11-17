-- Reverses drizzle/0033_supplier_returns.sql. Never run automatically. Run it by hand, as postgres, only
-- after showing it to the founder and getting a yes. It refuses to run once any return has
-- been posted: its journal and stock moves cannot be removed, and without this migration
-- nothing would say where they came from. It DELETES every draft return. It puts
-- app.post_supplier_bill back as drizzle/0030_supplier_bills.sql wrote it and app.bill_owed as
-- drizzle/0032_supplier_payments.sql wrote it.

BEGIN;

-- Nobody sends goods back, bills or pays a supplier while this runs.
LOCK TABLE public.supplier_returns, public.supplier_bills, public.supplier_payments IN ACCESS EXCLUSIVE MODE;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.supplier_returns r WHERE r.status <> 'draft') THEN
    RAISE EXCEPTION 'a supplier return has been posted; this migration can no longer be reversed';
  END IF;
END $$;

DROP FUNCTION app.apply_supplier_return_credit(uuid, date, jsonb);
DROP FUNCTION app.post_supplier_return(uuid);
DROP FUNCTION app.hold_supplier_return(uuid);

CREATE OR REPLACE FUNCTION app.post_supplier_bill(p_bill uuid) RETURNS text
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_tenant uuid := app.tenant_id();
  v_user uuid := app.current_user_id();
  v_role public.member_role := app.tenant_role();
  v_scope uuid[] := app.tenant_branch_ids();
  v_doc public.supplier_bills%ROWTYPE;
  v_supplier public.suppliers%ROWTYPE;
  v_registered boolean;
  v_withholds boolean;
  v_on_list boolean;
  v_line record;
  v_rule public.withholding_rules%ROWTYPE;
  v_rate numeric;
  v_billed numeric;
  v_cleared numeric;
  v_value numeric;
  v_lines integer := 0;
  v_amount numeric := 0;
  v_tax numeric := 0;
  v_grni numeric := 0;
  v_difference numeric := 0;
  v_services numeric := 0;
  v_expense_lines integer := 0;
  v_provincial numeric := 0;
  v_provincial_rule public.withholding_rules%ROWTYPE;
  v_total numeric;
  v_base numeric;
  v_withheld numeric := 0;
  v_entries jsonb := '[]'::jsonb;
  v_entry jsonb;
  v_share numeric;
  v_shared numeric := 0;
  v_seen integer := 0;
  v_number text;
  v_journal uuid;
  v_no integer := 0;
BEGIN
  IF v_tenant IS NULL OR v_user IS NULL OR v_role IS NULL OR v_role NOT IN ('owner', 'accountant') THEN
    RAISE EXCEPTION 'this role cannot post supplier bills' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'purchase documents are written in read committed transactions' USING ERRCODE = 'SE219';
  END IF;
  SELECT d.* INTO v_doc FROM public.supplier_bills d WHERE d.tenant_id = v_tenant AND d.id = p_bill FOR UPDATE;
  IF NOT FOUND OR (v_scope IS NOT NULL AND NOT (v_doc.branch_id = ANY (v_scope))) THEN
    RAISE EXCEPTION 'no such supplier bill in this company' USING ERRCODE = 'SE223';
  END IF;
  IF v_doc.status <> 'draft' THEN
    RAISE EXCEPTION 'only a draft bill is posted' USING ERRCODE = 'SE224';
  END IF;
  -- Nothing is recorded before it happens. The day is Pakistan's, as everywhere in the product
  -- until a company can choose its own time zone; not the session's, which a caller can set.
  IF v_doc.bill_date > (now() AT TIME ZONE 'Asia/Karachi')::date THEN
    RAISE EXCEPTION 'that date has not come yet' USING ERRCODE = 'SE233';
  END IF;
  PERFORM app.require_open_period(v_tenant, v_doc.bill_date);
  -- The supplier is held until the transaction ends: its bills are posted one at a time, so
  -- two cannot carry the same invoice number or bill the same goods twice.
  SELECT s.* INTO v_supplier FROM public.suppliers s WHERE s.tenant_id = v_tenant AND s.id = v_doc.supplier_id FOR NO KEY UPDATE;
  IF EXISTS (
    SELECT 1 FROM public.supplier_bills b
    WHERE b.tenant_id = v_tenant AND b.supplier_id = v_doc.supplier_id AND b.status = 'posted'
      AND lower(btrim(b.supplier_invoice_no)) = lower(btrim(v_doc.supplier_invoice_no))
  ) THEN
    RAISE EXCEPTION 'the supplier''s invoice % is already on a posted bill', v_doc.supplier_invoice_no USING ERRCODE = 'SE232';
  END IF;
  v_registered := coalesce((SELECT c.sales_tax_registered FROM public.company_setup c WHERE c.tenant_id = v_tenant), false);
  v_withholds := coalesce((SELECT p.withholding_on FROM public.purchase_settings p WHERE p.tenant_id = v_tenant), false);
  v_on_list := v_supplier.atl_status = 'active';
  IF NOT v_withholds AND (v_doc.income_tax_code IS NOT NULL OR v_doc.sales_tax_code IS NOT NULL OR v_doc.provincial_tax_code IS NOT NULL) THEN
    RAISE EXCEPTION 'this company does not withhold tax from its suppliers' USING ERRCODE = 'SE231';
  END IF;

  -- The lines, in their order. Goods clear what they came in at; every line's tax is the table's.
  FOR v_line IN
    SELECT l.*, g.quantity AS received, g.id AS found_line, r.status AS receipt_status, r.supplier_id AS receipt_supplier, w.branch_id AS receipt_branch,
           i.code AS item_code, c.kind::text AS category_kind,
           (SELECT m.value FROM public.stock_moves m
              WHERE m.tenant_id = l.tenant_id AND m.source_type = 'goods_receipt' AND m.source_id = r.id AND m.source_line_id = g.id) AS received_at
    FROM public.supplier_bill_lines l
    LEFT JOIN public.goods_receipt_lines g ON g.tenant_id = l.tenant_id AND g.id = l.receipt_line_id
    LEFT JOIN public.goods_receipts r ON r.tenant_id = g.tenant_id AND r.id = g.receipt_id
    LEFT JOIN public.warehouses w ON w.tenant_id = r.tenant_id AND w.id = r.warehouse_id
    LEFT JOIN public.items i ON i.tenant_id = l.tenant_id AND i.id = l.item_id
    LEFT JOIN public.tax_categories c ON c.tenant_id = l.tenant_id AND c.id = l.tax_category_id
    WHERE l.tenant_id = v_tenant AND l.bill_id = v_doc.id
    ORDER BY l.line_no
  LOOP
    v_lines := v_lines + 1;
    v_amount := v_amount + v_line.amount;
    IF v_line.kind = 'goods' THEN
      IF v_line.found_line IS NULL OR v_line.receipt_status <> 'posted' OR v_line.receipt_supplier <> v_doc.supplier_id
         OR v_line.receipt_branch <> v_doc.branch_id OR v_line.received_at IS NULL THEN
        RAISE EXCEPTION 'a line of goods is a line of a posted goods received note, from the bill''s supplier, into the bill''s branch' USING ERRCODE = 'SE226';
      END IF;
      SELECT coalesce(sum(o.quantity), 0), coalesce(sum(o.received_value), 0) INTO v_billed, v_cleared
        FROM public.supplier_bill_lines o
        JOIN public.supplier_bills b ON b.tenant_id = o.tenant_id AND b.id = o.bill_id
        WHERE o.tenant_id = v_tenant AND o.receipt_line_id = v_line.receipt_line_id AND b.status = 'posted';
      IF v_billed + v_line.quantity > v_line.received THEN
        RAISE EXCEPTION 'more of % billed than was received and is not yet billed: % received, % already billed, % on this bill',
          v_line.item_code, v_line.received, v_billed, v_line.quantity USING ERRCODE = 'SE228';
      END IF;
      -- What all that is billed of the line so far should have cleared, less what earlier bills did.
      v_value := round(v_line.received_at * (v_billed + v_line.quantity) / v_line.received, 2) - v_cleared;
      UPDATE public.supplier_bill_lines o SET received_value = v_value WHERE o.tenant_id = v_tenant AND o.id = v_line.id;
      v_grni := v_grni + v_value;
      v_difference := v_difference + v_line.amount - v_value;
    ELSE
      v_services := v_services + v_line.amount;
      v_expense_lines := v_expense_lines + 1;
    END IF;
    IF v_line.tax_category_id IS NULL THEN
      IF v_line.sales_tax <> 0 OR v_line.tax_rate IS NOT NULL THEN
        RAISE EXCEPTION 'line % carries sales tax and names no tax category', v_line.line_no USING ERRCODE = 'SE227';
      END IF;
    ELSE
      IF NOT v_registered OR v_supplier.registration_type <> 'registered' OR v_supplier.strn IS NULL THEN
        RAISE EXCEPTION 'sales tax on a bill needs the company registered for sales tax and a supplier registered with an STRN' USING ERRCODE = 'SE229';
      END IF;
      -- Goods taxed on their retail price (the Third Schedule) are not billed here yet: the
      -- tax on them is not the bill's value at the rate.
      IF v_line.category_kind IS NULL OR v_line.category_kind = 'third_schedule' THEN
        RAISE EXCEPTION 'line %: goods taxed on their retail price cannot carry input tax on a bill yet', v_line.line_no USING ERRCODE = 'SE230';
      END IF;
      SELECT t.rate INTO v_rate FROM public.tax_rates t
        WHERE t.tenant_id = v_tenant AND t.category_id = v_line.tax_category_id AND t.effective_from <= v_doc.bill_date
        ORDER BY t.effective_from DESC LIMIT 1;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'line %: no sales tax rate is in force for its category on %', v_line.line_no, v_doc.bill_date USING ERRCODE = 'SE230';
      END IF;
      IF v_line.tax_rate IS DISTINCT FROM v_rate OR v_line.sales_tax <> round(v_line.amount * v_rate / 100, 2) THEN
        RAISE EXCEPTION 'line %: the sales tax is not what the rate in force gives', v_line.line_no USING ERRCODE = 'SE227';
      END IF;
      v_tax := v_tax + v_line.sales_tax;
    END IF;
  END LOOP;
  IF v_lines = 0 THEN
    RAISE EXCEPTION 'a bill is posted with at least one line' USING ERRCODE = 'SE227';
  END IF;

  -- The province's tax on services: charged by the supplier on the services billed, at the
  -- province's rate, and withheld whole.
  IF v_doc.provincial_tax_code IS NOT NULL THEN
    IF v_services <= 0 THEN
      RAISE EXCEPTION 'the province''s tax is on services, and the bill has no service or expense line' USING ERRCODE = 'SE227';
    END IF;
    v_provincial_rule := app.withholding_rule_on(v_tenant, 'provincial_sales_tax', v_doc.provincial_tax_code, v_doc.bill_date);
    v_provincial := round(v_services * v_provincial_rule.rate / 100, 2);
  END IF;
  v_total := v_amount + v_tax + v_provincial;
  IF v_doc.amount <> v_amount OR v_doc.sales_tax <> v_tax OR v_doc.provincial_tax <> v_provincial OR v_total <= 0 THEN
    RAISE EXCEPTION 'the bill''s figures are not its lines'' and the tables'': amount %, sales tax %, provincial tax %', v_amount, v_tax, v_provincial USING ERRCODE = 'SE227';
  END IF;

  -- What is withheld, each from its line of the tables, at the rate for whether the supplier
  -- is on the Active Taxpayers List as recorded today.
  IF v_doc.income_tax_code IS NOT NULL THEN
    v_rule := app.withholding_rule_on(v_tenant, 'income_tax', v_doc.income_tax_code, v_doc.bill_date);
    v_rate := CASE WHEN v_on_list THEN v_rule.rate ELSE coalesce(v_rule.rate_non_atl, v_rule.rate) END;
    v_base := CASE v_rule.base::text WHEN 'gross_amount' THEN v_total WHEN 'taxable_value' THEN v_amount ELSE v_tax END;
    IF v_base <= 0 OR v_rate <= 0 THEN
      RAISE EXCEPTION 'there is nothing on the bill for the income tax line to be withheld from' USING ERRCODE = 'SE227';
    END IF;
    v_entries := v_entries || jsonb_build_object('kind', 'income_tax', 'control', 'wht_income_tax', 'rule', v_rule.id, 'code', v_rule.code,
      'law', v_rule.legal_reference, 'base', v_base, 'rate', v_rate, 'amount', round(v_base * v_rate / 100, 2));
  END IF;
  IF v_doc.sales_tax_code IS NOT NULL THEN
    v_rule := app.withholding_rule_on(v_tenant, 'sales_tax', v_doc.sales_tax_code, v_doc.bill_date);
    v_rate := CASE WHEN v_on_list THEN v_rule.rate ELSE coalesce(v_rule.rate_non_atl, v_rule.rate) END;
    v_base := CASE v_rule.base::text WHEN 'gross_amount' THEN v_total WHEN 'taxable_value' THEN v_amount ELSE v_tax END;
    IF NOT v_registered OR v_base <= 0 OR v_rate <= 0 THEN
      RAISE EXCEPTION 'there is nothing on the bill for the sales tax line to be withheld from' USING ERRCODE = 'SE227';
    END IF;
    v_entries := v_entries || jsonb_build_object('kind', 'sales_tax', 'control', 'wht_sales_tax', 'rule', v_rule.id, 'code', v_rule.code,
      'law', v_rule.legal_reference, 'base', v_base, 'rate', v_rate, 'amount', round(v_base * v_rate / 100, 2));
  END IF;
  IF v_doc.provincial_tax_code IS NOT NULL THEN
    v_entries := v_entries || jsonb_build_object('kind', 'provincial_sales_tax', 'control', 'wht_provincial_tax', 'rule', v_provincial_rule.id,
      'code', v_provincial_rule.code, 'law', v_provincial_rule.legal_reference, 'base', v_services, 'rate', v_provincial_rule.rate, 'amount', v_provincial);
  END IF;
  SELECT coalesce(sum((e.value->>'amount')::numeric), 0) INTO v_withheld FROM jsonb_array_elements(v_entries) AS e(value);
  IF v_withheld > v_total OR EXISTS (SELECT 1 FROM jsonb_array_elements(v_entries) AS e(value) WHERE (e.value->>'amount')::numeric <= 0) THEN
    RAISE EXCEPTION 'what would be withheld is not an amount between nothing and the bill' USING ERRCODE = 'SE227';
  END IF;

  v_number := app.next_document_number('PB', v_doc.bill_date);
  -- The balance, and the document behind the journal, are asked when the transaction ends, whatever the caller set before this.
  SET CONSTRAINTS public.journals_balanced, public.journal_lines_balanced, public.journals_with_document DEFERRED;
  INSERT INTO public.journals (tenant_id, journal_date, source_type, source_id, document_number, memo, branch_id, created_by)
    VALUES (v_tenant, v_doc.bill_date, 'supplier_bill', v_doc.id, v_number, left('Bill ' || btrim(v_doc.supplier_invoice_no) || ' from ' || v_supplier.name, 500), v_doc.branch_id, v_user)
    RETURNING id INTO v_journal;
  IF v_grni > 0 THEN
    v_no := v_no + 1;
    INSERT INTO public.journal_lines (tenant_id, journal_id, line_no, account_id, debit, credit, description)
      VALUES (v_tenant, v_journal, v_no, app.control_account(v_tenant, 'grni'), v_grni, 0, 'Goods received, now billed');
  END IF;
  IF v_difference <> 0 THEN
    v_no := v_no + 1;
    INSERT INTO public.journal_lines (tenant_id, journal_id, line_no, account_id, debit, credit, description)
      VALUES (v_tenant, v_journal, v_no, app.control_account(v_tenant, 'purchase_price_difference'), greatest(v_difference, 0), greatest(-v_difference, 0),
              'Billed at a different price from the order');
  END IF;
  -- Each expense line, with its share of the province's tax: in proportion, the last line taking what is left.
  FOR v_line IN
    SELECT l.account_id, l.description, l.amount FROM public.supplier_bill_lines l
    WHERE l.tenant_id = v_tenant AND l.bill_id = v_doc.id AND l.kind = 'expense' ORDER BY l.line_no
  LOOP
    v_seen := v_seen + 1;
    v_share := CASE WHEN v_seen = v_expense_lines THEN v_provincial - v_shared ELSE round(v_provincial * v_line.amount / v_services, 2) END;
    v_shared := v_shared + v_share;
    v_no := v_no + 1;
    INSERT INTO public.journal_lines (tenant_id, journal_id, line_no, account_id, debit, credit, description)
      VALUES (v_tenant, v_journal, v_no, v_line.account_id, v_line.amount + v_share, 0, v_line.description);
  END LOOP;
  IF v_tax > 0 THEN
    v_no := v_no + 1;
    INSERT INTO public.journal_lines (tenant_id, journal_id, line_no, account_id, debit, credit, description)
      VALUES (v_tenant, v_journal, v_no, app.control_account(v_tenant, 'input_tax'), v_tax, 0, 'Input tax on ' || v_number);
  END IF;
  FOR v_entry IN SELECT e.value FROM jsonb_array_elements(v_entries) AS e(value)
  LOOP
    v_no := v_no + 1;
    INSERT INTO public.journal_lines (tenant_id, journal_id, line_no, account_id, debit, credit, description)
      VALUES (v_tenant, v_journal, v_no, app.control_account(v_tenant, v_entry->>'control'), 0, (v_entry->>'amount')::numeric,
              'Withheld from ' || v_supplier.name || ' at ' || trim_scale((v_entry->>'rate')::numeric)::text || '%');
    INSERT INTO public.withholding_entries (tenant_id, bill_id, supplier_id, entry_date, kind, rule_id, code, legal_reference, on_active_list, base_amount, rate, amount, journal_id, created_by)
      VALUES (v_tenant, v_doc.id, v_doc.supplier_id, v_doc.bill_date, v_entry->>'kind', (v_entry->>'rule')::uuid, v_entry->>'code', v_entry->>'law', v_on_list,
              (v_entry->>'base')::numeric, (v_entry->>'rate')::numeric, (v_entry->>'amount')::numeric, v_journal, v_user);
  END LOOP;
  IF v_total - v_withheld > 0 THEN
    v_no := v_no + 1;
    INSERT INTO public.journal_lines (tenant_id, journal_id, line_no, account_id, debit, credit, description, supplier_id)
      VALUES (v_tenant, v_journal, v_no, app.control_account(v_tenant, 'ap'), 0, v_total - v_withheld, 'Bill ' || btrim(v_doc.supplier_invoice_no), v_doc.supplier_id);
  END IF;
  INSERT INTO public.audit_log (tenant_id, actor_user_id, actor_role, action, entity, entity_id, after)
    VALUES (v_tenant, v_user, v_role, 'journal.post', 'journal', v_journal,
      jsonb_build_object('date', v_doc.bill_date, 'source', 'supplier_bill', 'sourceId', v_doc.id, 'number', v_number, 'lines', v_no, 'total', v_total::text));

  UPDATE public.supplier_bills d SET status = 'posted', number = v_number, withheld = v_withheld, payable = v_total - v_withheld,
      journal_id = v_journal, posted_at = now(), posted_by = v_user, updated_by = v_user
    WHERE d.tenant_id = v_tenant AND d.id = v_doc.id;
  INSERT INTO public.audit_log (tenant_id, actor_user_id, actor_role, action, entity, entity_id, after)
    VALUES (v_tenant, v_user, v_role, 'supplier_bill.post', 'supplier_bill', v_doc.id,
      jsonb_build_object('number', v_number, 'supplier', v_supplier.name, 'invoice', btrim(v_doc.supplier_invoice_no), 'date', v_doc.bill_date,
        'total', v_total::text, 'withheld', v_withheld::text, 'payable', (v_total - v_withheld)::text, 'journalId', v_journal));
  RETURN v_number;
END $$;

CREATE OR REPLACE FUNCTION app.bill_owed(p_tenant uuid, p_bill uuid) RETURNS numeric
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
  AS $$
    SELECT b.payable - coalesce((
      SELECT sum(a.amount) FROM public.supplier_payment_allocations a
      JOIN public.supplier_payments p ON p.tenant_id = a.tenant_id AND p.id = a.payment_id
      WHERE a.tenant_id = b.tenant_id AND a.bill_id = b.id AND p.status = 'posted'), 0)
    FROM public.supplier_bills b WHERE b.tenant_id = p_tenant AND b.id = p_bill AND b.status = 'posted'
  $$;

DROP FUNCTION app.audit_reserved_supplier_return(text);
DROP FUNCTION app.journal_backed_supplier_return(public.journals);
DROP TABLE public.supplier_return_allocations, public.supplier_return_lines, public.supplier_returns;
DROP FUNCTION app.refuse_supplier_return_allocation_change();
DROP FUNCTION app.check_supplier_return_line();
DROP FUNCTION app.check_supplier_return();

-- The row drizzle-kit wrote for 0033_supplier_returns (its "when" in drizzle/meta/_journal.json).
DELETE FROM drizzle.__drizzle_migrations WHERE created_at = 1794935477297;

COMMIT;

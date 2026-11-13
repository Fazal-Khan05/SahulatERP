-- Preparation for building in parallel: the lists every step adds to are no longer written
-- out whole in one function.
--
-- Hand-written; nothing here is managed by Drizzle. No table changes.
-- Reverse with drizzle/down/0019_journal_documents.sql.
--
-- Four functions each held a list that later steps must add to: the kinds of document a journal
-- may belong to, the starting chart of accounts, the kinds of document that take a number, and
-- the audit rows only the database writes. A step added to such a list by writing the whole
-- function out again. Two people building at once would each write it out from the same
-- starting point, and whichever migration ran second would silently drop what the first had
-- added. From here on each of the four only asks: a step adds to the list with a small
-- function of its own, and never writes these four out again.
--
--   app.journal_backed_<source type>(journal)              a journal the document posted
--   app.reversal_backed_<source type>(reversal, original)  the reversal of such a journal
--   app.chart_extra_<name>()                               accounts added to the starting chart
--   app.document_type_<two letters>()                      a kind of document that takes a number
--   app.audit_reserved_<thing>(action)                     audit rows only the database writes
--
-- Only a migration can create a function in this schema: the app's role cannot. A new function
-- can be called by anyone until that is taken away, so each of these is followed by
--   REVOKE ALL ON FUNCTION app.<name>(...) FROM PUBLIC;
-- as the ones below are (npm run check refuses a migration that leaves it out).

-- ── journals: each kind of document answers for its own ─────────────────────────────────────────
-- drizzle/0018_sales_invoices.sql made the database refuse, when a transaction ends, a journal
-- with no standing document behind it. Each kind of document now says for itself whether a
-- journal is its own. A step that adds a kind adds the first function above (and the second
-- only if its journals can be reversed). A source type with no function is refused, as an
-- unknown kind was before.

-- ── manual journals ─────────────────────────────────────────────────────────────────────────────
CREATE FUNCTION app.journal_backed_manual_journal(p_journal public.journals) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
  AS $$
    SELECT EXISTS (
      SELECT 1 FROM public.manual_journals m
      WHERE m.tenant_id = p_journal.tenant_id AND m.id = p_journal.source_id AND m.journal_id = p_journal.id AND m.status IN ('posted', 'reversed'))
  $$;
--> statement-breakpoint
CREATE FUNCTION app.reversal_backed_manual_journal(p_reversal public.journals, p_original public.journals) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
  AS $$
    SELECT EXISTS (
      SELECT 1 FROM public.manual_journals m
      WHERE m.tenant_id = p_reversal.tenant_id AND m.journal_id = p_original.id AND m.reversal_journal_id = p_reversal.id AND m.status = 'reversed')
  $$;
--> statement-breakpoint

-- ── opening balances ────────────────────────────────────────────────────────────────────────────
CREATE FUNCTION app.journal_backed_opening_balance(p_journal public.journals) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
  AS $$
    SELECT EXISTS (
      SELECT 1 FROM public.opening_entries e
      WHERE e.tenant_id = p_journal.tenant_id AND e.id = p_journal.source_id AND e.journal_id = p_journal.id AND e.status IN ('posted', 'reversed'))
  $$;
--> statement-breakpoint
CREATE FUNCTION app.reversal_backed_opening_balance(p_reversal public.journals, p_original public.journals) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
  AS $$
    SELECT EXISTS (
      SELECT 1 FROM public.opening_entries e
      WHERE e.tenant_id = p_reversal.tenant_id AND e.journal_id = p_original.id AND e.reversal_journal_id = p_reversal.id AND e.status = 'reversed')
  $$;
--> statement-breakpoint

-- ── delivery notes ──────────────────────────────────────────────────────────────────────────────
CREATE FUNCTION app.journal_backed_delivery_note(p_journal public.journals) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
  AS $$
    SELECT EXISTS (
      SELECT 1 FROM public.sales_documents d
      WHERE d.tenant_id = p_journal.tenant_id AND d.id = p_journal.source_id AND d.kind = 'delivery'
        AND d.status IN ('submitted', 'cancelled') AND d.number = p_journal.document_number)
  $$;
--> statement-breakpoint
-- A delivery note's journal is reversed when the note is cancelled, and only then.
CREATE FUNCTION app.reversal_backed_delivery_note(p_reversal public.journals, p_original public.journals) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
  AS $$
    SELECT EXISTS (
      SELECT 1 FROM public.sales_documents d
      WHERE d.tenant_id = p_original.tenant_id AND d.id = p_original.source_id AND d.kind = 'delivery' AND d.status = 'cancelled')
  $$;
--> statement-breakpoint

-- ── sales invoices ──────────────────────────────────────────────────────────────────────────────
-- A posted invoice is never cancelled, so its journal has no reversal and no function for one.
CREATE FUNCTION app.journal_backed_sales_invoice(p_journal public.journals) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
  AS $$
    SELECT EXISTS (
      SELECT 1 FROM public.sales_documents d
      WHERE d.tenant_id = p_journal.tenant_id AND d.id = p_journal.source_id AND d.kind = 'invoice'
        AND d.status = 'submitted' AND d.number = p_journal.document_number)
  $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION
    app.journal_backed_manual_journal(public.journals), app.reversal_backed_manual_journal(public.journals, public.journals),
    app.journal_backed_opening_balance(public.journals), app.reversal_backed_opening_balance(public.journals, public.journals),
    app.journal_backed_delivery_note(public.journals), app.reversal_backed_delivery_note(public.journals, public.journals),
    app.journal_backed_sales_invoice(public.journals)
  FROM PUBLIC;
--> statement-breakpoint

-- ── the check itself, which now only asks ───────────────────────────────────────────────────────
-- The same rule as before, for every journal written in the transaction, whoever wrote it. The
-- name of the function to ask is built from the journal's source type, which the table itself
-- holds to lower-case letters and underscores, so it cannot name anything else. Only a
-- migration can create a function in this schema.
CREATE OR REPLACE FUNCTION app.check_journal_backed() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
  AS $$
DECLARE
  v_backed boolean := false;
  v_original public.journals%ROWTYPE;
BEGIN
  IF NEW.source_type !~ '^[a-z_]{2,40}$' THEN
    RAISE EXCEPTION 'a journal is kept only with the document it was posted for' USING ERRCODE = 'SE074';
  END IF;
  IF NEW.source_type = 'reversal' THEN
    SELECT o.* INTO v_original FROM public.journals o WHERE o.tenant_id = NEW.tenant_id AND o.id = NEW.reverses_journal_id;
    IF FOUND AND v_original.source_type ~ '^[a-z_]{2,40}$'
       AND to_regprocedure(format('app.%I(public.journals, public.journals)', 'reversal_backed_' || v_original.source_type)) IS NOT NULL THEN
      EXECUTE format('SELECT app.%I($1, $2)', 'reversal_backed_' || v_original.source_type) INTO v_backed USING NEW, v_original;
    END IF;
  ELSIF to_regprocedure(format('app.%I(public.journals)', 'journal_backed_' || NEW.source_type)) IS NOT NULL THEN
    EXECUTE format('SELECT app.%I($1)', 'journal_backed_' || NEW.source_type) INTO v_backed USING NEW;
  END IF;
  IF NOT coalesce(v_backed, false) THEN
    RAISE EXCEPTION 'a journal is kept only with the document it was posted for' USING ERRCODE = 'SE074';
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint

-- ── the starting chart: a later step adds its accounts with a function of its own ───────────────
-- The chart of drizzle/0018_sales_invoices.sql, unchanged, and after it whatever the functions
-- named app.chart_extra_<name>() return, in the order of their names: rows of (code, name,
-- type, parent, is_group, is_control, control_type). A parent must be in the chart already (the
-- standard one, an earlier row of the same function, or a function that comes first by name);
-- an account whose parent is not there is refused. A step that
-- needs a locked account of its own adds one such function, and gives the account to the
-- companies that already have a chart in its own migration; it does not write this function
-- out again, which two steps built at once would each do without the other's account.
CREATE OR REPLACE FUNCTION app.seed_accounts(p_template text) RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
  AS $$
DECLARE
  v_tenant uuid := app.tenant_id();
  v_user uuid := app.current_user_id();
  v_count integer := 0;
  r record;
  f record;
BEGIN
  IF v_tenant IS NULL OR app.tenant_role() IS DISTINCT FROM 'owner' THEN
    RAISE EXCEPTION 'only the owner can create the chart of accounts' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_template IS DISTINCT FROM 'trading' THEN
    RAISE EXCEPTION 'unknown chart of accounts' USING ERRCODE = 'check_violation';
  END IF;
  -- One at a time per company: a second call waits here, then finds the chart in place.
  PERFORM pg_advisory_xact_lock(hashtextextended('accounts:' || v_tenant::text, 0));
  IF EXISTS (SELECT 1 FROM public.accounts a WHERE a.tenant_id = v_tenant) THEN
    RETURN 0;
  END IF;
  FOR r IN
    SELECT * FROM (VALUES
      --  code    name                                 type         parent  heading locked  for
      ('1000', 'Assets',                                     'asset',     NULL,   true,  true,  NULL),
      ('1100', 'Current assets',                             'asset',     '1000', true,  true,  NULL),
      ('1110', 'Cash accounts',                              'asset',     '1100', true,  true,  'cash'),
      ('1111', 'Cash in hand',                               'asset',     '1110', false, false, 'cash'),
      ('1120', 'Bank accounts',                              'asset',     '1100', true,  true,  'bank'),
      ('1130', 'Cheques in hand',                            'asset',     '1100', false, true,  'cheques_in_hand'),
      ('1200', 'Trade receivables',                          'asset',     '1100', false, true,  'ar'),
      ('1210', 'Advances to suppliers',                      'asset',     '1100', false, true,  'supplier_advances'),
      ('1220', 'Deposits and prepayments',                   'asset',     '1100', false, false, NULL),
      ('1230', 'Other receivables',                          'asset',     '1100', false, false, NULL),
      ('1300', 'Stock in trade',                             'asset',     '1100', false, true,  'inventory'),
      ('1310', 'Goods in transit',                           'asset',     '1100', false, true,  'goods_in_transit'),
      ('1400', 'Sales tax receivable (input tax)',           'asset',     '1100', false, true,  'input_tax'),
      ('1410', 'Advance income tax',                         'asset',     '1100', false, true,  'advance_income_tax'),
      ('1500', 'Fixed assets',                               'asset',     '1000', true,  true,  NULL),
      ('1510', 'Furniture and fixtures',                     'asset',     '1500', false, false, NULL),
      ('1520', 'Office equipment and computers',             'asset',     '1500', false, false, NULL),
      ('1530', 'Vehicles',                                   'asset',     '1500', false, false, NULL),
      ('1590', 'Accumulated depreciation',                   'asset',     '1500', false, false, NULL),
      ('2000', 'Liabilities',                                'liability', NULL,   true,  true,  NULL),
      ('2100', 'Current liabilities',                        'liability', '2000', true,  true,  NULL),
      ('2110', 'Trade payables',                             'liability', '2100', false, true,  'ap'),
      ('2120', 'Goods received not invoiced',                'liability', '2100', false, true,  'grni'),
      ('2130', 'Advances from customers',                    'liability', '2100', false, true,  'customer_advances'),
      ('2140', 'Accrued expenses',                           'liability', '2100', false, false, NULL),
      ('2150', 'Other payables',                             'liability', '2100', false, false, NULL),
      ('2200', 'Sales tax payable (output tax)',             'liability', '2100', false, true,  'output_tax'),
      ('2205', 'Further tax payable',                        'liability', '2100', false, true,  'further_tax'),
      ('2210', 'Income tax withheld payable',                'liability', '2100', false, true,  'wht_income_tax'),
      ('2220', 'Sales tax withheld payable',                 'liability', '2100', false, true,  'wht_sales_tax'),
      ('2230', 'Provincial sales tax withheld payable',      'liability', '2100', false, true,  'wht_provincial_tax'),
      ('2300', 'Salaries payable',                           'liability', '2100', false, true,  'payroll_payable'),
      ('2310', 'EOBI and social security payable',           'liability', '2100', false, true,  'payroll_statutory_payable'),
      ('2320', 'Commission payable',                         'liability', '2100', false, true,  'commission_payable'),
      ('2500', 'Long-term liabilities',                      'liability', '2000', true,  true,  NULL),
      ('2510', 'Loans from banks',                           'liability', '2500', false, false, NULL),
      ('2520', 'Loans from directors and partners',          'liability', '2500', false, false, NULL),
      ('3000', 'Equity',                                     'equity',    NULL,   true,  true,  NULL),
      ('3100', 'Owner''s capital',                           'equity',    '3000', false, false, NULL),
      ('3200', 'Drawings',                                   'equity',    '3000', false, false, NULL),
      ('3300', 'Retained earnings',                          'equity',    '3000', false, true,  'retained_earnings'),
      ('3900', 'Opening balance equity',                     'equity',    '3000', false, true,  'opening_equity'),
      ('4000', 'Income',                                     'income',    NULL,   true,  true,  NULL),
      ('4100', 'Sales',                                      'income',    '4000', false, true,  'sales'),
      ('4200', 'Other income',                               'income',    '4000', false, false, NULL),
      ('5000', 'Expenses',                                   'expense',   NULL,   true,  true,  NULL),
      ('5100', 'Cost of goods sold',                         'expense',   '5000', false, true,  'cogs'),
      ('5110', 'Stock adjustments',                          'expense',   '5000', false, true,  'stock_adjustment'),
      ('5200', 'Operating expenses',                         'expense',   '5000', true,  true,  NULL),
      ('5210', 'Salaries and wages',                         'expense',   '5200', false, true,  'salaries_expense'),
      ('5220', 'Sales commission',                           'expense',   '5200', false, true,  'commission_expense'),
      ('5230', 'Rent',                                       'expense',   '5200', false, false, NULL),
      ('5240', 'Electricity, gas and water',                 'expense',   '5200', false, false, NULL),
      ('5250', 'Telephone and internet',                     'expense',   '5200', false, false, NULL),
      ('5260', 'Freight and cartage outward',                'expense',   '5200', false, false, NULL),
      ('5270', 'Repairs and maintenance',                    'expense',   '5200', false, false, NULL),
      ('5280', 'Printing and stationery',                    'expense',   '5200', false, false, NULL),
      ('5290', 'Travelling and conveyance',                  'expense',   '5200', false, false, NULL),
      ('5300', 'Entertainment',                              'expense',   '5200', false, false, NULL),
      ('5310', 'Legal and professional fees',                'expense',   '5200', false, false, NULL),
      ('5320', 'Depreciation',                               'expense',   '5200', false, false, NULL),
      ('5330', 'Miscellaneous expenses',                     'expense',   '5200', false, false, NULL),
      ('5800', 'Financial charges',                          'expense',   '5000', true,  true,  NULL),
      ('5810', 'Bank charges',                               'expense',   '5800', false, true,  'bank_charges'),
      ('5820', 'Markup and interest',                        'expense',   '5800', false, false, NULL),
      ('5830', 'Exchange gain or loss',                      'expense',   '5800', false, true,  'fx_gain_loss')
    ) AS t(code, name, type, parent, is_group, is_control, control_type)
    ORDER BY t.code
  LOOP
    INSERT INTO public.accounts (tenant_id, parent_id, code, name, type, is_group, is_control, control_type, created_by)
      VALUES (
        v_tenant,
        (SELECT a.id FROM public.accounts a WHERE a.tenant_id = v_tenant AND a.code = r.parent),
        r.code, r.name, r.type, r.is_group, r.is_control, r.control_type, v_user
      );
    v_count := v_count + 1;
  END LOOP;
  -- The accounts later steps add to the starting chart, each from a function of that step's own.
  FOR f IN
    SELECT p.proname, p.pronargs = 0 AND p.proretset AS well_formed FROM pg_catalog.pg_proc p
    WHERE p.pronamespace = 'app'::regnamespace AND p.proname ~ '^chart_extra_[a-z0-9_]+$'
    ORDER BY p.proname COLLATE "C"
  LOOP
    IF NOT f.well_formed THEN
      RAISE EXCEPTION 'app.% must take nothing and return a table of accounts', f.proname USING ERRCODE = 'check_violation';
    END IF;
    FOR r IN EXECUTE format('SELECT x.code, x.name, x.type, x.parent, x.is_group, x.is_control, x.control_type FROM app.%I() x ORDER BY x.code', f.proname)
    LOOP
      -- A parent that is not there (misspelt, or added by a function that comes later by name)
      -- would otherwise put the account at the top of the chart without a word.
      IF r.parent IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.accounts a WHERE a.tenant_id = v_tenant AND a.code = r.parent) THEN
        RAISE EXCEPTION 'app.%: account % names a parent, %, that the chart does not have', f.proname, r.code, r.parent USING ERRCODE = 'check_violation';
      END IF;
      INSERT INTO public.accounts (tenant_id, parent_id, code, name, type, is_group, is_control, control_type, created_by)
        VALUES (
          v_tenant,
          (SELECT a.id FROM public.accounts a WHERE a.tenant_id = v_tenant AND a.code = r.parent),
          r.code, r.name, r.type, r.is_group, r.is_control, r.control_type, v_user
        );
      v_count := v_count + 1;
    END LOOP;
  END LOOP;
  INSERT INTO public.audit_log (tenant_id, actor_user_id, actor_role, action, entity, after)
    VALUES (v_tenant, v_user, 'owner', 'accounts.seed', 'accounts', jsonb_build_object('template', p_template, 'accounts', v_count));
  RETURN v_count;
END $$;
--> statement-breakpoint

-- ── document numbers: a later step adds its kind with a function of its own ─────────────────────
-- The kinds below are numbered as before. A step that numbers a new kind of document adds
--   CREATE FUNCTION app.document_type_<two letters>() RETURNS text LANGUAGE sql IMMUTABLE ...
-- returning the kind's name, and the same two letters to its own list in the app. Nothing
-- calls that function: that it exists is the answer.
CREATE OR REPLACE FUNCTION app.next_document_number(p_type text, p_date date) RETURNS text
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
  AS $$
DECLARE
  v_tenant uuid := app.tenant_id();
  v_year_start date;
  v_locked timestamptz;
  v_code text;
  v_number bigint;
BEGIN
  IF v_tenant IS NULL OR app.tenant_role() = 'auditor' THEN
    RAISE EXCEPTION 'not allowed to number a document' USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- The kinds of document the product numbers; the same list as DOCUMENT_TYPES in the app.
  IF p_date IS NULL OR p_type IS NULL OR p_type !~ '^[A-Z]{2}$'
     OR (p_type NOT IN ('QT', 'SO', 'DN', 'SI', 'CN', 'PO', 'GR', 'PB', 'DB', 'RC', 'PV', 'JV', 'ST', 'SA', 'EX')
         -- A kind a later step numbers: that step's own function, named for its two letters.
         AND to_regprocedure(format('app.%I()', 'document_type_' || lower(p_type))) IS NULL) THEN
    RAISE EXCEPTION 'a document number needs a known document type and a date' USING ERRCODE = 'check_violation';
  END IF;
  SELECT p.year_start, p.locked_at INTO v_year_start, v_locked
    FROM public.fiscal_periods p
    WHERE p.tenant_id = v_tenant AND p.starts_on <= p_date AND p.ends_on >= p_date
    -- Held until the document's transaction ends: an owner locking this period waits for every
    -- document already on its way in, and no document can start once the lock is in place.
    FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no fiscal period covers %', p_date USING ERRCODE = 'SE001';
  END IF;
  IF v_locked IS NOT NULL THEN
    RAISE EXCEPTION 'the fiscal period of % is locked', p_date USING ERRCODE = 'SE002';
  END IF;
  -- "2627" for a year that starts in July 2026; "2026" for a calendar year.
  v_code := CASE WHEN extract(month FROM v_year_start) = 1
              THEN to_char(v_year_start, 'YYYY')
              ELSE to_char(v_year_start, 'YY') || to_char(v_year_start + interval '1 year', 'YY')
            END;
  INSERT INTO public.number_series (tenant_id, document_type, year_start, year_code, next_number)
    VALUES (v_tenant, p_type, v_year_start, v_code, 2)
    ON CONFLICT (tenant_id, document_type, year_start)
    DO UPDATE SET next_number = public.number_series.next_number + 1, updated_at = now()
    RETURNING next_number - 1 INTO v_number;
  RETURN p_type || '-' || v_code || '-' ||
    CASE WHEN v_number < 100000 THEN lpad(v_number::text, 5, '0') ELSE v_number::text END;
END $$;
--> statement-breakpoint

-- ── audit rows only the database writes: a later step names its own ─────────────────────────────
-- An audit row of a kind the database writes itself is refused when the app's role writes it
-- directly (drizzle/0016_sales_documents.sql). The kinds so far stay in the check below. A step
-- whose own functions write audit rows for a thing of its own, say a receipt, adds
--   app.audit_reserved_receipt(p_action text) RETURNS boolean
-- which says whether that action is one of its own; the thing is whatever stands before the
-- first full stop of the action. The app's role may ask this question and nothing more.
--
-- Every type is named in full, pg_catalog.text and not text, and the temporary schema is
-- searched last. A session may make a temporary table of its own called "text"; a bare "text"
-- would then name that table's row type, the function would not be found, and the answer would
-- be "not reserved".
CREATE FUNCTION app.audit_action_reserved(p_action pg_catalog.text) RETURNS boolean
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_thing pg_catalog.text := substring(p_action from '^([a-z_]{1,40})[.]');
  v_reserved pg_catalog.bool := false;
BEGIN
  IF v_thing IS NOT NULL AND to_regprocedure(format('app.%I(pg_catalog.text)', 'audit_reserved_' || v_thing)) IS NOT NULL THEN
    EXECUTE format('SELECT app.%I($1)', 'audit_reserved_' || v_thing) INTO v_reserved USING p_action;
  END IF;
  RETURN coalesce(v_reserved, false);
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.audit_action_reserved(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.audit_action_reserved(text) TO app_runtime;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.check_audit_row() RETURNS trigger
  LANGUAGE plpgsql SET search_path = ''
  AS $$
BEGIN
  IF session_user = 'postgres' THEN
    RETURN NEW;
  END IF;
  NEW.at := now();
  IF current_user = session_user AND (NEW.action ~ '^(journal\.(post|reverse)|sales_[a-z_]+\.(submit|cancel|hold|release|credit_override)|customer\.credit_limit)$' OR app.audit_action_reserved(NEW.action)) THEN
    RAISE EXCEPTION 'that audit row is written by the database itself' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;

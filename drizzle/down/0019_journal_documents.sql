-- Reverses drizzle/0019_journal_documents.sql. Never run automatically. It puts back the four
-- shared functions as they were (the journal check that names every kind of document, the
-- starting chart, document numbers, the audit check) and removes the per-kind functions. Run it
-- by hand, as postgres, only after showing it to the founder and getting a yes, and only while
-- no later migration has added a function of its own to any of the four: what that function
-- adds would be forgotten by the old ones.

BEGIN;

CREATE OR REPLACE FUNCTION app.check_journal_backed() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
  AS $$
DECLARE
  v_backed boolean;
BEGIN
  v_backed := CASE NEW.source_type
    WHEN 'manual_journal' THEN EXISTS (
      SELECT 1 FROM public.manual_journals m
      WHERE m.tenant_id = NEW.tenant_id AND m.id = NEW.source_id AND m.journal_id = NEW.id AND m.status IN ('posted', 'reversed'))
    WHEN 'opening_balance' THEN EXISTS (
      SELECT 1 FROM public.opening_entries e
      WHERE e.tenant_id = NEW.tenant_id AND e.id = NEW.source_id AND e.journal_id = NEW.id AND e.status IN ('posted', 'reversed'))
    WHEN 'delivery_note' THEN EXISTS (
      SELECT 1 FROM public.sales_documents d
      WHERE d.tenant_id = NEW.tenant_id AND d.id = NEW.source_id AND d.kind = 'delivery' AND d.status IN ('submitted', 'cancelled') AND d.number = NEW.document_number)
    WHEN 'sales_invoice' THEN EXISTS (
      SELECT 1 FROM public.sales_documents d
      WHERE d.tenant_id = NEW.tenant_id AND d.id = NEW.source_id AND d.kind = 'invoice' AND d.status = 'submitted' AND d.number = NEW.document_number)
    WHEN 'reversal' THEN
      EXISTS (SELECT 1 FROM public.manual_journals m WHERE m.tenant_id = NEW.tenant_id AND m.journal_id = NEW.reverses_journal_id AND m.reversal_journal_id = NEW.id AND m.status = 'reversed')
      OR EXISTS (SELECT 1 FROM public.opening_entries e WHERE e.tenant_id = NEW.tenant_id AND e.journal_id = NEW.reverses_journal_id AND e.reversal_journal_id = NEW.id AND e.status = 'reversed')
      OR EXISTS (
        SELECT 1 FROM public.journals o
        JOIN public.sales_documents d ON d.tenant_id = o.tenant_id AND d.id = o.source_id
        WHERE o.tenant_id = NEW.tenant_id AND o.id = NEW.reverses_journal_id AND o.source_type = 'delivery_note' AND d.kind = 'delivery' AND d.status = 'cancelled')
    ELSE false
  END;
  IF NOT coalesce(v_backed, false) THEN
    RAISE EXCEPTION 'a journal is kept only with the document it was posted for' USING ERRCODE = 'SE074';
  END IF;
  RETURN NULL;
END $$;

DROP FUNCTION app.journal_backed_manual_journal(public.journals);
DROP FUNCTION app.reversal_backed_manual_journal(public.journals, public.journals);
DROP FUNCTION app.journal_backed_opening_balance(public.journals);
DROP FUNCTION app.reversal_backed_opening_balance(public.journals, public.journals);
DROP FUNCTION app.journal_backed_delivery_note(public.journals);
DROP FUNCTION app.reversal_backed_delivery_note(public.journals, public.journals);
DROP FUNCTION app.journal_backed_sales_invoice(public.journals);

-- The starting chart, document numbers and audit rows, as they were before.
CREATE OR REPLACE FUNCTION app.check_audit_row() RETURNS trigger
  LANGUAGE plpgsql SET search_path = ''
  AS $$
BEGIN
  IF session_user = 'postgres' THEN
    RETURN NEW;
  END IF;
  NEW.at := now();
  IF current_user = session_user AND NEW.action ~ '^(journal\.(post|reverse)|sales_[a-z_]+\.(submit|cancel|hold|release|credit_override)|customer\.credit_limit)$' THEN
    RAISE EXCEPTION 'that audit row is written by the database itself' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
DROP FUNCTION app.audit_action_reserved(text);
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
  IF p_date IS NULL OR p_type IS NULL
     OR p_type NOT IN ('QT', 'SO', 'DN', 'SI', 'CN', 'PO', 'GR', 'PB', 'DB', 'RC', 'PV', 'JV', 'ST', 'SA', 'EX') THEN
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
CREATE OR REPLACE FUNCTION app.seed_accounts(p_template text) RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
  AS $$
DECLARE
  v_tenant uuid := app.tenant_id();
  v_user uuid := app.current_user_id();
  v_count integer := 0;
  r record;
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
  INSERT INTO public.audit_log (tenant_id, actor_user_id, actor_role, action, entity, after)
    VALUES (v_tenant, v_user, 'owner', 'accounts.seed', 'accounts', jsonb_build_object('template', p_template, 'accounts', v_count));
  RETURN v_count;
END $$;

-- The row drizzle-kit wrote for 0019_journal_documents (its "when" in drizzle/meta/_journal.json).
DELETE FROM drizzle.__drizzle_migrations WHERE created_at = 1794581449059;

COMMIT;

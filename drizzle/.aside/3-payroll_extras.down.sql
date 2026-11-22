-- Reverses drizzle/0034_payroll_extras.sql. Never run automatically. Run it by hand, as postgres,
-- only after showing it to the founder and getting a yes. It refuses to run once any loan to staff
-- has been made: its journal cannot be removed. It DELETES every person's bank details, and the
-- account Loans and advances to staff from every chart.

BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.staff_loans) THEN
    RAISE EXCEPTION 'a loan to staff has been made; this migration can no longer be reversed';
  END IF;
END $$;

-- drizzle/0033_payroll_runs.sql's approval, as it was.
CREATE OR REPLACE FUNCTION app.approve_payroll_run(p_run uuid) RETURNS text
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_run public.payroll_runs%ROWTYPE := app.hold_payroll_run(p_run);
  v_tenant uuid := v_run.tenant_id;
  v_me uuid := app.current_user_id();
  v_role public.member_role := app.tenant_role();
  v_today date := (now() AT TIME ZONE 'Asia/Karachi')::date;
  v_date date;
  v_slip record;
  v_row record;
  v_basis jsonb;
  v_gross numeric;
  v_owed numeric;
  v_recovered numeric;
  v_take numeric;
  v_sum record;
  v_salaries numeric;
  v_employer numeric;
  v_statutory numeric;
  v_number text;
  v_journal uuid;
  v_name text;
  v_no integer := 0;
BEGIN
  IF v_role NOT IN ('owner', 'accountant') THEN
    RAISE EXCEPTION 'a run is approved by the owner or an accountant' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF v_run.status <> 'reviewed' THEN
    RAISE EXCEPTION 'only a reviewed run is approved' USING ERRCODE = 'SE354';
  END IF;
  IF v_run.month > v_today THEN
    RAISE EXCEPTION 'a month is approved once it has begun' USING ERRCODE = 'SE355';
  END IF;
  v_date := app.payroll_run_date(v_run.month);
  PERFORM app.require_open_period(v_tenant, v_date);
  -- One approval at a time in a company: each counts the months approved before it.
  PERFORM pg_advisory_xact_lock(hashtextextended('payroll_run:' || v_tenant::text, 0));
  -- The payslips add up to the run, each to itself.
  SELECT coalesce(sum(p.earnings), 0) AS earnings, coalesce(sum(p.commission), 0) AS commission, coalesce(sum(p.tax), 0) AS tax, coalesce(sum(p.eobi_employee), 0) AS eobi,
         coalesce(sum(p.deductions), 0) AS deductions, coalesce(sum(p.net), 0) AS net, coalesce(sum(p.employer_eobi), 0) AS employer_eobi,
         coalesce(sum(p.employer_social_security), 0) AS employer_ss, count(*) AS slips
    INTO v_sum FROM public.payslips p WHERE p.tenant_id = v_tenant AND p.run_id = v_run.id;
  IF v_sum.slips = 0 OR v_sum.earnings <> v_run.earnings OR v_sum.commission <> v_run.commission OR v_sum.tax <> v_run.tax OR v_sum.eobi <> v_run.eobi_employee
     OR v_sum.deductions <> v_run.deductions OR v_sum.net <> v_run.net OR v_sum.employer_eobi <> v_run.employer_eobi OR v_sum.employer_ss <> v_run.employer_social_security THEN
    RAISE EXCEPTION 'the payslips do not add up to the run; work it out again' USING ERRCODE = 'SE356';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.payslips p
    LEFT JOIN LATERAL (
      SELECT coalesce(sum(l.amount) FILTER (WHERE l.kind = 'earning'), 0) AS earning, coalesce(sum(l.amount) FILTER (WHERE l.kind = 'deduction'), 0) AS deduction,
             coalesce(sum(l.amount) FILTER (WHERE l.kind = 'employer'), 0) AS employer
      FROM public.payslip_lines l WHERE l.tenant_id = p.tenant_id AND l.payslip_id = p.id
    ) s ON true
    WHERE p.tenant_id = v_tenant AND p.run_id = v_run.id
      AND (s.earning <> p.earnings + p.commission OR s.deduction <> p.tax + p.eobi_employee + p.deductions OR s.employer <> p.employer_eobi + p.employer_social_security)
  ) THEN
    RAISE EXCEPTION 'a payslip''s lines do not add up to it; work the run out again' USING ERRCODE = 'SE356';
  END IF;
  -- The tax year so far (July to June) is what each payslip was worked out with: the months
  -- approved before it, what they paid and deducted, and the months before payroll was run here
  -- taken as paid. A month approved since, or a day joined changed, would leave this one's tax wrong.
  IF EXISTS (
    SELECT 1 FROM public.payslips p
    JOIN public.employees e ON e.tenant_id = p.tenant_id AND e.id = p.employee_id
    LEFT JOIN LATERAL (
      SELECT coalesce(sum(q.taxable), 0) AS taxable, coalesce(sum(q.tax), 0) AS tax, count(*) AS months
      FROM public.payslips q JOIN public.payroll_runs r ON r.tenant_id = q.tenant_id AND r.id = q.run_id
      WHERE q.tenant_id = p.tenant_id AND q.employee_id = p.employee_id AND r.status IN ('approved', 'paid')
        AND r.month >= make_date(extract(year FROM v_run.month - interval '6 months')::int, 7, 1) AND r.month < v_run.month
    ) b ON true
    LEFT JOIN LATERAL (
      SELECT greatest(make_date(extract(year FROM v_run.month - interval '6 months')::int, 7, 1), date_trunc('month', e.joined_on)::date) AS since
    ) f ON true
    WHERE p.tenant_id = v_tenant AND p.run_id = v_run.id
      AND (b.taxable <> p.taxable_before OR b.tax <> p.tax_before OR b.months <> p.months_before
        OR p.assumed_months <> greatest(0, (extract(year FROM v_run.month) * 12 + extract(month FROM v_run.month))
                                          - (extract(year FROM f.since) * 12 + extract(month FROM f.since)) - b.months))
  ) THEN
    RAISE EXCEPTION 'a month of this tax year has been approved since this run was worked out; work it out again' USING ERRCODE = 'SE356';
  END IF;

  -- Each payslip carries the commission of the login its employee has now, and nobody else's.
  SELECT e.name INTO v_name FROM public.payslips p JOIN public.employees e ON e.tenant_id = p.tenant_id AND e.id = p.employee_id
    WHERE p.tenant_id = v_tenant AND p.run_id = v_run.id AND p.user_id IS DISTINCT FROM e.user_id LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'the login % signs in with has changed since this run was worked out; work it out again', v_name USING ERRCODE = 'SE350';
  END IF;
  -- Commission: each person's, as it stands now, must be what the run was worked out with.
  FOR v_slip IN
    SELECT p.id, p.user_id, p.commission, p.commission_recovered, p.commission_basis, e.name
    FROM public.payslips p JOIN public.employees e ON e.tenant_id = p.tenant_id AND e.id = p.employee_id
    WHERE p.tenant_id = v_tenant AND p.run_id = v_run.id AND p.user_id IS NOT NULL
    ORDER BY p.user_id
  LOOP
    -- As a commission payment does (drizzle/0027_commission_ledger.sql): the person's membership
    -- is held, so nothing is accrued for them and no payment made meanwhile, and something being
    -- recorded on one of their invoices right now is let finish first, never waited for.
    PERFORM 1 FROM public.memberships m WHERE m.tenant_id = v_tenant AND m.user_id = v_slip.user_id FOR NO KEY UPDATE;
    BEGIN
      PERFORM 1 FROM public.commission_accruals a WHERE a.tenant_id = v_tenant AND a.user_id = v_slip.user_id ORDER BY a.id FOR UPDATE NOWAIT;
    EXCEPTION WHEN lock_not_available THEN
      RAISE EXCEPTION 'something is being recorded on one of %''s invoices right now; try again', v_slip.name USING ERRCODE = 'SE357';
    END;
    v_basis := app.commission_basis_of(v_tenant, v_slip.user_id, v_date);
    IF app.commission_summary(v_basis) IS DISTINCT FROM v_slip.commission_basis THEN
      RAISE EXCEPTION 'the commission of % has changed since this run was worked out; work it out again', v_slip.name USING ERRCODE = 'SE350';
    END IF;
    SELECT coalesce(sum(a.released - a.paid), 0) INTO v_gross FROM public.commission_accruals a
      WHERE a.tenant_id = v_tenant AND a.user_id = v_slip.user_id AND a.approved_at IS NOT NULL AND a.released > a.paid
        AND NOT EXISTS (SELECT 1 FROM public.commission_movements m WHERE m.tenant_id = a.tenant_id AND m.accrual_id = a.id AND m.movement_date > v_date);
    SELECT coalesce(sum(a.paid - a.released), 0) INTO v_owed FROM public.commission_accruals a
      WHERE a.tenant_id = v_tenant AND a.user_id = v_slip.user_id AND a.paid > a.released
        AND NOT EXISTS (SELECT 1 FROM public.commission_movements m WHERE m.tenant_id = a.tenant_id AND m.accrual_id = a.id AND m.movement_date > v_date);
    IF v_slip.commission_recovered <> least(v_gross, v_owed) OR v_slip.commission <> v_gross - least(v_gross, v_owed) THEN
      RAISE EXCEPTION 'the commission on %''s payslip is not what is due; work the run out again', v_slip.name USING ERRCODE = 'SE350';
    END IF;
    -- Settled as Step 38 pays it, as at the run's date: what is approved and released is paid;
    -- what was owed back is taken from it, oldest first, as far as it goes. Its journal is the run's.
    FOR v_row IN
      SELECT a.id, a.released - a.paid AS due FROM public.commission_accruals a
      WHERE a.tenant_id = v_tenant AND a.user_id = v_slip.user_id AND a.approved_at IS NOT NULL AND a.released > a.paid
        AND NOT EXISTS (SELECT 1 FROM public.commission_movements m WHERE m.tenant_id = a.tenant_id AND m.accrual_id = a.id AND m.movement_date > v_date)
      ORDER BY a.invoice_date, a.id
    LOOP
      INSERT INTO public.commission_movements (tenant_id, accrual_id, type, amount, movement_date, source_type, source_id, created_by)
        VALUES (v_tenant, v_row.id, 'paid', v_row.due, v_date, 'payroll_run', v_run.id, v_me);
      UPDATE public.commission_accruals a SET paid = a.paid + v_row.due, approved_at = NULL, approved_by = NULL WHERE a.tenant_id = v_tenant AND a.id = v_row.id;
    END LOOP;
    v_recovered := 0;
    IF v_gross > 0 THEN
      FOR v_row IN
        SELECT a.id, a.paid - a.released AS owed FROM public.commission_accruals a
        WHERE a.tenant_id = v_tenant AND a.user_id = v_slip.user_id AND a.paid > a.released
          AND NOT EXISTS (SELECT 1 FROM public.commission_movements m WHERE m.tenant_id = a.tenant_id AND m.accrual_id = a.id AND m.movement_date > v_date)
        ORDER BY a.invoice_date, a.id
      LOOP
        v_take := least(v_row.owed, v_gross - v_recovered);
        EXIT WHEN v_take <= 0;
        INSERT INTO public.commission_movements (tenant_id, accrual_id, type, amount, movement_date, source_type, source_id, created_by)
          VALUES (v_tenant, v_row.id, 'recovery_recorded', v_take, v_date, 'payroll_run', v_run.id, v_me);
        UPDATE public.commission_accruals a SET paid = a.paid - v_take WHERE a.tenant_id = v_tenant AND a.id = v_row.id;
        v_recovered := v_recovered + v_take;
      END LOOP;
    END IF;
  END LOOP;

  v_salaries := v_sum.earnings - v_sum.deductions;
  v_employer := v_sum.employer_eobi + v_sum.employer_ss;
  v_statutory := v_sum.eobi + v_employer;
  IF v_sum.earnings + v_sum.commission + v_employer <= 0 THEN
    RAISE EXCEPTION 'the run pays nothing' USING ERRCODE = 'SE356';
  END IF;
  v_number := app.next_document_number('PR', v_date);
  SET CONSTRAINTS public.journals_balanced, public.journal_lines_balanced, public.journals_with_document DEFERRED;
  INSERT INTO public.journals (tenant_id, journal_date, source_type, source_id, document_number, memo, created_by)
    VALUES (v_tenant, v_date, 'payroll_run', v_run.id, v_number, 'Payroll for ' || to_char(v_run.month, 'FMMonth YYYY'), v_me)
    RETURNING id INTO v_journal;
  IF v_salaries <> 0 THEN
    v_no := v_no + 1;
    INSERT INTO public.journal_lines (tenant_id, journal_id, line_no, account_id, debit, credit, description)
      VALUES (v_tenant, v_journal, v_no, app.control_account(v_tenant, 'salaries_expense'), greatest(v_salaries, 0), greatest(-v_salaries, 0), 'Pay, less fixed deductions');
  END IF;
  IF v_employer > 0 THEN
    v_no := v_no + 1;
    INSERT INTO public.journal_lines (tenant_id, journal_id, line_no, account_id, debit, credit, description)
      VALUES (v_tenant, v_journal, v_no, app.control_account(v_tenant, 'payroll_statutory_expense'), v_employer, 0, 'Employer''s EOBI and social security');
  END IF;
  IF v_sum.commission > 0 THEN
    v_no := v_no + 1;
    INSERT INTO public.journal_lines (tenant_id, journal_id, line_no, account_id, debit, credit, description)
      VALUES (v_tenant, v_journal, v_no, app.control_account(v_tenant, 'commission_payable'), v_sum.commission, 0, 'Commission paid with the salary');
  END IF;
  IF v_sum.net > 0 THEN
    v_no := v_no + 1;
    INSERT INTO public.journal_lines (tenant_id, journal_id, line_no, account_id, debit, credit, description)
      VALUES (v_tenant, v_journal, v_no, app.control_account(v_tenant, 'payroll_payable'), 0, v_sum.net, 'What the people take home');
  END IF;
  IF v_sum.tax > 0 THEN
    v_no := v_no + 1;
    INSERT INTO public.journal_lines (tenant_id, journal_id, line_no, account_id, debit, credit, description)
      VALUES (v_tenant, v_journal, v_no, app.control_account(v_tenant, 'wht_income_tax'), 0, v_sum.tax, 'Income tax deducted from pay (s.149)');
  END IF;
  IF v_statutory > 0 THEN
    v_no := v_no + 1;
    INSERT INTO public.journal_lines (tenant_id, journal_id, line_no, account_id, debit, credit, description)
      VALUES (v_tenant, v_journal, v_no, app.control_account(v_tenant, 'payroll_statutory_payable'), 0, v_statutory, 'EOBI and social security');
  END IF;
  UPDATE public.payroll_runs r SET status = 'approved', number = v_number, journal_id = v_journal, journal_date = v_date, approved_at = now(), approved_by = v_me,
      updated_at = now(), updated_by = v_me
    WHERE r.tenant_id = v_tenant AND r.id = v_run.id;
  INSERT INTO public.audit_log (tenant_id, actor_user_id, actor_role, action, entity, entity_id, after)
    VALUES (v_tenant, v_me, v_role, 'journal.post', 'journal', v_journal,
      jsonb_build_object('date', v_date, 'source', 'payroll_run', 'sourceId', v_run.id, 'number', v_number, 'lines', v_no, 'total', (greatest(v_salaries, 0) + v_employer + v_sum.commission)::text)),
           (v_tenant, v_me, v_role, 'payroll_run.approve', 'payroll_run', v_run.id,
      jsonb_build_object('number', v_number, 'month', v_run.month, 'date', v_date, 'net', v_sum.net::text, 'tax', v_sum.tax::text, 'commission', v_sum.commission::text));
  RETURN v_number;
END $$;

DELETE FROM public.accounts a WHERE a.control_type = 'staff_advances';
DROP FUNCTION app.chart_extra_staff_advances();
DROP FUNCTION app.audit_reserved_staff_loan(text);
DROP FUNCTION app.document_type_sl(), app.document_type_lr();
DROP FUNCTION app.journal_backed_staff_loan(public.journals), app.journal_backed_staff_loan_repayment(public.journals);
DROP FUNCTION app.repay_staff_loan(uuid, date, numeric, uuid);
DROP FUNCTION app.issue_staff_loan(uuid, date, numeric, numeric, uuid, text);
DROP TABLE public.employee_bank_accounts;
DROP FUNCTION app.check_employee_bank_account();
ALTER TABLE public.payslip_lines DROP CONSTRAINT payslip_lines_loan_fk, DROP CONSTRAINT payslip_lines_loan_named, DROP COLUMN loan_id;
ALTER TABLE public.payslips DROP CONSTRAINT payslips_loan_within_deductions, DROP COLUMN loan_recovery;
ALTER TABLE public.payroll_runs DROP CONSTRAINT payroll_runs_loan_within_deductions, DROP COLUMN loan_recovery;
DROP TABLE public.staff_loan_movements, public.staff_loans;
-- The row drizzle-kit wrote for 0034_payroll_extras (its "when" in drizzle/meta/_journal.json).
DELETE FROM drizzle.__drizzle_migrations WHERE created_at = 1795009276787;

COMMIT;

-- Reverses drizzle/0033_payroll_runs.sql. Never run automatically. Run it by hand, as postgres,
-- only after showing it to the founder and getting a yes. It refuses to run once any run has been
-- approved: its journal and the commission it settled cannot be taken back, and without this
-- migration nothing would say where they came from. It DELETES every draft, reviewed and
-- cancelled run with its payslips, and the account Employer EOBI and social security from every
-- chart.

BEGIN;

-- Nobody works a run out while this runs.
LOCK TABLE public.payroll_runs IN ACCESS EXCLUSIVE MODE;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.payroll_runs r WHERE r.status IN ('approved', 'paid')) THEN
    RAISE EXCEPTION 'a payroll run has been approved; this migration can no longer be reversed';
  END IF;
END $$;

-- drizzle/0028_commission_statements.sql's statement, as it was.
CREATE OR REPLACE FUNCTION app.commission_statement(p_user uuid, p_from date, p_to date)
  RETURNS TABLE (seq bigint, movement_date date, type text, amount numeric, source_type text, source_id uuid, source_number text,
                 invoice_id uuid, invoice_number text, customer_name text, kind text, seller_user_id uuid, team_rate numeric)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_tenant uuid := app.tenant_id();
  v_people uuid[] := app.commission_statement_people();
BEGIN
  -- Someone who is not a member of the company has no statement here, whoever asks.
  IF v_tenant IS NULL OR p_user IS NULL OR NOT (v_people IS NULL OR p_user = ANY (v_people))
     OR NOT EXISTS (SELECT 1 FROM public.memberships ms WHERE ms.tenant_id = v_tenant AND ms.user_id = p_user) THEN
    RAISE EXCEPTION 'not allowed to see this commission statement' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_from IS NULL OR p_to IS NULL OR NOT isfinite(p_from) OR NOT isfinite(p_to) OR p_from > p_to THEN
    RAISE EXCEPTION 'a period is needed' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  RETURN QUERY
    SELECT 0::bigint, p_from, m.type, sum(m.amount), 'opening'::text, NULL::uuid, NULL::text, NULL::uuid, NULL::text, NULL::text, NULL::text, NULL::uuid, NULL::numeric
    FROM public.commission_movements m
    JOIN public.commission_accruals a ON a.tenant_id = m.tenant_id AND a.id = m.accrual_id
    WHERE m.tenant_id = v_tenant AND a.user_id = p_user AND m.movement_date < p_from
    GROUP BY m.type;
  RETURN QUERY
    SELECT m.seq, m.movement_date, m.type, m.amount, m.source_type, m.source_id,
      CASE m.source_type
        WHEN 'receipt' THEN (SELECT r.number FROM public.receipts r WHERE r.tenant_id = m.tenant_id AND r.id = m.source_id)
        WHEN 'credit_note' THEN (SELECT n.number FROM public.sales_documents n WHERE n.tenant_id = m.tenant_id AND n.id = m.source_id)
        WHEN 'commission_payment' THEN (SELECT p.number FROM public.commission_payments p WHERE p.tenant_id = m.tenant_id AND p.id = m.source_id)
      END,
      a.invoice_id, d.number, d.buyer_name, a.kind, a.seller_user_id, a.team_rate
    FROM public.commission_movements m
    JOIN public.commission_accruals a ON a.tenant_id = m.tenant_id AND a.id = m.accrual_id
    LEFT JOIN public.sales_documents d ON d.tenant_id = a.tenant_id AND d.id = a.invoice_id
    WHERE m.tenant_id = v_tenant AND a.user_id = p_user AND m.movement_date BETWEEN p_from AND p_to
    ORDER BY m.movement_date, m.seq;
END $$;

DELETE FROM public.accounts a WHERE a.control_type = 'payroll_statutory_expense';
DROP FUNCTION app.chart_extra_payroll_statutory_expense();
DROP FUNCTION app.audit_reserved_payroll_run(text);
DROP FUNCTION app.document_type_sp();
DROP FUNCTION app.document_type_pr();
DROP FUNCTION app.journal_backed_payroll_payment(public.journals);
DROP FUNCTION app.journal_backed_payroll_run(public.journals);
DROP FUNCTION app.cancel_payroll_run(uuid, text);
DROP FUNCTION app.pay_payroll_run(uuid, uuid, date);
DROP FUNCTION app.approve_payroll_run(uuid);
DROP FUNCTION app.review_payroll_run(uuid);
DROP FUNCTION app.hold_payroll_run(uuid);
DROP FUNCTION app.payroll_commission_basis(uuid);
DROP FUNCTION app.commission_basis_of(uuid, uuid);
DROP TABLE public.payslip_lines, public.payslips, public.payroll_runs;
DROP FUNCTION app.check_payslip_row();
DROP FUNCTION app.check_payroll_run_row();

-- The row drizzle-kit wrote for 0033_payroll_runs (its "when" in drizzle/meta/_journal.json).
DELETE FROM drizzle.__drizzle_migrations WHERE created_at = 1794939605226;

COMMIT;

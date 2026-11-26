-- Reverses drizzle/0047_tax_paid_over.sql. Never run automatically. Run it by hand, as postgres,
-- only after showing it to the founder and getting a yes. It DELETES the record of which tax
-- withheld on an expense, and which payroll run's salary tax, each challan paid. The challans
-- themselves and their journals stay. It refuses to run once any challan has paid such tax:
-- that challan's amount would no longer be explained by what it paid.

BEGIN;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.challan_expense_entries) OR EXISTS (SELECT 1 FROM public.challan_payroll_runs) THEN
    RAISE EXCEPTION 'a challan has paid tax withheld on an expense or deducted from salaries: this cannot be reversed on this database';
  END IF;
END $$;
DROP TRIGGER expenses_tax_paid_over ON public.expenses;
DROP FUNCTION app.check_expense_tax_paid_over();
DROP FUNCTION app.record_tax_challan(text, date, uuid, text, uuid[], uuid[], uuid[], text);
DROP TABLE public.challan_payroll_runs;
DROP TABLE public.challan_expense_entries;
DROP FUNCTION app.refuse_tax_challan_change();
DELETE FROM drizzle.__drizzle_migrations WHERE created_at = 1795702343634;
COMMIT;

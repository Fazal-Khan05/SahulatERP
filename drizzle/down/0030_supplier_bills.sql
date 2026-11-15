-- Reverses drizzle/0030_supplier_bills.sql. Never run automatically. Run it by hand, as postgres, only
-- after showing it to the founder and getting a yes. It refuses to run once any bill has been
-- posted: its journal cannot be removed, and without this migration nothing would say where
-- it came from. It DELETES every draft bill, the companies' choice about withholding, and the
-- account Purchase price differences from every chart.

BEGIN;

-- Nobody writes a bill while this runs.
LOCK TABLE public.supplier_bills IN ACCESS EXCLUSIVE MODE;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.supplier_bills b WHERE b.status = 'posted') THEN
    RAISE EXCEPTION 'a supplier bill has been posted; this migration can no longer be reversed';
  END IF;
END $$;

DROP FUNCTION app.post_supplier_bill(uuid);
DROP FUNCTION app.withholding_rule_on(uuid, text, text, date);
DROP FUNCTION app.audit_reserved_supplier_bill(text);
DROP FUNCTION app.journal_backed_supplier_bill(public.journals);
DELETE FROM public.accounts a WHERE a.control_type = 'purchase_price_difference';
DROP FUNCTION app.chart_extra_purchase_price_differences();
DROP TABLE public.withholding_entries, public.supplier_bill_lines, public.supplier_bills, public.purchase_settings;
DROP FUNCTION app.refuse_withholding_change();
DROP FUNCTION app.check_supplier_bill_line();
DROP FUNCTION app.check_supplier_bill();

-- The row drizzle-kit wrote for 0030_supplier_bills (its "when" in drizzle/meta/_journal.json).
DELETE FROM drizzle.__drizzle_migrations WHERE created_at = 1794736253071;

COMMIT;

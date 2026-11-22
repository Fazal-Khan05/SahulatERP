-- Reverses drizzle/0032_supplier_payments.sql. Never run automatically. Run it by hand, as postgres, only
-- after showing it to the founder and getting a yes. It refuses to run once any payment has
-- been posted or any challan recorded: their journals cannot be removed, and without this
-- migration nothing would say where they came from. It DELETES every draft payment.

BEGIN;

-- Nobody pays a supplier while this runs.
LOCK TABLE public.supplier_payments, public.withholding_challans IN ACCESS EXCLUSIVE MODE;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.supplier_payments p WHERE p.status <> 'draft') OR EXISTS (SELECT 1 FROM public.withholding_challans) THEN
    RAISE EXCEPTION 'a supplier payment has been posted or a challan recorded; this migration can no longer be reversed';
  END IF;
END $$;

DROP FUNCTION app.record_withholding_challan(text, date, uuid, text, uuid[], text);
DROP FUNCTION app.cancel_supplier_payment(uuid, date, text);
DROP FUNCTION app.apply_supplier_advance(uuid, date, jsonb);
DROP FUNCTION app.post_supplier_payment(uuid);
DROP FUNCTION app.paying_account(uuid, uuid);
DROP FUNCTION app.reverse_payment_journal(uuid, uuid, date, text);
DROP FUNCTION app.bill_owed(uuid, uuid);
DROP FUNCTION app.hold_supplier_payment(uuid);
DROP FUNCTION app.audit_reserved_withholding_challan(text);
DROP FUNCTION app.audit_reserved_supplier_payment(text);
DROP FUNCTION app.journal_backed_withholding_challan(public.journals);
DROP FUNCTION app.reversal_backed_supplier_advance_application(public.journals, public.journals);
DROP FUNCTION app.journal_backed_supplier_advance_application(public.journals);
DROP FUNCTION app.reversal_backed_supplier_payment(public.journals, public.journals);
DROP FUNCTION app.journal_backed_supplier_payment(public.journals);
DROP FUNCTION app.document_type_wc();
DROP TABLE public.withholding_challan_entries, public.withholding_challans, public.supplier_payment_allocations, public.supplier_payments;
DROP FUNCTION app.refuse_challan_change();
DROP FUNCTION app.check_supplier_payment_allocation();
DROP FUNCTION app.check_supplier_payment();

-- The row drizzle-kit wrote for 0032_supplier_payments (its "when" in drizzle/meta/_journal.json).
DELETE FROM drizzle.__drizzle_migrations WHERE created_at = 1794921736535;

COMMIT;

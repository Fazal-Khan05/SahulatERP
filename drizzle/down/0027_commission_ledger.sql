-- Reverses drizzle/0027_commission_ledger.sql. Never run automatically. Run it by hand, as postgres, only
-- after showing it to the founder and getting a yes. It refuses to run once any commission has
-- been accrued: the journals it posted cannot be removed, and without this migration nothing
-- would say what they were for, who was paid, or what is still owed.

BEGIN;

-- Nobody posts an invoice while this runs.
LOCK TABLE public.sales_documents, public.receipts, public.receipt_allocations, public.credit_note_allocations IN ACCESS EXCLUSIVE MODE;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.commission_accruals) THEN
    RAISE EXCEPTION 'commission has been accrued; this migration can no longer be reversed';
  END IF;
END $$;

DROP FUNCTION app.pay_commission(uuid, date, uuid, text);
DROP FUNCTION app.commission_team();
DROP FUNCTION app.approve_commission(uuid[]);
DROP TRIGGER credit_note_allocations_commission ON public.credit_note_allocations;
DROP FUNCTION app.commission_after_credit();
DROP TRIGGER receipts_commission ON public.receipts;
DROP FUNCTION app.commission_after_receipt();
DROP TRIGGER receipt_allocations_commission_changed ON public.receipt_allocations;
DROP TRIGGER receipt_allocations_commission_counted ON public.receipt_allocations;
DROP FUNCTION app.commission_after_allocation();
DROP TRIGGER sales_documents_commission ON public.sales_documents;
DROP FUNCTION app.commission_after_document();
DROP FUNCTION app.refresh_commission(uuid, uuid, text, uuid, date, integer);
DROP FUNCTION app.commission_collected(uuid, uuid);
DROP FUNCTION app.commission_money_in(uuid, uuid);
DROP FUNCTION app.commission_month_sales(uuid, uuid, date);
DROP FUNCTION app.audit_reserved_commission(text);
DROP FUNCTION app.document_type_cp();
DROP FUNCTION app.journal_backed_commission_payment(public.journals);
DROP FUNCTION app.journal_backed_commission_return(public.journals);
DROP FUNCTION app.journal_backed_commission_accrual(public.journals);
DROP TABLE public.commission_movements, public.commission_payments, public.commission_accruals;
DROP FUNCTION app.check_commission_accrual();
DROP FUNCTION app.refuse_commission_change();

-- The row drizzle-kit wrote for 0027_commission_ledger (its "when" in drizzle/meta/_journal.json).
DELETE FROM drizzle.__drizzle_migrations WHERE created_at = 1794699922249;

COMMIT;

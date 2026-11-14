-- Reverses drizzle/0021_receipts.sql. Never run automatically. This DELETES every receipt of
-- every company and what each paid. It leaves the journals those receipts posted where they
-- are (they cannot be removed), with nothing to say where they came from, so every customer's
-- balance in the books stays as the receipts left it. Run it by hand, as postgres, only after
-- showing it to the founder and getting a yes, and never once a real company has posted a
-- receipt.

BEGIN;

DROP TRIGGER opening_entries_receipts_allocated ON public.opening_entries;
DROP FUNCTION app.check_opening_not_received();
DROP FUNCTION app.apply_receipt_advance(uuid, date, jsonb);
DROP FUNCTION app.cancel_receipt(uuid, date, text);
DROP FUNCTION app.bounce_cheque(uuid, date, text);
DROP FUNCTION app.clear_cheque(uuid, date, numeric);
DROP FUNCTION app.deposit_cheque(uuid, uuid, date);
DROP FUNCTION app.post_receipt(uuid);
DROP FUNCTION app.undo_receipt(public.receipts, date, text);
DROP FUNCTION app.require_not_overpaid(uuid, uuid);
DROP FUNCTION app.reverse_receipt_journal(uuid, date, text);
DROP FUNCTION app.receipt_account(uuid, uuid, text);
DROP FUNCTION app.hold_receipt(uuid);
DROP FUNCTION app.receipt_paid(uuid);
DROP FUNCTION app.receipt_accounts();
DROP FUNCTION app.receivables_open(uuid, boolean);
DROP FUNCTION app.receivable_items(uuid, uuid);
DROP FUNCTION app.audit_reserved_cheque(text);
DROP FUNCTION app.audit_reserved_receipt(text);
DROP FUNCTION app.reversal_backed_advance_application(public.journals, public.journals);
DROP FUNCTION app.journal_backed_advance_application(public.journals);
DROP FUNCTION app.journal_backed_cheque_return(public.journals);
DROP FUNCTION app.journal_backed_cheque_clearance(public.journals);
DROP FUNCTION app.reversal_backed_receipt(public.journals, public.journals);
DROP FUNCTION app.journal_backed_receipt(public.journals);
DROP TABLE public.receipt_allocations, public.receipts;
DROP FUNCTION app.check_receipt_allocation();
DROP FUNCTION app.check_receipt();

-- The row drizzle-kit wrote for 0021_receipts (its "when" in drizzle/meta/_journal.json).
DELETE FROM drizzle.__drizzle_migrations WHERE created_at = 1794661663082;

COMMIT;

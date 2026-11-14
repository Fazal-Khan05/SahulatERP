-- Reverses drizzle/0020_stock_documents.sql. Never run automatically. This DELETES every stock
-- transfer, stock adjustment, opening stock entry and stock count of every company. It leaves
-- the stock moves and the journals those documents posted where they are (neither can be
-- removed), with nothing to say where they came from. Run it by hand, as postgres, only after
-- showing it to the founder and getting a yes, and never once a real company has posted one of
-- these documents.

BEGIN;

DROP FUNCTION app.post_stock_count(uuid, timestamptz, boolean);
DROP FUNCTION app.rebook_stock_count(uuid);
DROP FUNCTION app.return_stock_count(uuid);
DROP FUNCTION app.submit_stock_count(uuid);
DROP FUNCTION app.hold_stock_count(uuid, public.member_role[]);
DROP FUNCTION app.post_stock_adjustment(uuid);
DROP FUNCTION app.post_stock_journal(uuid, uuid, public.member_role, date, text, uuid, text, text, uuid, text, numeric, numeric);
DROP FUNCTION app.post_stock_transfer(uuid);
DROP FUNCTION app.stock_gain_value(uuid, uuid, uuid, numeric);
DROP FUNCTION app.audit_reserved_stock_count(text);
DROP FUNCTION app.audit_reserved_stock_adjustment(text);
DROP FUNCTION app.audit_reserved_stock_transfer(text);
DROP FUNCTION app.journal_backed_stock_count(public.journals);
DROP FUNCTION app.journal_backed_stock_adjustment(public.journals);
DROP FUNCTION app.document_type_sc();
DROP TABLE public.stock_count_lines, public.stock_counts, public.stock_adjustment_lines, public.stock_adjustments, public.stock_transfer_lines, public.stock_transfers;
DROP FUNCTION app.check_stock_document_line();
DROP FUNCTION app.check_stock_document();

-- The row drizzle-kit wrote for 0020_stock_documents (its "when" in drizzle/meta/_journal.json).
DELETE FROM drizzle.__drizzle_migrations WHERE created_at = 1794654743372;

COMMIT;

-- Reverses drizzle/0017_delivery_notes.sql. Never run automatically. This DELETES every stock
-- move and stock balance of every company and every delivery note, and leaves the journals the
-- delivery notes posted in the ledger with nothing to say where they came from. Run it by hand,
-- as postgres, only after showing it to the founder and getting a yes, and never once a real
-- company has posted a delivery note.
--
-- The guards and policies that this migration replaced are not put back by this file: after it,
-- run the hand-written sections of drizzle/0016_sales_documents.sql that create
-- app.writes_sales_document, app.check_sales_document, app.check_sales_document_part and the
-- policies on the four sales tables again (dropping the ones named here first).

BEGIN;

DROP TRIGGER sales_documents_delivery_moved ON public.sales_documents;
DROP FUNCTION app.check_delivery_moved();
DROP FUNCTION app.cancel_delivery(uuid, date, text);
DROP FUNCTION app.post_delivery(uuid);
DROP FUNCTION app.order_delivered(uuid);
DELETE FROM public.sales_document_links WHERE to_document_id IN (SELECT id FROM public.sales_documents WHERE kind = 'delivery');
DELETE FROM public.sales_line_salespeople WHERE document_id IN (SELECT id FROM public.sales_documents WHERE kind = 'delivery');
DELETE FROM public.sales_lines WHERE document_id IN (SELECT id FROM public.sales_documents WHERE kind = 'delivery');
DELETE FROM public.sales_documents WHERE kind = 'delivery';
ALTER TABLE public.sales_lines DROP COLUMN source_line_id;
ALTER TABLE public.sales_documents DROP COLUMN source_document_id;
DROP FUNCTION app.move_stock(uuid, uuid, uuid, uuid, date, numeric, numeric, text, uuid, uuid, uuid);
DROP TABLE public.stock_moves, public.stock_balances;
DROP FUNCTION app.refuse_stock_change();

-- The row drizzle-kit wrote for 0017_delivery_notes (its "when" in drizzle/meta/_journal.json).
DELETE FROM drizzle.__drizzle_migrations WHERE created_at = 1794562240411;

COMMIT;

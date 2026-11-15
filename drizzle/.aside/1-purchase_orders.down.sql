-- Reverses drizzle/0028_purchase_orders.sql. Never run automatically. Run it by hand, as postgres, only
-- after showing it to the founder and getting a yes. It refuses to run once any goods have
-- been received: their stock moves and journals cannot be removed, and without this migration
-- nothing would say where they came from. It DELETES every purchase order, drafts and
-- submitted alike.

BEGIN;

-- Nobody writes a purchase document while this runs.
LOCK TABLE public.purchase_orders, public.goods_receipts IN ACCESS EXCLUSIVE MODE;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.goods_receipts r WHERE r.status = 'posted') THEN
    RAISE EXCEPTION 'goods have been received; this migration can no longer be reversed';
  END IF;
END $$;

DROP FUNCTION app.post_goods_receipt(uuid);
DROP FUNCTION app.order_to_receive(uuid);
DROP FUNCTION app.order_lines_to_receive(uuid);
DROP FUNCTION app.orders_to_receive();
DROP FUNCTION app.cancel_purchase_order(uuid, text);
DROP FUNCTION app.submit_purchase_order(uuid);
DROP FUNCTION app.hold_purchase_order(uuid);
DROP FUNCTION app.audit_reserved_goods_receipt(text);
DROP FUNCTION app.audit_reserved_purchase_order(text);
DROP FUNCTION app.journal_backed_goods_receipt(public.journals);
DROP TABLE public.goods_receipt_lines, public.goods_receipts, public.purchase_order_lines, public.purchase_orders;
DROP FUNCTION app.check_purchase_document_line();
DROP FUNCTION app.check_purchase_document();

-- The row drizzle-kit wrote for 0028_purchase_orders (its "when" in drizzle/meta/_journal.json).
DELETE FROM drizzle.__drizzle_migrations WHERE created_at = 1794734267752;

COMMIT;

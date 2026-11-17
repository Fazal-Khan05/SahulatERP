-- Reverses drizzle/0034_shipments.sql. Never run automatically. Run it by hand, as postgres, only
-- after showing it to the founder and getting a yes. It refuses to run once any shipment's
-- charges have been spread or any bill line has been charged to Goods in transit: their
-- journals and stock moves cannot be removed, and without this migration nothing would say
-- where they came from. It DELETES every shipment with the goods and charges put on it. It
-- puts app.check_supplier_bill_line back as drizzle/0030_supplier_bills.sql wrote it, and the
-- two checks on stock_moves back as they were.

BEGIN;

-- Nobody works on shipments, bills or stock while this runs.
LOCK TABLE public.shipments, public.shipment_charges, public.supplier_bill_lines, public.stock_moves IN ACCESS EXCLUSIVE MODE;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.shipment_allocations) OR EXISTS (SELECT 1 FROM public.stock_moves m WHERE m.quantity = 0) THEN
    RAISE EXCEPTION 'a shipment''s charges have been spread; this migration can no longer be reversed';
  END IF;
  IF EXISTS (SELECT 1 FROM public.supplier_bill_lines l JOIN public.accounts a ON a.tenant_id = l.tenant_id AND a.id = l.account_id WHERE a.is_control) THEN
    RAISE EXCEPTION 'a bill line has been charged to Goods in transit; this migration can no longer be reversed';
  END IF;
END $$;

DROP FUNCTION app.cancel_shipment(uuid, text);
DROP FUNCTION app.allocate_shipment(uuid, date);
DROP FUNCTION app.shipment_goods(uuid, uuid);
DROP FUNCTION app.revalue_stock(uuid, uuid, uuid, uuid, date, numeric, text, uuid, uuid);
DROP TABLE public.landed_cost_allocations, public.shipment_charges, public.shipment_allocations, public.shipment_receipts, public.shipments;
DROP FUNCTION app.refuse_landed_cost_change();
DROP FUNCTION app.check_shipment_part();
DROP FUNCTION app.check_shipment();
DROP FUNCTION app.bill_line_charged(uuid, uuid);

CREATE OR REPLACE FUNCTION app.check_supplier_bill_line() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_tenant uuid;
  v_bill public.supplier_bills%ROWTYPE;
  v_scope uuid[] := app.tenant_branch_ids();
BEGIN
  IF session_user = 'postgres' THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    v_tenant := OLD.tenant_id;
  ELSE
    v_tenant := NEW.tenant_id;
  END IF;
  IF v_tenant IS DISTINCT FROM app.tenant_id() THEN
    RAISE EXCEPTION 'not a member of this company' USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- Held the way an update holds a row: two sessions that each add a line and then post would
  -- otherwise each wait for the other to let go.
  SELECT d.* INTO v_bill FROM public.supplier_bills d
    WHERE d.tenant_id = v_tenant AND d.id = (CASE WHEN TG_OP = 'DELETE' THEN OLD.bill_id ELSE NEW.bill_id END)
    FOR NO KEY UPDATE;
  IF TG_OP = 'UPDATE' THEN
    IF NOT FOUND OR v_bill.status <> 'draft'
       OR (to_jsonb(NEW) - 'received_value') IS DISTINCT FROM (to_jsonb(OLD) - 'received_value') THEN
      RAISE EXCEPTION 'a line of a bill is replaced, not changed' USING ERRCODE = 'SE226';
    END IF;
    RETURN NEW;
  END IF;
  -- A line of no bill is left for the foreign key to refuse. Anything else is said only to a
  -- member who could have written the bill: anyone else is refused by the policies, in the same
  -- words as for a bill that is not there at all.
  IF FOUND AND app.tenant_role() IN ('owner', 'accountant') AND (v_scope IS NULL OR v_bill.branch_id = ANY (v_scope)) THEN
    IF v_bill.status <> 'draft' THEN
      RAISE EXCEPTION 'a line is written only while its bill is a draft' USING ERRCODE = 'SE226';
    END IF;
    IF TG_OP = 'INSERT' THEN
      IF NEW.received_value IS NOT NULL THEN
        RAISE EXCEPTION 'what a line cleared is worked out when the bill is posted' USING ERRCODE = 'SE226';
      END IF;
      IF NEW.kind = 'goods' AND NOT EXISTS (
        SELECT 1 FROM public.goods_receipt_lines g
        JOIN public.goods_receipts r ON r.tenant_id = g.tenant_id AND r.id = g.receipt_id
        JOIN public.warehouses w ON w.tenant_id = r.tenant_id AND w.id = r.warehouse_id
        WHERE g.tenant_id = v_tenant AND g.id = NEW.receipt_line_id AND g.item_id = NEW.item_id AND g.quantity >= NEW.quantity
          AND r.status = 'posted' AND r.supplier_id = v_bill.supplier_id AND w.branch_id = v_bill.branch_id
      ) THEN
        RAISE EXCEPTION 'a line of goods is a line of a posted goods received note, from the bill''s supplier, into the bill''s branch, for no more than arrived' USING ERRCODE = 'SE226';
      END IF;
      IF NEW.kind = 'expense' AND NOT EXISTS (
        SELECT 1 FROM public.accounts a
        WHERE a.tenant_id = v_tenant AND a.id = NEW.account_id AND NOT a.is_group AND NOT a.is_control AND a.archived_at IS NULL
          AND a.type IN ('expense', 'asset')
      ) THEN
        RAISE EXCEPTION 'a bill charges an expense or asset account that takes plain entries' USING ERRCODE = 'SE234';
      END IF;
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  NEW.created_at := now();
  RETURN NEW;
END $$;

DROP FUNCTION app.audit_reserved_shipment(text);
DROP FUNCTION app.journal_backed_landed_cost(public.journals);
DROP FUNCTION app.document_type_sh();

ALTER TABLE public.stock_moves DROP CONSTRAINT stock_moves_quantity_sane, DROP CONSTRAINT stock_moves_value_sane;
ALTER TABLE public.stock_moves ADD CONSTRAINT stock_moves_quantity_sane CHECK (quantity <> 0 and quantity > -1e12 and quantity < 1e12);
ALTER TABLE public.stock_moves ADD CONSTRAINT stock_moves_value_sane CHECK (value > -1e16 and value < 1e16 and (value = 0 or sign(value) = sign(quantity)));

-- The row drizzle-kit wrote for 0034_shipments (its "when" in drizzle/meta/_journal.json).
DELETE FROM drizzle.__drizzle_migrations WHERE created_at = 1794937126326;

COMMIT;

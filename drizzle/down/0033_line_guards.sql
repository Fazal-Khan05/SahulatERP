-- Reverses drizzle/0033_line_guards.sql. Never run automatically. Run it by hand, as postgres, only
-- after showing it to the founder and getting a yes. It puts the eight guards and
-- app.apply_supplier_advance back exactly as they were, and with them the hole the migration
-- closed: there is no reason to run it other than to prove the migration can be taken back.
-- It changes no table and no data.

BEGIN;

CREATE OR REPLACE FUNCTION app.check_account() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_parent public.accounts%ROWTYPE;
  v_up uuid;
  v_depth integer := 1;
BEGIN
  IF session_user = 'postgres' THEN
    RETURN NEW;
  END IF;
  IF NEW.tenant_id IS DISTINCT FROM app.tenant_id() THEN
    RAISE EXCEPTION 'not a member of this company' USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    NEW.updated_at := now();
    IF OLD.archived_at IS NOT NULL AND NEW.archived_at IS NOT NULL THEN
      IF NEW.name IS DISTINCT FROM OLD.name OR NEW.code IS DISTINCT FROM OLD.code THEN
        RAISE EXCEPTION 'an archived account is not changed; restore it first' USING ERRCODE = 'SE035';
      END IF;
      NEW.archived_at := OLD.archived_at;
    ELSIF OLD.archived_at IS NULL AND NEW.archived_at IS NOT NULL THEN
      NEW.archived_at := now();
      IF NEW.is_group AND EXISTS (
        SELECT 1 FROM public.accounts c
        WHERE c.tenant_id = NEW.tenant_id AND c.parent_id = NEW.id AND c.archived_at IS NULL
      ) THEN
        RAISE EXCEPTION 'a heading is archived only when everything under it is' USING ERRCODE = 'SE036';
      END IF;
    ELSIF OLD.archived_at IS NOT NULL AND NEW.archived_at IS NULL AND NEW.parent_id IS NOT NULL THEN
      SELECT a.* INTO v_parent FROM public.accounts a
        WHERE a.tenant_id = NEW.tenant_id AND a.id = NEW.parent_id
        FOR SHARE;
      IF v_parent.archived_at IS NOT NULL THEN
        RAISE EXCEPTION 'an account is restored only under a heading that is not archived' USING ERRCODE = 'SE032';
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  NEW.created_at := now();
  NEW.updated_at := now();
  IF NEW.parent_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT a.* INTO v_parent FROM public.accounts a
    WHERE a.tenant_id = NEW.tenant_id AND a.id = NEW.parent_id
    FOR SHARE;
  IF NOT FOUND THEN
    -- Left for the foreign key to refuse.
    RETURN NEW;
  END IF;
  IF NOT v_parent.is_group THEN
    RAISE EXCEPTION 'an account can sit only under a heading' USING ERRCODE = 'SE031';
  END IF;
  IF v_parent.archived_at IS NOT NULL THEN
    RAISE EXCEPTION 'an account cannot sit under an archived heading' USING ERRCODE = 'SE032';
  END IF;
  IF NOT NEW.is_control THEN
    IF NEW.control_type IS DISTINCT FROM (CASE WHEN v_parent.control_type IN ('bank', 'cash') THEN v_parent.control_type END) THEN
      RAISE EXCEPTION 'an account takes what it is for from its heading' USING ERRCODE = 'SE033';
    END IF;
    v_up := v_parent.parent_id;
    WHILE v_up IS NOT NULL LOOP
      v_depth := v_depth + 1;
      SELECT a.parent_id INTO v_up FROM public.accounts a WHERE a.tenant_id = NEW.tenant_id AND a.id = v_up;
    END LOOP;
    IF v_depth > 5 OR (NEW.is_group AND v_depth > 4) THEN
      RAISE EXCEPTION 'accounts can be at most five levels below a root, and headings four' USING ERRCODE = 'SE034';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION app.check_manual_journal_line() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_tenant uuid;
  v_journal uuid;
  v_status text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_tenant := OLD.tenant_id;
    v_journal := OLD.manual_journal_id;
  ELSE
    v_tenant := NEW.tenant_id;
    v_journal := NEW.manual_journal_id;
  END IF;
  IF session_user <> 'postgres' THEN
    IF v_tenant IS DISTINCT FROM app.tenant_id() THEN
      RAISE EXCEPTION 'not a member of this company' USING ERRCODE = 'insufficient_privilege';
    END IF;
    SELECT m.status INTO v_status FROM public.manual_journals m
      WHERE m.tenant_id = v_tenant AND m.id = v_journal
      FOR SHARE;
    IF FOUND AND v_status <> 'draft' THEN
      RAISE EXCEPTION 'a posted manual journal is never changed; reverse it instead' USING ERRCODE = 'SE041';
    END IF;
    IF TG_OP = 'INSERT' THEN
      NEW.created_at := now();
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION app.check_opening_balance() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_tenant uuid;
  v_entry uuid;
  v_status text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_tenant := OLD.tenant_id;
    v_entry := OLD.opening_entry_id;
  ELSE
    v_tenant := NEW.tenant_id;
    v_entry := NEW.opening_entry_id;
  END IF;
  IF session_user <> 'postgres' THEN
    IF v_tenant IS DISTINCT FROM app.tenant_id() THEN
      RAISE EXCEPTION 'not a member of this company' USING ERRCODE = 'insufficient_privilege';
    END IF;
    SELECT e.status INTO v_status FROM public.opening_entries e
      WHERE e.tenant_id = v_tenant AND e.id = v_entry
      FOR SHARE;
    IF FOUND AND v_status <> 'draft' THEN
      RAISE EXCEPTION 'posted opening balances are never changed; reverse them instead' USING ERRCODE = 'SE041';
    END IF;
    IF TG_OP = 'INSERT' THEN
      NEW.created_at := now();
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION app.check_sales_document_part() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_tenant uuid;
  v_document uuid;
  v_status text;
  v_branch uuid;
  v_created_by uuid;
  v_salesperson uuid;
  v_kind text;
  v_source uuid;
  -- What a line of a credit note does not share with the invoice line it takes back.
  v_own text[] := ARRAY['id', 'document_id', 'line_no', 'quantity', 'base_quantity', 'discount_amount', 'tax_amount', 'further_tax_amount',
    'extra_tax_amount', 'value', 'total', 'source_line_id', 'damaged_quantity', 'created_at', 'created_by'];
BEGIN
  IF session_user = 'postgres' THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    v_tenant := OLD.tenant_id;
    IF TG_TABLE_NAME = 'sales_document_links' THEN
      v_document := OLD.to_document_id;
    ELSE
      v_document := OLD.document_id;
    END IF;
  ELSE
    v_tenant := NEW.tenant_id;
    IF TG_TABLE_NAME = 'sales_document_links' THEN
      v_document := NEW.to_document_id;
    ELSE
      v_document := NEW.document_id;
    END IF;
  END IF;
  IF v_tenant IS DISTINCT FROM app.tenant_id() THEN
    RAISE EXCEPTION 'not a member of this company' USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- As for the document itself: a transaction reading an older picture could add a line to a
  -- document that has since been submitted.
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'sales documents are written in read committed transactions' USING ERRCODE = 'SE056';
  END IF;
  SELECT d.status, d.branch_id, d.created_by, d.salesperson_id, d.kind, d.source_document_id INTO v_status, v_branch, v_created_by, v_salesperson, v_kind, v_source FROM public.sales_documents d
    WHERE d.tenant_id = v_tenant AND d.id = v_document
    FOR SHARE;
  -- The document must be one this member may write, asked for this row and at this moment.
  IF FOUND AND (NOT app.writes_sales_document(app.tenant_role(), app.tenant_branch_ids(), app.current_user_id(), v_branch, v_created_by, v_salesperson, v_kind)
                OR (v_kind = 'credit_note' AND app.tenant_role() NOT IN ('owner', 'accountant', 'sales_manager'))) THEN
    RAISE EXCEPTION 'not a sales document this member may write' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF FOUND AND v_status <> 'draft' THEN
    RAISE EXCEPTION 'a submitted document is never changed; cancel it instead' USING ERRCODE = 'SE050';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  NEW.created_at := now();
  IF TG_TABLE_NAME = 'sales_lines' THEN
    IF v_kind IS DISTINCT FROM 'credit_note' AND NEW.damaged_quantity IS NOT NULL THEN
      RAISE EXCEPTION 'only a line of a credit note says how much came back damaged' USING ERRCODE = 'SE120';
    END IF;
    -- (A line of a credit note is in the unit its invoice line was sold in, whatever has
    -- become of the item's units since: the goods come back as they left.)
    IF v_kind IS DISTINCT FROM 'credit_note' AND NOT EXISTS (
      SELECT 1 FROM public.items i
      WHERE i.tenant_id = NEW.tenant_id AND i.id = NEW.item_id
        AND ((i.base_unit_id = NEW.unit_id AND NEW.unit_factor = 1)
          OR EXISTS (SELECT 1 FROM public.item_units u WHERE u.tenant_id = i.tenant_id AND u.item_id = i.id AND u.unit_id = NEW.unit_id AND u.factor = NEW.unit_factor))
    ) THEN
      RAISE EXCEPTION 'a line is sold in one of its item''s own units' USING ERRCODE = 'SE052';
    END IF;
    -- A discount is its percentage of the quantity at the price, to the paisa, and nothing else:
    -- an amount typed beside a percentage could make a line bill anything from nil to the full price.
    IF v_kind IS DISTINCT FROM 'credit_note' AND NEW.discount_amount <> (CASE WHEN NEW.discount_percent IS NULL THEN 0 ELSE round(round(NEW.quantity * NEW.unit_price, 2) * NEW.discount_percent / 100, 2) END) THEN
      RAISE EXCEPTION 'a line''s discount is its percentage of the quantity at the price' USING ERRCODE = 'SE052';
    END IF;
    -- A line of a delivery note delivers one line of the note's own order: the same item, in the
    -- same unit. No other kind of document has a source line yet.
    IF v_kind = 'delivery' THEN
      IF NOT EXISTS (
        SELECT 1 FROM public.sales_lines o
        WHERE o.tenant_id = NEW.tenant_id AND o.id = NEW.source_line_id AND o.document_id = v_source
          AND o.item_id = NEW.item_id AND o.unit_id = NEW.unit_id AND o.unit_factor = NEW.unit_factor
          AND o.unit_price = NEW.unit_price AND o.discount_percent IS NOT DISTINCT FROM NEW.discount_percent
          AND o.list_price IS NOT DISTINCT FROM NEW.list_price AND o.price_source IS NOT DISTINCT FROM NEW.price_source
      ) THEN
        RAISE EXCEPTION 'a line of a delivery note delivers a line of its order, in the same unit and at the order''s price' USING ERRCODE = 'SE052';
      END IF;
      -- Tax belongs to the invoice: a delivery note values the goods and nothing more.
      IF NEW.tax_amount <> 0 OR NEW.further_tax_amount <> 0 OR NEW.extra_tax_amount <> 0 OR NEW.tax_rate <> 0 OR NEW.further_tax_rate <> 0
         OR NEW.tax_kind IS NOT NULL OR NEW.tax_category_id IS NOT NULL THEN
        RAISE EXCEPTION 'a delivery note carries no tax' USING ERRCODE = 'SE052';
      END IF;
    ELSIF v_kind = 'invoice' THEN
      -- A line of an invoice bills one line of what the invoice was made from: the same item,
      -- in the same unit, at its price and discount. The tax is the invoice's own.
      IF NOT EXISTS (
        SELECT 1 FROM public.sales_lines o
        WHERE o.tenant_id = NEW.tenant_id AND o.id = NEW.source_line_id AND o.document_id = v_source
          AND o.item_id = NEW.item_id AND o.unit_id = NEW.unit_id AND o.unit_factor = NEW.unit_factor
          AND o.unit_price = NEW.unit_price AND o.discount_percent IS NOT DISTINCT FROM NEW.discount_percent
          AND o.list_price IS NOT DISTINCT FROM NEW.list_price AND o.price_source IS NOT DISTINCT FROM NEW.price_source
      ) THEN
        RAISE EXCEPTION 'a line of a sales invoice bills a line of what it was made from, in the same unit and at its price' USING ERRCODE = 'SE052';
      END IF;
    ELSIF v_kind = 'credit_note' THEN
      -- A line of a credit note takes back part of one line of the note's own invoice, and is
      -- that line in everything but how much: the same item, unit, price, discount and tax
      -- rates. It says how much of what came back is damaged, in a quantity the item's own unit
      -- can hold. What it comes to is checked against the invoice when the credit note is posted.
      IF NEW.damaged_quantity IS NULL OR NEW.damaged_quantity * NEW.unit_factor <> round(NEW.damaged_quantity * NEW.unit_factor, 4) OR NOT EXISTS (
        SELECT 1 FROM public.sales_lines o
        WHERE o.tenant_id = NEW.tenant_id AND o.id = NEW.source_line_id AND o.document_id = v_source
          AND o.quantity >= NEW.quantity
          AND (to_jsonb(o) - v_own) = (to_jsonb(NEW) - v_own)
      ) THEN
        RAISE EXCEPTION 'a line of a credit note takes back part of a line of its invoice, as that line was billed' USING ERRCODE = 'SE120';
      END IF;
    ELSIF NEW.source_line_id IS NOT NULL THEN
      RAISE EXCEPTION 'only a line of a delivery note, a sales invoice or a credit note follows another line' USING ERRCODE = 'SE052';
    END IF;
  ELSIF TG_TABLE_NAME = 'sales_line_salespeople' THEN
    -- A credit note has no shares of its own: a returned line's are those of the invoice line it takes back.
    IF v_kind = 'credit_note' THEN
      RAISE EXCEPTION 'a credit note carries no salespeople of its own' USING ERRCODE = 'SE120';
    END IF;
    -- An invoice's shares are its order's, copied by the posting function; whoever has left the sales team since still has theirs.
    IF v_kind <> 'invoice' AND NOT EXISTS (
      SELECT 1 FROM public.memberships m
      WHERE m.tenant_id = NEW.tenant_id AND m.user_id = NEW.user_id AND m.active AND m.role IN ('owner', 'sales_manager', 'salesperson')
    ) THEN
      RAISE EXCEPTION 'a share of a sale goes to an active member of the sales team' USING ERRCODE = 'SE052';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION app.check_stock_document_line() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_line jsonb;
  v_tenant uuid;
  v_status text;
  v_warehouse uuid;
  v_warehouses uuid[];
  v_scope uuid[] := app.tenant_branch_ids();
  v_writers public.member_role[] := ARRAY['owner', 'accountant', 'warehouse_manager'];
BEGIN
  IF session_user = 'postgres' THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    v_line := to_jsonb(OLD);
  ELSE
    v_line := to_jsonb(NEW);
  END IF;
  v_tenant := (v_line->>'tenant_id')::uuid;
  IF v_tenant IS DISTINCT FROM app.tenant_id() THEN
    RAISE EXCEPTION 'not a member of this company' USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- Held the way an update holds a row, not shared: two sessions that each add a line and then
  -- post would otherwise each wait for the other to let go.
  IF TG_TABLE_NAME = 'stock_transfer_lines' THEN
    SELECT d.status, ARRAY[d.from_warehouse_id, d.to_warehouse_id] INTO v_status, v_warehouses FROM public.stock_transfers d
      WHERE d.tenant_id = v_tenant AND d.id = (v_line->>'transfer_id')::uuid
      FOR NO KEY UPDATE;
  ELSIF TG_TABLE_NAME = 'stock_adjustment_lines' THEN
    v_writers := ARRAY['owner', 'accountant'];
    SELECT d.status, ARRAY[d.warehouse_id] INTO v_status, v_warehouses FROM public.stock_adjustments d
      WHERE d.tenant_id = v_tenant AND d.id = (v_line->>'adjustment_id')::uuid
      FOR NO KEY UPDATE;
  ELSE
    SELECT d.status, d.warehouse_id, ARRAY[d.warehouse_id] INTO v_status, v_warehouse, v_warehouses FROM public.stock_counts d
      WHERE d.tenant_id = v_tenant AND d.id = (v_line->>'count_id')::uuid
      FOR NO KEY UPDATE;
  END IF;
  -- A line of no document is left for the foreign key to refuse. A document that is not a
  -- draft is named as such only to a member who could have written it: anyone else is refused
  -- by the policies, in the same words as for a document that is not there at all.
  IF FOUND AND v_status <> 'draft'
     AND app.tenant_role() = ANY (v_writers)
     AND (v_scope IS NULL OR NOT EXISTS (
       SELECT 1 FROM public.warehouses w WHERE w.tenant_id = v_tenant AND w.id = ANY (v_warehouses) AND NOT (w.branch_id = ANY (v_scope)))) THEN
    RAISE EXCEPTION 'a line is written only while its stock document is a draft' USING ERRCODE = 'SE204';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF (v_line - ARRAY['counted_quantity', 'book_quantity']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['counted_quantity', 'book_quantity']) THEN
      RAISE EXCEPTION 'a line of a stock document is replaced, not changed' USING ERRCODE = 'SE204';
    END IF;
    RETURN NEW;
  END IF;
  NEW.created_at := now();
  IF TG_TABLE_NAME = 'stock_count_lines' THEN
    NEW.book_quantity := coalesce((
      SELECT b.quantity FROM public.stock_balances b
      WHERE b.tenant_id = v_tenant AND b.item_id = NEW.item_id AND b.warehouse_id = v_warehouse), 0);
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION app.check_receipt_allocation() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_tenant uuid;
  v_receipt uuid;
  v_status text;
  v_branch uuid;
  v_customer uuid;
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
    v_receipt := OLD.receipt_id;
  ELSE
    v_tenant := NEW.tenant_id;
    v_receipt := NEW.receipt_id;
  END IF;
  IF v_tenant IS DISTINCT FROM app.tenant_id() THEN
    RAISE EXCEPTION 'not a member of this company' USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- Held the way an update holds a row: two sessions that each add a row and then post take their turn.
  SELECT r.status, r.branch_id, r.customer_id INTO v_status, v_branch, v_customer FROM public.receipts r
    WHERE r.tenant_id = v_tenant AND r.id = v_receipt
    FOR NO KEY UPDATE;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.id <> OLD.id OR NEW.receipt_id <> OLD.receipt_id OR NEW.invoice_id IS DISTINCT FROM OLD.invoice_id OR NEW.opening_balance_id IS DISTINCT FROM OLD.opening_balance_id
       OR NEW.amount <> OLD.amount OR NEW.created_by <> OLD.created_by OR NEW.created_at <> OLD.created_at
       OR (OLD.posted_at IS NOT NULL AND (NEW.posted_at IS DISTINCT FROM OLD.posted_at OR NEW.allocated_on IS DISTINCT FROM OLD.allocated_on))
       OR (OLD.voided_at IS NOT NULL AND NEW.voided_at IS DISTINCT FROM OLD.voided_at)
       OR (OLD.journal_id IS NOT NULL AND NEW.journal_id IS DISTINCT FROM OLD.journal_id) THEN
      RAISE EXCEPTION 'what a receipt pays is not changed once it is written' USING ERRCODE = 'SE105';
    END IF;
    RETURN NEW;
  END IF;
  -- A receipt that is not there is left for the foreign key to refuse. One that is not a
  -- draft is named as such only to a member who could have written it: anyone else is refused
  -- by the policies, in the same words as for a receipt that is not there at all.
  IF FOUND AND app.tenant_role() IN ('owner', 'accountant', 'recovery_officer') AND (v_scope IS NULL OR v_branch = ANY (v_scope)) THEN
    IF TG_OP = 'DELETE' THEN
      IF v_status <> 'draft' OR OLD.posted_at IS NOT NULL THEN
        RAISE EXCEPTION 'what a posted receipt pays is never removed; cancel the receipt instead' USING ERRCODE = 'SE105';
      END IF;
    ELSIF NEW.posted_at IS NULL AND v_status <> 'draft' THEN
      RAISE EXCEPTION 'what a receipt pays is written only while the receipt is a draft' USING ERRCODE = 'SE105';
    ELSIF NEW.posted_at IS NOT NULL AND v_status <> 'posted' THEN
      RAISE EXCEPTION 'an advance is set against an invoice only while its receipt stands' USING ERRCODE = 'SE105';
    END IF;
    -- A row names a posted invoice of the receipt's own customer (or a line of the opening
    -- balances that stand), and for a member limited to some branches one of those branches'
    -- invoices. Anything else is refused in the same words, whether it is another customer's,
    -- another kind of document, or not there at all: a row never says what else exists.
    IF TG_OP = 'INSERT' AND NOT EXISTS (
      SELECT 1 FROM app.receivable_items(v_tenant, v_customer) i
      WHERE ((i.kind = 'invoice' AND i.id = NEW.invoice_id) OR (i.kind = 'opening' AND i.id = NEW.opening_balance_id))
        AND (v_scope IS NULL OR i.branch_id = ANY (v_scope))
    ) THEN
      RAISE EXCEPTION 'a receipt pays posted invoices of its own customer' USING ERRCODE = 'SE102';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  NEW.created_at := now();
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION app.check_purchase_document_line() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_line jsonb;
  v_tenant uuid;
  v_status text;
  v_warehouse uuid;
  v_order uuid;
  v_scope uuid[] := app.tenant_branch_ids();
  v_writers public.member_role[];
BEGIN
  IF session_user = 'postgres' THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'a line of a purchase document is replaced, not changed' USING ERRCODE = 'SE214';
  END IF;
  IF TG_OP = 'DELETE' THEN
    v_line := to_jsonb(OLD);
  ELSE
    v_line := to_jsonb(NEW);
  END IF;
  v_tenant := (v_line->>'tenant_id')::uuid;
  IF v_tenant IS DISTINCT FROM app.tenant_id() THEN
    RAISE EXCEPTION 'not a member of this company' USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- Held the way an update holds a row, not shared: two sessions that each add a line and then
  -- post would otherwise each wait for the other to let go.
  IF TG_TABLE_NAME = 'purchase_order_lines' THEN
    v_writers := ARRAY['owner', 'accountant'];
    SELECT d.status, d.warehouse_id INTO v_status, v_warehouse FROM public.purchase_orders d
      WHERE d.tenant_id = v_tenant AND d.id = (v_line->>'order_id')::uuid
      FOR NO KEY UPDATE;
  ELSE
    v_writers := ARRAY['owner', 'accountant', 'warehouse_manager'];
    SELECT d.status, d.warehouse_id, d.order_id INTO v_status, v_warehouse, v_order FROM public.goods_receipts d
      WHERE d.tenant_id = v_tenant AND d.id = (v_line->>'receipt_id')::uuid
      FOR NO KEY UPDATE;
  END IF;
  -- A line of no document is left for the foreign key to refuse. Anything else is said only to
  -- a member who could have written the document: anyone else is refused by the policies, in
  -- the same words as for a document that is not there at all.
  IF FOUND AND app.tenant_role() = ANY (v_writers)
     AND (v_scope IS NULL OR EXISTS (SELECT 1 FROM public.warehouses w WHERE w.tenant_id = v_tenant AND w.id = v_warehouse AND w.branch_id = ANY (v_scope))) THEN
    IF v_status <> 'draft' THEN
      RAISE EXCEPTION 'a line is written only while its purchase document is a draft' USING ERRCODE = 'SE214';
    END IF;
    -- The two tables share this guard, so a line's own columns are read from v_line: a column
    -- one table lacks cannot be named on NEW.
    IF TG_OP = 'INSERT' AND TG_TABLE_NAME = 'purchase_order_lines' AND NOT EXISTS (
      SELECT 1 FROM public.items i
      WHERE i.tenant_id = v_tenant AND i.id = (v_line->>'item_id')::uuid
        AND ((i.base_unit_id = (v_line->>'unit_id')::uuid AND (v_line->>'unit_factor')::numeric = 1)
          OR EXISTS (SELECT 1 FROM public.item_units u WHERE u.tenant_id = i.tenant_id AND u.item_id = i.id
                       AND u.unit_id = (v_line->>'unit_id')::uuid AND u.factor = (v_line->>'unit_factor')::numeric))
    ) THEN
      RAISE EXCEPTION 'a line is ordered in one of its item''s own units' USING ERRCODE = 'SE214';
    END IF;
    IF TG_OP = 'INSERT' AND TG_TABLE_NAME = 'goods_receipt_lines' AND NOT EXISTS (
      SELECT 1 FROM public.purchase_order_lines o
      WHERE o.tenant_id = v_tenant AND o.id = (v_line->>'order_line_id')::uuid AND o.order_id = v_order
        AND o.item_id = (v_line->>'item_id')::uuid AND o.unit_factor = (v_line->>'unit_factor')::numeric
        AND o.quantity >= (v_line->>'quantity')::numeric
    ) THEN
      RAISE EXCEPTION 'a line of goods received is a line of its order, in the unit it was ordered in, for no more than was ordered' USING ERRCODE = 'SE214';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  NEW.created_at := now();
  RETURN NEW;
END $$;

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

CREATE OR REPLACE FUNCTION app.check_supplier_payment_allocation() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_tenant uuid;
  v_payment public.supplier_payments%ROWTYPE;
  v_scope uuid[] := app.tenant_branch_ids();
BEGIN
  IF session_user = 'postgres' THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'what a payment settles is replaced, not changed' USING ERRCODE = 'SE238';
  END IF;
  IF TG_OP = 'DELETE' THEN
    v_tenant := OLD.tenant_id;
  ELSE
    v_tenant := NEW.tenant_id;
  END IF;
  IF v_tenant IS DISTINCT FROM app.tenant_id() THEN
    RAISE EXCEPTION 'not a member of this company' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT d.* INTO v_payment FROM public.supplier_payments d
    WHERE d.tenant_id = v_tenant AND d.id = (CASE WHEN TG_OP = 'DELETE' THEN OLD.payment_id ELSE NEW.payment_id END)
    FOR NO KEY UPDATE;
  -- A row of no payment is left for the foreign key to refuse. Anything else is said only to a
  -- member who could have written the payment: anyone else is refused by the policies, in the
  -- same words as for a payment that is not there at all.
  IF FOUND AND app.tenant_role() IN ('owner', 'accountant') AND (v_scope IS NULL OR v_payment.branch_id = ANY (v_scope)) THEN
    IF TG_OP = 'DELETE' THEN
      IF v_payment.status <> 'draft' OR OLD.journal_id IS NOT NULL THEN
        RAISE EXCEPTION 'what a posted payment settled is never removed' USING ERRCODE = 'SE238';
      END IF;
    ELSE
      IF (NEW.journal_id IS NULL AND v_payment.status <> 'draft') OR (NEW.journal_id IS NOT NULL AND v_payment.status <> 'posted') THEN
        RAISE EXCEPTION 'what a payment settles is written while it is a draft; an advance is set against a bill once it is posted' USING ERRCODE = 'SE238';
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM public.supplier_bills b
        WHERE b.tenant_id = v_tenant AND b.id = NEW.bill_id AND b.status = 'posted'
          AND b.supplier_id = v_payment.supplier_id AND b.branch_id = v_payment.branch_id
      ) THEN
        RAISE EXCEPTION 'a payment settles posted bills of its own supplier and branch' USING ERRCODE = 'SE238';
      END IF;
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  NEW.created_at := now();
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION app.apply_supplier_advance(p_payment uuid, p_date date, p_allocations jsonb) RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_doc public.supplier_payments%ROWTYPE := app.hold_supplier_payment(p_payment);
  v_tenant uuid := v_doc.tenant_id;
  v_user uuid := app.current_user_id();
  v_role public.member_role := app.tenant_role();
  v_supplier text;
  v_left numeric;
  v_line record;
  v_total numeric := 0;
  v_lines integer := 0;
  v_journal uuid;
  v_id uuid;
BEGIN
  IF v_doc.status <> 'posted' THEN
    RAISE EXCEPTION 'an advance is set against a bill from a posted payment' USING ERRCODE = 'SE236';
  END IF;
  IF p_date IS NULL OR NOT isfinite(p_date) OR p_date < v_doc.payment_date OR p_date > (now() AT TIME ZONE 'Asia/Karachi')::date THEN
    RAISE EXCEPTION 'an advance is set against a bill on a day that has come, on or after the payment' USING ERRCODE = 'SE242';
  END IF;
  IF p_allocations IS NULL OR jsonb_typeof(p_allocations) <> 'array' OR jsonb_array_length(p_allocations) NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'name between 1 and 200 bills to set the advance against' USING ERRCODE = 'SE244';
  END IF;
  PERFORM app.require_open_period(v_tenant, p_date);
  SELECT s.name INTO v_supplier FROM public.suppliers s WHERE s.tenant_id = v_tenant AND s.id = v_doc.supplier_id;
  v_left := v_doc.amount - coalesce((SELECT sum(a.amount) FROM public.supplier_payment_allocations a WHERE a.tenant_id = v_tenant AND a.payment_id = v_doc.id), 0);

  SET CONSTRAINTS public.journals_balanced, public.journal_lines_balanced, public.journals_with_document DEFERRED;
  FOR v_line IN
    SELECT (x.value->>'bill_id')::uuid AS bill_id, (x.value->>'amount')::numeric AS amount, b.status AS bill_status, b.supplier_id, b.branch_id, b.bill_date, b.number,
           count(*) OVER (PARTITION BY x.value->>'bill_id') AS times
    FROM jsonb_array_elements(p_allocations) AS x(value)
    LEFT JOIN public.supplier_bills b ON b.tenant_id = v_tenant AND b.id = (x.value->>'bill_id')::uuid
    ORDER BY b.bill_date, b.number
  LOOP
    IF v_line.bill_status IS DISTINCT FROM 'posted' OR v_line.supplier_id <> v_doc.supplier_id OR v_line.branch_id <> v_doc.branch_id OR v_line.bill_date > p_date THEN
      RAISE EXCEPTION 'a payment settles posted bills of its own supplier and branch, dated on or before it' USING ERRCODE = 'SE238';
    END IF;
    IF v_line.times > 1 THEN
      RAISE EXCEPTION 'bill % is named twice', v_line.number USING ERRCODE = 'SE244';
    END IF;
    -- "Not a number" passes "> 0"; the upper bound refuses it. An amount is to the paisa.
    IF v_line.amount IS NULL OR NOT (v_line.amount > 0 AND v_line.amount < 1e16) OR v_line.amount <> round(v_line.amount, 2) THEN
      RAISE EXCEPTION 'an amount set against a bill is more than nothing, to the paisa' USING ERRCODE = 'SE244';
    END IF;
    IF v_line.amount > app.bill_owed(v_tenant, v_line.bill_id) THEN
      RAISE EXCEPTION 'more set against bill % than is still owed on it', v_line.number USING ERRCODE = 'SE239';
    END IF;
    v_total := v_total + v_line.amount;
    IF v_total > v_left THEN
      RAISE EXCEPTION 'more set against bills than is left of the advance: % against %', v_total, v_left USING ERRCODE = 'SE240';
    END IF;
    -- One journal for each bill, which stands with the row written for it.
    v_id := gen_random_uuid();
    INSERT INTO public.journals (tenant_id, journal_date, source_type, source_id, document_number, memo, branch_id, created_by)
      VALUES (v_tenant, p_date, 'supplier_advance_application', v_id, NULL, left('Advance ' || v_doc.number || ' to ' || v_supplier || ' set against ' || v_line.number, 500), v_doc.branch_id, v_user)
      RETURNING id INTO v_journal;
    INSERT INTO public.journal_lines (tenant_id, journal_id, line_no, account_id, debit, credit, description, supplier_id)
      VALUES (v_tenant, v_journal, 1, app.control_account(v_tenant, 'ap'), v_line.amount, 0, 'Advance set against ' || v_line.number, v_doc.supplier_id),
             (v_tenant, v_journal, 2, app.control_account(v_tenant, 'supplier_advances'), 0, v_line.amount, 'Advance ' || v_doc.number || ' set against ' || v_line.number, v_doc.supplier_id);
    INSERT INTO public.audit_log (tenant_id, actor_user_id, actor_role, action, entity, entity_id, after)
      VALUES (v_tenant, v_user, v_role, 'journal.post', 'journal', v_journal,
        jsonb_build_object('date', p_date, 'source', 'supplier_advance_application', 'sourceId', v_id, 'number', NULL, 'lines', 2, 'total', v_line.amount::text));
    INSERT INTO public.supplier_payment_allocations (id, tenant_id, payment_id, bill_id, amount, applied_on, journal_id, created_by)
      VALUES (v_id, v_tenant, v_doc.id, v_line.bill_id, v_line.amount, p_date, v_journal, v_user);
    v_lines := v_lines + 1;
  END LOOP;
  INSERT INTO public.audit_log (tenant_id, actor_user_id, actor_role, action, entity, entity_id, after)
    VALUES (v_tenant, v_user, v_role, 'supplier_payment.apply_advance', 'supplier_payment', v_doc.id,
      jsonb_build_object('number', v_doc.number, 'supplier', v_supplier, 'date', p_date, 'amount', v_total::text, 'bills', v_lines, 'left', (v_left - v_total)::text));
  RETURN v_lines;
END $$;

-- The row drizzle-kit wrote for 0033_line_guards (its "when" in drizzle/meta/_journal.json).
DELETE FROM drizzle.__drizzle_migrations WHERE created_at = 1795005633279;

COMMIT;

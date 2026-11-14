-- Reverses drizzle/0024_credit_notes.sql. Never run automatically. Run it by hand, as postgres,
-- only after showing it to the founder and getting a yes. It refuses to run once any credit
-- note has been written: a posted credit note's journal and stock moves cannot be removed, and
-- without this migration nothing would say where they came from or count them against their
-- invoices. It puts back the rules this migration widened, word for word as they were written
-- (the policy and the two guards of drizzle/0018_sales_invoices.sql, and app.receivable_items
-- of drizzle/0022_receipts.sql), with the search path drizzle/0023_safe_search_path.sql gave
-- every function.

BEGIN;

-- Nobody writes a sales document while this runs.
LOCK TABLE public.sales_documents IN ACCESS EXCLUSIVE MODE;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.sales_documents d WHERE d.kind = 'credit_note') THEN
    RAISE EXCEPTION 'credit notes exist; this migration can no longer be reversed';
  END IF;
END $$;

DROP TRIGGER opening_entries_credit_allocated ON public.opening_entries;
DROP FUNCTION app.check_opening_not_credited();
DROP FUNCTION app.credit_note_settled(uuid);
DROP FUNCTION app.apply_credit_note(uuid, date, jsonb);
DROP FUNCTION app.post_credit_note(uuid);
DROP FUNCTION app.credit_note_share(numeric, numeric, numeric, numeric);
DROP FUNCTION app.audit_reserved_credit_note(text);
DROP FUNCTION app.journal_backed_credit_application(public.journals);
DROP FUNCTION app.journal_backed_credit_note(public.journals);

-- What is still unpaid on an invoice, as drizzle/0022_receipts.sql had it.
CREATE OR REPLACE FUNCTION app.receivable_items(p_tenant uuid, p_customer uuid)
  RETURNS TABLE (kind text, id uuid, number text, document_date date, due_date date, branch_id uuid, total numeric, settled numeric)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
  AS $$
    SELECT 'invoice'::text, d.id, d.number, d.document_date, coalesce(d.due_date, d.document_date), d.branch_id, d.total,
      coalesce((
        SELECT sum(a.amount) FROM public.receipt_allocations a
        WHERE a.tenant_id = d.tenant_id AND a.invoice_id = d.id AND a.posted_at IS NOT NULL AND a.voided_at IS NULL), 0)
    FROM public.sales_documents d
    WHERE d.tenant_id = p_tenant AND d.customer_id = p_customer AND d.kind = 'invoice' AND d.status = 'submitted'
    UNION ALL
    SELECT 'opening'::text, b.id, b.document_number, b.document_date, coalesce(b.due_date, b.document_date), NULL::uuid, b.debit,
      coalesce((
        SELECT sum(a.amount) FROM public.receipt_allocations a
        WHERE a.tenant_id = b.tenant_id AND a.opening_balance_id = b.id AND a.posted_at IS NOT NULL AND a.voided_at IS NULL), 0)
    FROM public.opening_balances b
    JOIN public.opening_entries e ON e.tenant_id = b.tenant_id AND e.id = b.opening_entry_id
    WHERE b.tenant_id = p_tenant AND b.customer_id = p_customer AND b.kind = 'receivable' AND e.status = 'posted'
  $$;

-- Who may start a sales document, as drizzle/0018_sales_invoices.sql had it.
DROP POLICY sales_documents_insert ON public.sales_documents;
CREATE POLICY sales_documents_insert ON public.sales_documents FOR INSERT TO app_runtime
  WITH CHECK (
    tenant_id = (SELECT app.tenant_id())
    AND ((SELECT app.tenant_role()) IN ('owner', 'accountant', 'sales_manager', 'salesperson') OR ((SELECT app.tenant_role()) = 'warehouse_manager' AND kind = 'delivery'))
    AND ((SELECT app.tenant_branch_ids()) IS NULL OR branch_id = ANY ((SELECT app.tenant_branch_ids())::uuid[]))
    AND kind IN ('quotation', 'order', 'delivery', 'invoice')
    AND status = 'draft'
    AND created_by = (SELECT app.current_user_id())
    AND updated_by = (SELECT app.current_user_id())
  );

-- The guards of a sales document and of its lines, as drizzle/0018_sales_invoices.sql had them.
CREATE OR REPLACE FUNCTION app.check_sales_document() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_me uuid := app.current_user_id();
  v_role public.member_role := app.tenant_role();
  v_scope uuid[] := app.tenant_branch_ids();
  v_filed uuid;
  v_branch uuid;
  v_base text;
  v_registered boolean;
  v_inclusive boolean;
  v_lines integer;
  v_gross numeric;
  v_discount numeric;
  v_value numeric;
  v_tax numeric;
  v_further numeric;
  v_extra numeric;
  v_total numeric;
  v_limit numeric;
  v_receivable numeric;
  v_orders numeric;
  v_over boolean := false;
  v_customer public.customers%ROWTYPE;
  v_address text;
  v_changes jsonb;
  v_what jsonb;
  -- What submitting, holding and cancelling may change; everything else stays as it stood.
  v_moves text[] := ARRAY['status', 'number', 'submitted_at', 'submitted_by',
    'buyer_name', 'buyer_ntn', 'buyer_cnic', 'buyer_strn', 'buyer_registration_type', 'buyer_atl_status', 'buyer_province', 'buyer_address',
    'credit_limit', 'credit_exposure', 'credit_override_reason', 'credit_override_by', 'held_at', 'held_by',
    'cancelled_at', 'cancelled_by', 'cancel_reason', 'updated_at', 'updated_by', 'posted_txid'];
BEGIN
  IF session_user = 'postgres' THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;
  -- Every check below reads what is committed now. A transaction that reads an older picture
  -- of the database could slip a line or a second order past them, so it is not let in.
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'sales documents are written in read committed transactions' USING ERRCODE = 'SE056';
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF OLD.tenant_id IS DISTINCT FROM app.tenant_id() THEN
      RAISE EXCEPTION 'not a member of this company' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NOT app.writes_sales_document(v_role, v_scope, v_me, OLD.branch_id, OLD.created_by, OLD.salesperson_id, OLD.kind) THEN
      RAISE EXCEPTION 'not a sales document this member may write' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF OLD.status <> 'draft' THEN
      RAISE EXCEPTION 'only a draft is thrown away; a submitted document is cancelled' USING ERRCODE = 'SE050';
    END IF;
    RETURN OLD;
  END IF;
  IF NEW.tenant_id IS DISTINCT FROM app.tenant_id() THEN
    RAISE EXCEPTION 'not a member of this company' USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- Who may write the row is asked here as well as by the policies, for this row and at this
  -- moment: the policies read the company and the role once per statement, each on its own.
  IF NEW.updated_by IS DISTINCT FROM v_me
     OR NOT app.writes_sales_document(v_role, v_scope, v_me, NEW.branch_id, NEW.created_by, NEW.salesperson_id, NEW.kind)
     OR (TG_OP = 'UPDATE' AND NOT app.writes_sales_document(v_role, v_scope, v_me, OLD.branch_id, OLD.created_by, OLD.salesperson_id, OLD.kind))
     OR (TG_OP = 'INSERT' AND NEW.created_by IS DISTINCT FROM v_me) THEN
    RAISE EXCEPTION 'not a sales document this member may write' USING ERRCODE = 'insufficient_privilege';
  END IF;
  NEW.updated_at := now();
  SELECT w.branch_id INTO v_branch FROM public.warehouses w WHERE w.tenant_id = NEW.tenant_id AND w.id = NEW.warehouse_id;
  IF FOUND AND v_branch IS DISTINCT FROM NEW.branch_id THEN
    RAISE EXCEPTION 'a document belongs to the branch of its warehouse' USING ERRCODE = 'SE052';
  END IF;
  -- Until foreign-currency sales exist, every document is in the base currency at a rate of one.
  -- A rate left free would let an order weigh next to nothing against the credit limit.
  SELECT c.code INTO v_base FROM public.currencies c WHERE c.tenant_id = NEW.tenant_id AND c.is_base;
  IF NEW.currency IS DISTINCT FROM v_base OR NEW.exchange_rate <> 1 THEN
    RAISE EXCEPTION 'a sales document is in the company''s base currency' USING ERRCODE = 'SE052';
  END IF;
  -- A delivery note is made from one sales order: for its customer, from its warehouse. Nothing
  -- else has a source yet.
  IF NEW.kind = 'delivery' THEN
    -- The order must be one the writer may see: a salesperson delivers their own orders, not a
    -- colleague's. The note is filed under whoever the order is filed under, or failing that
    -- whoever wrote it, so the people who see the order see its delivery notes.
    SELECT coalesce(o.salesperson_id, o.created_by) INTO v_filed FROM public.sales_documents o
      WHERE o.tenant_id = NEW.tenant_id AND o.id = NEW.source_document_id AND o.kind = 'order'
        AND o.customer_id = NEW.customer_id AND o.warehouse_id = NEW.warehouse_id
        AND (TG_OP <> 'INSERT' OR o.status = 'submitted')
        AND (v_role <> 'salesperson' OR o.created_by = v_me OR o.salesperson_id IS NOT DISTINCT FROM v_me);
    IF NOT FOUND THEN
      RAISE EXCEPTION 'a delivery note is made from a submitted sales order, for its customer, from its warehouse' USING ERRCODE = 'SE066';
    END IF;
    IF TG_OP = 'INSERT' THEN
      NEW.salesperson_id := v_filed;
    ELSIF OLD.status = 'draft' THEN
      NEW.salesperson_id := v_filed;
    END IF;
  ELSIF NEW.kind = 'invoice' THEN
    -- A sales invoice is made from a posted delivery note, which it bills, or from a sales
    -- order, which it delivers and bills at once: for the same customer, from the same
    -- warehouse, and one the writer may see. It is filed under whoever its source is.
    SELECT coalesce(o.salesperson_id, o.created_by) INTO v_filed FROM public.sales_documents o
      WHERE o.tenant_id = NEW.tenant_id AND o.id = NEW.source_document_id AND o.kind IN ('order', 'delivery')
        AND o.customer_id = NEW.customer_id AND o.warehouse_id = NEW.warehouse_id
        AND (TG_OP <> 'INSERT' OR o.status = 'submitted')
        AND (v_role <> 'salesperson' OR o.created_by = v_me OR o.salesperson_id IS NOT DISTINCT FROM v_me);
    IF NOT FOUND THEN
      RAISE EXCEPTION 'a sales invoice is made from a submitted sales order or a posted delivery note, for its customer, from its warehouse' USING ERRCODE = 'SE066';
    END IF;
    IF TG_OP = 'INSERT' THEN
      NEW.salesperson_id := v_filed;
    ELSIF OLD.status = 'draft' THEN
      NEW.salesperson_id := v_filed;
    END IF;
  ELSIF NEW.source_document_id IS NOT NULL THEN
    RAISE EXCEPTION 'only a delivery note or a sales invoice is made from another document' USING ERRCODE = 'SE052';
  END IF;
  -- The day an invoice falls due is worked out when it is posted, here; until then there is none.
  IF NEW.status IN ('draft', 'on_hold') THEN
    NEW.due_date := NULL;
  END IF;

  IF TG_OP = 'INSERT' THEN
    NEW.created_at := now();
    IF NEW.status <> 'draft' THEN
      RAISE EXCEPTION 'a document starts as a draft' USING ERRCODE = 'SE050';
    END IF;
    IF NEW.kind NOT IN ('quotation', 'order', 'delivery', 'invoice') THEN
      RAISE EXCEPTION 'that kind of sales document cannot be written yet' USING ERRCODE = 'SE050';
    END IF;
    -- A draft carries nothing that only submitting, approving or FBR may write.
    NEW.credit_limit := NULL;
    NEW.credit_exposure := NULL;
    NEW.credit_override_reason := NULL;
    NEW.credit_override_by := NULL;
    NEW.buyer_address := NULL;
    NEW.fbr_invoice_number := NULL;
    NEW.fbr_submission_id := NULL;
    NEW.fbr_status := NULL;
    NEW.offline_flag := false;
    -- Only the posting functions say a document was posted by them.
    NEW.posted_txid := NULL;
    RETURN NEW;
  END IF;

  IF NEW.kind <> OLD.kind OR NEW.created_by <> OLD.created_by OR NEW.created_at <> OLD.created_at OR NEW.source_document_id IS DISTINCT FROM OLD.source_document_id THEN
    RAISE EXCEPTION 'what a document is, what it was made from and who wrote it never change' USING ERRCODE = 'SE050';
  END IF;
  IF OLD.status = 'draft' AND NEW.status = 'draft' THEN
    NEW.credit_limit := NULL;
    NEW.credit_exposure := NULL;
    NEW.credit_override_reason := NULL;
    NEW.credit_override_by := NULL;
    NEW.buyer_address := NULL;
    RETURN NEW;
  END IF;
  IF OLD.status IN ('submitted', 'cancelled') AND NOT (OLD.status = 'submitted' AND NEW.status = 'cancelled') THEN
    RAISE EXCEPTION 'a submitted document is never changed; cancel it instead' USING ERRCODE = 'SE050';
  END IF;
  IF NOT ((OLD.status = 'draft' AND NEW.status IN ('on_hold', 'submitted')) OR (OLD.status = 'on_hold' AND NEW.status IN ('draft', 'submitted')) OR (OLD.status = 'submitted' AND NEW.status = 'cancelled')) THEN
    RAISE EXCEPTION 'a sales document cannot go from % to %', OLD.status, NEW.status USING ERRCODE = 'SE050';
  END IF;
  -- From here on the document moves on, and moves on as it stands.
  IF (to_jsonb(NEW) - v_moves) IS DISTINCT FROM (to_jsonb(OLD) - v_moves) THEN
    RAISE EXCEPTION 'a document is submitted, held, sent back or cancelled as it stands' USING ERRCODE = 'SE052';
  END IF;

  IF NEW.status = 'draft' THEN
    -- Sent back, or taken back: it is a draft again and can be changed.
    NEW.held_at := NULL;
    NEW.held_by := NULL;
    NEW.credit_limit := NULL;
    NEW.credit_exposure := NULL;
    NEW.credit_override_reason := NULL;
    NEW.credit_override_by := NULL;
    NEW.buyer_address := NULL;
    INSERT INTO public.audit_log (tenant_id, actor_user_id, actor_role, action, entity, entity_id, before, after)
      VALUES (NEW.tenant_id, v_me, v_role, 'sales_order.release', 'sales_document', NEW.id, jsonb_build_object('status', 'on_hold'), jsonb_build_object('status', 'draft'));
    RETURN NEW;
  END IF;

  IF NEW.status = 'cancelled' THEN
    IF NEW.cancelled_by IS DISTINCT FROM v_me THEN
      RAISE EXCEPTION 'a document is cancelled in the name of whoever cancels it' USING ERRCODE = 'SE052';
    END IF;
    IF (to_jsonb(NEW) - ARRAY['status', 'cancelled_at', 'cancelled_by', 'cancel_reason', 'updated_at', 'updated_by']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status', 'cancelled_at', 'cancelled_by', 'cancel_reason', 'updated_at', 'updated_by']) THEN
      RAISE EXCEPTION 'a submitted document is never changed; cancel it instead' USING ERRCODE = 'SE050';
    END IF;
    -- Goods that have left against an order keep the order alive: the delivery notes are cancelled first.
    IF OLD.kind = 'order' AND EXISTS (
      SELECT 1 FROM public.sales_documents d
      WHERE d.tenant_id = OLD.tenant_id AND d.source_document_id = OLD.id AND d.kind IN ('delivery', 'invoice') AND d.status = 'submitted'
    ) THEN
      RAISE EXCEPTION 'an order with goods delivered or invoiced is not cancelled' USING ERRCODE = 'SE065';
    END IF;
    -- A delivery note that has been billed stays: the invoice says what it delivered.
    IF OLD.kind = 'delivery' AND EXISTS (
      SELECT 1 FROM public.sales_documents i
      WHERE i.tenant_id = OLD.tenant_id AND i.source_document_id = OLD.id AND i.kind = 'invoice' AND i.status = 'submitted'
    ) THEN
      RAISE EXCEPTION 'a delivery note that has been invoiced is not cancelled' USING ERRCODE = 'SE073';
    END IF;
    -- A posted invoice is in the books and with the customer: it is corrected by a credit note.
    IF OLD.kind = 'invoice' THEN
      RAISE EXCEPTION 'a posted sales invoice is not cancelled; it is corrected by a credit note' USING ERRCODE = 'SE072';
    END IF;
    NEW.cancelled_at := now();
    NEW.cancel_reason := btrim(NEW.cancel_reason);
    INSERT INTO public.audit_log (tenant_id, actor_user_id, actor_role, action, entity, entity_id, before, after)
      VALUES (NEW.tenant_id, v_me, v_role, 'sales_' || NEW.kind || '.cancel', 'sales_document', NEW.id,
        jsonb_build_object('number', OLD.number, 'status', 'submitted'), jsonb_build_object('number', OLD.number, 'status', 'cancelled', 'reason', NEW.cancel_reason));
    RETURN NEW;
  END IF;

  -- Held or submitted: the document must be whole.
  SELECT count(*), coalesce(sum(round(l.quantity * l.unit_price, 2)), 0), coalesce(sum(l.discount_amount), 0), coalesce(sum(l.value), 0),
         coalesce(sum(l.tax_amount), 0), coalesce(sum(l.further_tax_amount), 0), coalesce(sum(l.extra_tax_amount), 0), coalesce(sum(l.total), 0)
    INTO v_lines, v_gross, v_discount, v_value, v_tax, v_further, v_extra, v_total
    FROM public.sales_lines l WHERE l.tenant_id = NEW.tenant_id AND l.document_id = NEW.id;
  IF v_lines = 0 THEN
    RAISE EXCEPTION 'a document needs at least one line' USING ERRCODE = 'SE052';
  END IF;
  IF NEW.gross_total <> v_gross OR NEW.discount_total <> v_discount OR NEW.value_total <> v_value OR NEW.tax_total <> v_tax
     OR NEW.further_tax_total <> v_further OR NEW.extra_tax_total <> v_extra OR NEW.total <> v_total THEN
    RAISE EXCEPTION 'the totals of a document are those of its lines' USING ERRCODE = 'SE052';
  END IF;
  -- Each line is its quantity at its price, less its discount: before tax, or with the tax inside.
  IF EXISTS (
    SELECT 1 FROM public.sales_lines l
    WHERE l.tenant_id = NEW.tenant_id AND l.document_id = NEW.id
      AND (CASE WHEN NEW.prices_include_tax THEN l.total - l.extra_tax_amount ELSE l.value END) <> round(l.quantity * l.unit_price, 2) - l.discount_amount
  ) THEN
    RAISE EXCEPTION 'a line comes to its quantity at its price, less its discount' USING ERRCODE = 'SE052';
  END IF;
  -- Whether the document carries sales tax, and whether its prices hold the tax, is the company's answer, not the writer's.
  SELECT s.sales_tax_registered, s.sales_tax_registered AND s.prices_include_tax INTO v_registered, v_inclusive
    FROM public.company_setup s WHERE s.tenant_id = NEW.tenant_id;
  IF NEW.taxed IS DISTINCT FROM coalesce(v_registered, false) OR NEW.prices_include_tax IS DISTINCT FROM coalesce(v_inclusive, false) THEN
    RAISE EXCEPTION 'a document carries sales tax as the company is registered for it' USING ERRCODE = 'SE052';
  END IF;
  IF NOT NEW.taxed AND EXISTS (
    SELECT 1 FROM public.sales_lines l
    WHERE l.tenant_id = NEW.tenant_id AND l.document_id = NEW.id
      AND (l.tax_amount <> 0 OR l.further_tax_amount <> 0 OR l.extra_tax_amount <> 0 OR l.tax_rate <> 0 OR l.further_tax_rate <> 0 OR l.tax_kind IS NOT NULL)
  ) THEN
    RAISE EXCEPTION 'a document without sales tax has no tax on its lines' USING ERRCODE = 'SE052';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.sales_line_salespeople s
    WHERE s.tenant_id = NEW.tenant_id AND s.document_id = NEW.id
    GROUP BY s.line_id HAVING sum(s.share_percent) <> 100
  ) OR (NEW.kind <> 'invoice' AND EXISTS (
    SELECT 1 FROM public.sales_line_salespeople s
    WHERE s.tenant_id = NEW.tenant_id AND s.document_id = NEW.id
      AND NOT EXISTS (SELECT 1 FROM public.memberships m WHERE m.tenant_id = s.tenant_id AND m.user_id = s.user_id AND m.active AND m.role IN ('owner', 'sales_manager', 'salesperson'))
  )) THEN
    RAISE EXCEPTION 'the salespeople''s shares of a line come to 100, among active members of the sales team' USING ERRCODE = 'SE052';
  END IF;
  IF NEW.kind = 'delivery' AND NOT EXISTS (
    SELECT 1 FROM public.sales_documents o
    WHERE o.tenant_id = NEW.tenant_id AND o.id = NEW.source_document_id AND o.kind = 'order' AND o.status = 'submitted' AND o.document_date <= NEW.document_date
  ) THEN
    RAISE EXCEPTION 'a delivery note is posted against a submitted sales order, on or after its date' USING ERRCODE = 'SE066';
  END IF;
  IF NEW.kind = 'invoice' AND NOT EXISTS (
    SELECT 1 FROM public.sales_documents o
    WHERE o.tenant_id = NEW.tenant_id AND o.id = NEW.source_document_id AND o.kind IN ('order', 'delivery') AND o.status = 'submitted' AND o.document_date <= NEW.document_date
  ) THEN
    RAISE EXCEPTION 'a sales invoice is posted against a submitted sales order or a posted delivery note, on or after its date' USING ERRCODE = 'SE066';
  END IF;
  SELECT c.* INTO v_customer FROM public.customers c WHERE c.tenant_id = NEW.tenant_id AND c.id = NEW.customer_id;
  -- Goods already delivered are billed even if the customer has been archived since.
  IF v_customer.archived_at IS NOT NULL AND NOT (NEW.kind = 'invoice' AND EXISTS (
    SELECT 1 FROM public.sales_documents o WHERE o.tenant_id = NEW.tenant_id AND o.id = NEW.source_document_id AND o.kind = 'delivery'
  )) THEN
    RAISE EXCEPTION 'the customer is archived' USING ERRCODE = 'SE052';
  END IF;

  IF NEW.kind = 'order' THEN
    -- One order at a time per customer, so two cannot both fit under the same limit.
    PERFORM pg_advisory_xact_lock(hashtextextended('credit:' || NEW.tenant_id::text || ':' || NEW.customer_id::text, 0));
    SELECT k.credit_limit, k.receivable, k.open_orders INTO v_limit, v_receivable, v_orders FROM app.customer_credit(NEW.customer_id, NEW.id) k;
    v_over := v_limit IS NOT NULL AND v_receivable + v_orders + NEW.total > v_limit;
  END IF;
  v_what := jsonb_build_object('kind', NEW.kind, 'customer', v_customer.name, 'date', NEW.document_date, 'lines', v_lines, 'total', NEW.total::text);

  IF NEW.status = 'on_hold' THEN
    IF NOT v_over THEN
      RAISE EXCEPTION 'only an order over its customer''s credit limit waits for approval' USING ERRCODE = 'SE054';
    END IF;
    IF NEW.held_by IS DISTINCT FROM v_me THEN
      RAISE EXCEPTION 'an order is held in the name of whoever holds it' USING ERRCODE = 'SE052';
    END IF;
    NEW.held_at := now();
    NEW.credit_limit := NULL;
    NEW.credit_exposure := NULL;
    NEW.credit_override_reason := NULL;
    NEW.credit_override_by := NULL;
    INSERT INTO public.audit_log (tenant_id, actor_user_id, actor_role, action, entity, entity_id, after)
      VALUES (NEW.tenant_id, v_me, v_role, 'sales_order.hold', 'sales_document', NEW.id,
        v_what || jsonb_build_object('creditLimit', v_limit::text, 'owed', v_receivable::text, 'otherOrders', v_orders::text));
    RETURN NEW;
  END IF;

  -- Submitted. Who submitted it, when, to whom and under what number are the database's own answers.
  IF NEW.submitted_by IS DISTINCT FROM v_me THEN
    RAISE EXCEPTION 'a document is submitted in the name of whoever submits it' USING ERRCODE = 'SE052';
  END IF;
  SELECT nullif(concat_ws(', ', a.line, a.city), '') INTO v_address FROM public.party_addresses a
    WHERE a.tenant_id = NEW.tenant_id AND a.customer_id = NEW.customer_id AND a.is_primary;
  NEW.buyer_name := v_customer.name;
  NEW.buyer_ntn := v_customer.ntn;
  NEW.buyer_cnic := v_customer.cnic;
  NEW.buyer_strn := v_customer.strn;
  NEW.buyer_registration_type := v_customer.registration_type::text;
  NEW.buyer_atl_status := v_customer.atl_status::text;
  NEW.buyer_province := v_customer.province::text;
  NEW.buyer_address := v_address;
  NEW.submitted_at := now();
  NEW.held_at := NULL;
  NEW.held_by := NULL;
  -- An invoice falls due after the customer's credit days, counted from its own date.
  IF NEW.kind = 'invoice' THEN
    NEW.due_date := NEW.document_date + coalesce(v_customer.credit_days, 0);
  END IF;
  IF NEW.kind = 'order' THEN
    NEW.credit_limit := v_limit;
    NEW.credit_exposure := v_receivable + v_orders;
  ELSE
    NEW.credit_limit := NULL;
    NEW.credit_exposure := NULL;
  END IF;
  IF v_over THEN
    IF v_role IS DISTINCT FROM 'owner' THEN
      RAISE EXCEPTION 'the order takes the customer over the credit limit; only an owner approves it' USING ERRCODE = 'SE051';
    END IF;
    IF NEW.credit_override_reason IS NULL THEN
      RAISE EXCEPTION 'an order over the credit limit is approved with a reason' USING ERRCODE = 'SE053';
    END IF;
    NEW.credit_override_reason := btrim(NEW.credit_override_reason);
    NEW.credit_override_by := v_me;
    INSERT INTO public.audit_log (tenant_id, actor_user_id, actor_role, action, entity, entity_id, before, after)
      VALUES (NEW.tenant_id, v_me, v_role, 'sales_order.credit_override', 'sales_document', NEW.id,
        jsonb_build_object('creditLimit', v_limit::text, 'owed', v_receivable::text, 'otherOrders', v_orders::text),
        jsonb_build_object('orderTotal', NEW.total::text, 'over', (v_receivable + v_orders + NEW.total - v_limit)::text, 'reason', NEW.credit_override_reason));
  ELSE
    NEW.credit_override_reason := NULL;
    NEW.credit_override_by := NULL;
  END IF;
  -- The number comes from the series here and nowhere else, so it cannot be invented, and a
  -- date with no open fiscal period is refused (SE001, SE002).
  NEW.number := app.next_document_number(CASE NEW.kind WHEN 'quotation' THEN 'QT' WHEN 'order' THEN 'SO' WHEN 'delivery' THEN 'DN' WHEN 'invoice' THEN 'SI' ELSE '??' END, NEW.document_date);
  -- Every line sold at a price that is not the price lists', or with a discount, is named in the log.
  SELECT jsonb_agg(jsonb_build_object('item', l.description, 'list', l.list_price::text, 'charged', l.unit_price::text,
           'discount', CASE WHEN l.discount_percent IS NOT NULL THEN trim_scale(l.discount_percent)::text || '%' WHEN l.discount_amount <> 0 THEN l.discount_amount::text END) ORDER BY l.line_no)
    INTO v_changes
    FROM public.sales_lines l
    WHERE l.tenant_id = NEW.tenant_id AND l.document_id = NEW.id AND (l.discount_percent IS NOT NULL OR l.discount_amount <> 0 OR l.list_price IS DISTINCT FROM l.unit_price);
  INSERT INTO public.audit_log (tenant_id, actor_user_id, actor_role, action, entity, entity_id, after)
    VALUES (NEW.tenant_id, v_me, v_role, 'sales_' || NEW.kind || '.submit', 'sales_document', NEW.id,
      jsonb_build_object('number', NEW.number) || v_what || CASE WHEN v_changes IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('priceChanges', v_changes) END);
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
  IF FOUND AND NOT app.writes_sales_document(app.tenant_role(), app.tenant_branch_ids(), app.current_user_id(), v_branch, v_created_by, v_salesperson, v_kind) THEN
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
    IF NOT EXISTS (
      SELECT 1 FROM public.items i
      WHERE i.tenant_id = NEW.tenant_id AND i.id = NEW.item_id
        AND ((i.base_unit_id = NEW.unit_id AND NEW.unit_factor = 1)
          OR EXISTS (SELECT 1 FROM public.item_units u WHERE u.tenant_id = i.tenant_id AND u.item_id = i.id AND u.unit_id = NEW.unit_id AND u.factor = NEW.unit_factor))
    ) THEN
      RAISE EXCEPTION 'a line is sold in one of its item''s own units' USING ERRCODE = 'SE052';
    END IF;
    -- A discount is its percentage of the quantity at the price, to the paisa, and nothing else:
    -- an amount typed beside a percentage could make a line bill anything from nil to the full price.
    IF NEW.discount_amount <> (CASE WHEN NEW.discount_percent IS NULL THEN 0 ELSE round(round(NEW.quantity * NEW.unit_price, 2) * NEW.discount_percent / 100, 2) END) THEN
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
    ELSIF NEW.source_line_id IS NOT NULL THEN
      RAISE EXCEPTION 'only a line of a delivery note or a sales invoice follows another line' USING ERRCODE = 'SE052';
    END IF;
  ELSIF TG_TABLE_NAME = 'sales_line_salespeople' THEN
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

DROP TABLE public.credit_note_allocations;
ALTER TABLE public.sales_lines DROP CONSTRAINT sales_lines_damaged_within_quantity;
ALTER TABLE public.sales_lines DROP COLUMN damaged_quantity;
ALTER TABLE public.sales_lines DROP CONSTRAINT sales_lines_returned_cost_sane;
ALTER TABLE public.sales_lines DROP COLUMN returned_cost;

-- The row drizzle-kit wrote for 0024_credit_notes (its "when" in drizzle/meta/_journal.json).
DELETE FROM drizzle.__drizzle_migrations WHERE created_at = 1794693579207;

COMMIT;

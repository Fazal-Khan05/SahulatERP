-- DRAFT of Step 50's migration, not yet numbered (it takes its number after Step 46's is in).
-- track: joint
--
-- What the performance company (scripts/perf) showed. Nothing here changes what any function
-- answers; each is the same question asked in a way the indexes can serve.

-- ── indexes ─────────────────────────────────────────────────────────────────────────────────────
-- Who sold a document's lines was found by reading every line share of the company.
CREATE INDEX sales_line_salespeople_tenant_document_idx ON public.sales_line_salespeople (tenant_id, document_id);
--> statement-breakpoint
-- What an invoice's goods cost is asked by the line they left stock for.
CREATE INDEX stock_moves_tenant_source_line_idx ON public.stock_moves (tenant_id, source_line_id) WHERE source_line_id IS NOT NULL;
--> statement-breakpoint
-- What came back in a month, for a seller's sales of the month (app.commission_month_sales below):
-- the few movements that are not a line's first, and change what was sold.
CREATE INDEX commission_movements_returns_idx ON public.commission_movements (tenant_id, movement_date) WHERE type <> 'accrued' AND base <> 0;
--> statement-breakpoint

-- ── what a salesperson has sold in a month ──────────────────────────────────────────────────────
-- app.commission_month_sales of drizzle/0027_commission_ledger.sql, answering the same. It is
-- asked for every line of every invoice as the invoice is posted, inside the turn the invoice
-- takes for its number, and it read every commission movement of the company dated in the
-- month: at 60,000 invoices that was a quarter of a second a line, and nobody else in the
-- company could post until it was done.
--
-- The same sum in two parts, each by index. A movement dated in the month belongs to a line
-- invoiced in the month or in another one:
--   the seller's lines invoiced in the month (commission_accruals_user_idx), and what is dated
--   in the month on each (commission_movements_accrual_idx);
--   what came back in the month (commission_movements_returns_idx) of a line of the seller's
--   invoiced in another month. A line's first movement, 'accrued', is written once, with the
--   line, on the invoice's date (app.commission_after_document), so it is never one of these;
--   and a movement with no base, or none of it, adds nothing.
CREATE OR REPLACE FUNCTION app.commission_month_sales(p_tenant uuid, p_user uuid, p_date date) RETURNS numeric
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
  AS $$
    -- Worked out without a time zone: the month is the calendar's, whatever the session is set to.
    WITH month AS (
      SELECT date_trunc('month', p_date::timestamp)::date AS first_day, (date_trunc('month', p_date::timestamp) + interval '1 month')::date AS next_month
    )
    SELECT greatest(
      coalesce((
        SELECT sum(m.base)
        FROM month, public.commission_accruals a
        JOIN public.commission_movements m ON m.tenant_id = a.tenant_id AND m.accrual_id = a.id
        WHERE a.tenant_id = p_tenant AND a.user_id = p_user AND a.kind = 'own'
          AND a.invoice_date >= month.first_day AND a.invoice_date < month.next_month
          AND m.movement_date >= month.first_day AND m.movement_date < month.next_month), 0)
      + coalesce((
        SELECT sum(m.base)
        FROM month, public.commission_movements m
        JOIN public.commission_accruals a ON a.tenant_id = m.tenant_id AND a.id = m.accrual_id
        WHERE m.tenant_id = p_tenant AND m.type <> 'accrued' AND m.base <> 0
          AND m.movement_date >= month.first_day AND m.movement_date < month.next_month
          AND a.user_id = p_user AND a.kind = 'own'
          AND NOT (a.invoice_date >= month.first_day AND a.invoice_date < month.next_month)), 0),
      0)
  $$;
--> statement-breakpoint

-- ── how far an order has gone ───────────────────────────────────────────────────────────────────
-- app.order_progress of drizzle/0018_sales_invoices.sql, answering the same. What was invoiced
-- was asked as "lines made from this order line, OR from one of its delivery note lines", and an
-- OR like that reads every invoice line of the company for each line of the order. An invoice
-- line is made from one or the other, never both, so the two are added up apart, each by index.
CREATE OR REPLACE FUNCTION app.order_progress(p_order uuid) RETURNS TABLE (line_id uuid, delivered numeric, delivered_base numeric, invoiced numeric)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_tenant uuid := app.tenant_id();
  v_user uuid := app.current_user_id();
  v_role public.member_role := app.tenant_role();
  v_scope uuid[] := app.tenant_branch_ids();
BEGIN
  IF v_tenant IS NULL OR v_role IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.sales_documents o
    WHERE o.tenant_id = v_tenant AND o.id = p_order AND o.kind = 'order'
      AND (v_role IN ('owner', 'accountant', 'auditor', 'sales_manager', 'salesperson') OR (v_role = 'warehouse_manager' AND o.status = 'submitted'))
      AND (v_role <> 'salesperson' OR o.created_by = v_user OR o.salesperson_id IS NOT DISTINCT FROM v_user)
      AND (v_scope IS NULL OR o.branch_id = ANY (v_scope))
  ) THEN
    RETURN;
  END IF;
  RETURN QUERY
    SELECT ol.id,
      coalesce(gone.quantity, 0), coalesce(gone.base_quantity, 0),
      coalesce(direct.quantity, 0) + coalesce(noted.quantity, 0)
    FROM public.sales_lines ol
    LEFT JOIN LATERAL (
      SELECT sum(l.quantity) AS quantity, sum(l.base_quantity) AS base_quantity
      FROM public.sales_lines l
      JOIN public.sales_documents d ON d.tenant_id = l.tenant_id AND d.id = l.document_id
      WHERE l.tenant_id = v_tenant AND l.source_line_id = ol.id AND d.kind IN ('delivery', 'invoice') AND d.status = 'submitted'
    ) gone ON true
    -- Invoiced straight from the order line.
    LEFT JOIN LATERAL (
      SELECT sum(l.quantity) AS quantity
      FROM public.sales_lines l
      JOIN public.sales_documents d ON d.tenant_id = l.tenant_id AND d.id = l.document_id
      WHERE l.tenant_id = v_tenant AND l.source_line_id = ol.id AND d.kind = 'invoice' AND d.status = 'submitted'
    ) direct ON true
    -- Invoiced from a delivery note line of the order line.
    LEFT JOIN LATERAL (
      SELECT sum(l.quantity) AS quantity
      FROM public.sales_lines dl
      JOIN public.sales_documents dd ON dd.tenant_id = dl.tenant_id AND dd.id = dl.document_id
      JOIN public.sales_lines l ON l.tenant_id = dl.tenant_id AND l.source_line_id = dl.id
      JOIN public.sales_documents d ON d.tenant_id = l.tenant_id AND d.id = l.document_id
      WHERE dl.tenant_id = v_tenant AND dl.source_line_id = ol.id AND dd.kind = 'delivery' AND d.kind = 'invoice' AND d.status = 'submitted'
    ) noted ON true
    WHERE ol.tenant_id = v_tenant AND ol.document_id = p_order;
END $$;
--> statement-breakpoint

-- ── what a customer owes ────────────────────────────────────────────────────────────────────────
-- app.customer_credit of drizzle/0018_sales_invoices.sql, answering the same. "Orders already
-- submitted" took from each order the invoices "made from it, OR from one of its delivery
-- notes": the same OR, reading every invoice of the company for each order of the customer.
CREATE OR REPLACE FUNCTION app.customer_credit(p_customer uuid, p_except uuid DEFAULT NULL)
  RETURNS TABLE (credit_limit numeric, receivable numeric, open_orders numeric)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_tenant uuid := app.tenant_id();
  v_role public.member_role := app.tenant_role();
BEGIN
  IF v_tenant IS NULL OR v_role IS NULL OR v_role NOT IN ('owner', 'accountant', 'auditor', 'sales_manager', 'salesperson', 'recovery_officer') THEN
    RAISE EXCEPTION 'not allowed to see what a customer owes' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN QUERY
    SELECT
      c.credit_limit,
      round(coalesce((
        SELECT sum(l.debit - l.credit)
        FROM public.journal_lines l
        JOIN public.accounts a ON a.tenant_id = l.tenant_id AND a.id = l.account_id
        WHERE l.tenant_id = v_tenant AND l.customer_id = c.id AND a.is_control AND a.control_type IN ('ar', 'customer_advances')
      ), 0), 4),
      round(coalesce((
        SELECT sum(greatest(o.total - coalesce(direct.total, 0) - coalesce(noted.total, 0), 0))
        FROM public.sales_documents o
        -- Invoices made straight from the order.
        LEFT JOIN LATERAL (
          SELECT sum(i.total) AS total FROM public.sales_documents i
          WHERE i.tenant_id = v_tenant AND i.source_document_id = o.id AND i.kind = 'invoice' AND i.status = 'submitted'
        ) direct ON true
        -- Invoices made from the order's delivery notes.
        LEFT JOIN LATERAL (
          SELECT sum(i.total) AS total
          FROM public.sales_documents n
          JOIN public.sales_documents i ON i.tenant_id = n.tenant_id AND i.source_document_id = n.id
          WHERE n.tenant_id = v_tenant AND n.source_document_id = o.id AND n.kind = 'delivery' AND i.kind = 'invoice' AND i.status = 'submitted'
        ) noted ON true
        WHERE o.tenant_id = v_tenant AND o.customer_id = c.id AND o.kind = 'order' AND o.status = 'submitted' AND o.id IS DISTINCT FROM p_except
      ), 0), 4)
    FROM public.customers c
    WHERE c.tenant_id = v_tenant AND c.id = p_customer;
END $$;
--> statement-breakpoint

-- ── orders with something still to deliver ──────────────────────────────────────────────────────
-- The warehouse's list asked app.order_progress once for every line of every order the company
-- ever submitted: three minutes at 5,000 invoices. This answers it in one pass: what has left
-- against each order line is added up once, and set beside the lines. The same orders are shown
-- to the same members as before (the rule of app.order_progress and of the orders' own policy).
CREATE FUNCTION app.orders_to_deliver() RETURNS TABLE (id uuid, number text, document_date date, customer_name text, lines integer)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
  AS $$
#variable_conflict use_column
DECLARE
  v_tenant uuid := app.tenant_id();
  v_user uuid := app.current_user_id();
  v_role public.member_role := app.tenant_role();
  v_scope uuid[] := app.tenant_branch_ids();
BEGIN
  IF v_tenant IS NULL OR v_role IS NULL OR v_role NOT IN ('owner', 'accountant', 'auditor', 'sales_manager', 'salesperson', 'warehouse_manager') THEN
    RETURN;
  END IF;
  RETURN QUERY
    WITH gone AS (
      SELECT l.source_line_id, sum(l.base_quantity) AS base_quantity
      FROM public.sales_lines l
      JOIN public.sales_documents d ON d.tenant_id = l.tenant_id AND d.id = l.document_id
      WHERE l.tenant_id = v_tenant AND l.source_line_id IS NOT NULL AND d.kind IN ('delivery', 'invoice') AND d.status = 'submitted'
      GROUP BY l.source_line_id
    )
    SELECT o.id, o.number, o.document_date, coalesce(o.buyer_name, ''), count(*)::integer
    FROM public.sales_documents o
    JOIN public.sales_lines ol ON ol.tenant_id = o.tenant_id AND ol.document_id = o.id
    LEFT JOIN gone g ON g.source_line_id = ol.id
    WHERE o.tenant_id = v_tenant AND o.kind = 'order' AND o.status = 'submitted'
      AND (v_role <> 'salesperson' OR o.created_by = v_user OR o.salesperson_id IS NOT DISTINCT FROM v_user)
      AND (v_scope IS NULL OR o.branch_id = ANY (v_scope))
      AND ol.base_quantity > coalesce(g.base_quantity, 0)
    GROUP BY o.id, o.number, o.document_date, o.buyer_name, o.created_at
    ORDER BY o.document_date, o.created_at
    LIMIT 200;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.orders_to_deliver() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.orders_to_deliver() TO app_runtime;
--> statement-breakpoint

-- ── what orders still have to deliver, by item ──────────────────────────────────────────────────
-- For the low stock report: of every submitted order the reader may see, how much of each item
-- has not yet left on a posted delivery note or invoice. One pass, like app.orders_to_deliver.
-- The orders are the ones the orders' own policy shows the reader; what has left against them is
-- counted whoever posted it (a warehouse manager, who does not read invoices, used to be shown
-- an order as still open after an invoice had delivered it).
CREATE FUNCTION app.open_order_quantities(p_branch uuid DEFAULT NULL) RETURNS TABLE (item_id uuid, open numeric)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
  AS $$
#variable_conflict use_column
DECLARE
  v_tenant uuid := app.tenant_id();
  v_user uuid := app.current_user_id();
  v_role public.member_role := app.tenant_role();
  v_scope uuid[] := app.tenant_branch_ids();
BEGIN
  IF v_tenant IS NULL OR v_role IS NULL OR v_role NOT IN ('owner', 'accountant', 'auditor', 'sales_manager', 'salesperson', 'warehouse_manager') THEN
    RETURN;
  END IF;
  RETURN QUERY
    WITH gone AS (
      SELECT l.source_line_id, sum(l.base_quantity) AS base_quantity
      FROM public.sales_lines l
      JOIN public.sales_documents d ON d.tenant_id = l.tenant_id AND d.id = l.document_id
      WHERE l.tenant_id = v_tenant AND l.source_line_id IS NOT NULL AND d.kind IN ('delivery', 'invoice') AND d.status = 'submitted'
      GROUP BY l.source_line_id
    )
    SELECT ol.item_id, sum(greatest(ol.base_quantity - coalesce(g.base_quantity, 0), 0))
    FROM public.sales_documents o
    JOIN public.sales_lines ol ON ol.tenant_id = o.tenant_id AND ol.document_id = o.id
    JOIN public.warehouses w ON w.tenant_id = o.tenant_id AND w.id = o.warehouse_id
    LEFT JOIN gone g ON g.source_line_id = ol.id
    WHERE o.tenant_id = v_tenant AND o.kind = 'order' AND o.status = 'submitted'
      AND (v_role <> 'salesperson' OR o.created_by = v_user OR o.salesperson_id IS NOT DISTINCT FROM v_user)
      AND (v_scope IS NULL OR (o.branch_id = ANY (v_scope) AND w.branch_id = ANY (v_scope)))
      AND (p_branch IS NULL OR w.branch_id = p_branch)
    GROUP BY ol.item_id;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.open_order_quantities(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.open_order_quantities(uuid) TO app_runtime;
--> statement-breakpoint

-- ── what each item sold for and cost, over a period ─────────────────────────────────────────────
-- For the item profit report: by item, the quantity, the sales and the cost of the posted
-- invoices of the period, less the credit notes of the period. What a line's goods cost is what
-- they left stock at: on the invoice itself when it delivered them, or on the delivery note line
-- it bills. That was a look-up in the stock moves for every line sold; here the moves that took
-- goods out are added up once. For those who may see what stock cost, and a member limited to
-- some branches is shown those branches' documents, as the tables' own policies had it.
CREATE FUNCTION app.item_profit(p_from date, p_to date, p_branch uuid DEFAULT NULL)
  RETURNS TABLE (item_id uuid, quantity numeric, sales numeric, cost numeric)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
  AS $$
#variable_conflict use_column
DECLARE
  v_tenant uuid := app.tenant_id();
  v_role public.member_role := app.tenant_role();
  v_scope uuid[] := app.tenant_branch_ids();
BEGIN
  IF v_tenant IS NULL OR v_role IS NULL OR v_role NOT IN ('owner', 'accountant', 'auditor') THEN
    RAISE EXCEPTION 'not allowed to see what stock cost' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN QUERY
    WITH billed AS (
      SELECT s.kind, l.id, l.source_line_id, l.item_id, l.base_quantity, l.value * s.exchange_rate AS sales
      FROM public.sales_documents s
      JOIN public.sales_lines l ON l.tenant_id = s.tenant_id AND l.document_id = s.id
      WHERE s.tenant_id = v_tenant AND s.kind IN ('invoice', 'credit_note') AND s.status = 'submitted'
        AND s.document_date BETWEEN p_from AND p_to
        AND (p_branch IS NULL OR s.branch_id = p_branch)
        AND (v_scope IS NULL OR s.branch_id = ANY (v_scope))
    ),
    left_at AS (
      SELECT m.source_type, m.source_line_id, -sum(m.value) AS cost
      FROM public.stock_moves m
      WHERE m.tenant_id = v_tenant AND m.source_type IN ('sales_invoice', 'delivery_note') AND m.source_line_id IS NOT NULL
      GROUP BY m.source_type, m.source_line_id
    ),
    sold AS (
      SELECT b.item_id, b.base_quantity AS quantity, b.sales, coalesce(own.cost, 0) + coalesce(noted.cost, 0) AS cost
      FROM billed b
      LEFT JOIN left_at own ON own.source_type = 'sales_invoice' AND own.source_line_id = b.id
      LEFT JOIN left_at noted ON noted.source_type = 'delivery_note' AND noted.source_line_id = b.source_line_id
      WHERE b.kind = 'invoice'
      UNION ALL
      -- Credit notes take back their quantity and value, and the cost of the goods that came
      -- back onto the shelf; goods written off as damaged stay a cost.
      SELECT b.item_id, -b.base_quantity, -b.sales, -coalesce(cc.cost - cc.written_off, 0)
      FROM billed b
      LEFT JOIN public.credit_note_line_costs cc ON cc.tenant_id = v_tenant AND cc.line_id = b.id
      WHERE b.kind = 'credit_note'
    )
    SELECT s.item_id, sum(s.quantity), sum(s.sales), sum(s.cost) FROM sold s GROUP BY s.item_id;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.item_profit(date, date, uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.item_profit(date, date, uuid) TO app_runtime;
--> statement-breakpoint

-- ── what every customer still has to pay ────────────────────────────────────────────────────────
-- For the aged receivables report and the overdue list: app.receivables_open of
-- drizzle/0022_receipts.sql for every customer at once. That one was asked customer by
-- customer, and each asking looked up what settled each of the customer's invoices one at a
-- time. Here what receipts and credit notes have settled is added up once and set beside the
-- invoices and the opening balances. The same members are answered, with the same limit to a
-- member's branches (and so, for such a member, no opening balances).
CREATE FUNCTION app.receivables_open_all()
  RETURNS TABLE (customer_id uuid, kind text, id uuid, number text, document_date date, due_date date, total numeric, settled numeric, outstanding numeric)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
  AS $$
#variable_conflict use_column
DECLARE
  v_tenant uuid := app.tenant_id();
  v_role public.member_role := app.tenant_role();
  v_scope uuid[] := app.tenant_branch_ids();
BEGIN
  IF v_tenant IS NULL OR v_role IS NULL OR v_role NOT IN ('owner', 'accountant', 'auditor', 'recovery_officer', 'sales_manager') THEN
    RAISE EXCEPTION 'not allowed to see what a customer has to pay' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN QUERY
    WITH paid AS (
      SELECT a.invoice_id, a.opening_balance_id, sum(a.amount) AS amount
      FROM public.receipt_allocations a
      WHERE a.tenant_id = v_tenant AND a.posted_at IS NOT NULL AND a.voided_at IS NULL
      GROUP BY a.invoice_id, a.opening_balance_id
    ),
    credited AS (
      SELECT c.invoice_id, c.opening_balance_id, sum(c.amount) AS amount
      FROM public.credit_note_allocations c
      WHERE c.tenant_id = v_tenant
      GROUP BY c.invoice_id, c.opening_balance_id
    ),
    items AS (
      SELECT d.customer_id, 'invoice'::text AS kind, d.id, d.number, d.document_date, coalesce(d.due_date, d.document_date) AS due_date, d.branch_id, d.total,
        coalesce(p.amount, 0) + coalesce(c.amount, 0) AS settled
      FROM public.sales_documents d
      LEFT JOIN paid p ON p.invoice_id = d.id
      LEFT JOIN credited c ON c.invoice_id = d.id
      WHERE d.tenant_id = v_tenant AND d.kind = 'invoice' AND d.status = 'submitted'
      UNION ALL
      SELECT b.customer_id, 'opening'::text, b.id, b.document_number, b.document_date, coalesce(b.due_date, b.document_date), NULL::uuid, b.debit,
        coalesce(p.amount, 0) + coalesce(c.amount, 0)
      FROM public.opening_balances b
      JOIN public.opening_entries e ON e.tenant_id = b.tenant_id AND e.id = b.opening_entry_id
      LEFT JOIN paid p ON p.opening_balance_id = b.id
      LEFT JOIN credited c ON c.opening_balance_id = b.id
      WHERE b.tenant_id = v_tenant AND b.customer_id IS NOT NULL AND b.kind = 'receivable' AND e.status = 'posted'
    )
    SELECT i.customer_id, i.kind, i.id, i.number, i.document_date, i.due_date, i.total, i.settled, i.total - i.settled
    FROM items i
    WHERE i.total > i.settled AND (v_scope IS NULL OR i.branch_id = ANY (v_scope))
    ORDER BY i.customer_id, i.due_date, i.document_date, i.number;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.receivables_open_all() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.receivables_open_all() TO app_runtime;
--> statement-breakpoint

-- ── the ledger's totals by account ──────────────────────────────────────────────────────────────
-- For the trial balance, the profit and loss, the balance sheet and the owner's figures: for
-- every account, debits less credits before a day, and the debits and the credits from that
-- day to another. Asked through the tables' policies, the journal of every line was looked up
-- one line at a time; here the lines and the journals are read once and matched. The same
-- members are answered (those who read the ledger), and a member limited to some branches is
-- given those branches' lines of those branches' journals, as the policies had it.
--
--   p_before  whose balance before p_from is wanted: NULL for every account, '{}' for none
--             (a report of movements alone), or the kinds of locked account ('cash', 'bank', ...).
CREATE FUNCTION app.ledger_totals(p_from date, p_to date, p_branch uuid DEFAULT NULL, p_before text[] DEFAULT NULL)
  RETURNS TABLE (account_id uuid, before numeric, debit numeric, credit numeric)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
  AS $$
#variable_conflict use_column
DECLARE
  v_tenant uuid := app.tenant_id();
  v_role public.member_role := app.tenant_role();
  v_scope uuid[] := app.tenant_branch_ids();
BEGIN
  IF v_tenant IS NULL OR v_role IS NULL OR v_role NOT IN ('owner', 'accountant', 'auditor') THEN
    RETURN;
  END IF;
  RETURN QUERY
    SELECT l.account_id,
      coalesce(sum(l.debit - l.credit) FILTER (WHERE j.journal_date < p_from), 0),
      coalesce(sum(l.debit) FILTER (WHERE j.journal_date >= p_from), 0),
      coalesce(sum(l.credit) FILTER (WHERE j.journal_date >= p_from), 0)
    FROM public.journal_lines l
    JOIN public.journals j ON j.tenant_id = l.tenant_id AND j.id = l.journal_id
    JOIN public.accounts a ON a.tenant_id = l.tenant_id AND a.id = l.account_id
    WHERE l.tenant_id = v_tenant AND j.journal_date <= p_to
      AND (p_branch IS NULL OR l.branch_id = p_branch)
      AND (v_scope IS NULL OR (l.branch_id = ANY (v_scope) AND j.branch_id = ANY (v_scope)))
      AND (j.journal_date >= p_from OR p_before IS NULL OR a.control_type = ANY (p_before))
    GROUP BY l.account_id;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.ledger_totals(date, date, uuid, text[]) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.ledger_totals(date, date, uuid, text[]) TO app_runtime;

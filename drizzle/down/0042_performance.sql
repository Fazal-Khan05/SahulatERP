-- Reverses drizzle/0042_performance.sql. Never run automatically. Run it by hand, as postgres,
-- only after showing it to the founder and getting a yes. No row of any company changes: it
-- puts three functions back as they were, and removes six functions and three indexes. The app
-- of Step 50 calls the six, so put the earlier app back first, or its lists and reports fail.

BEGIN;
DROP FUNCTION app.goods_received_not_billed();
DROP FUNCTION app.ledger_totals(date, date, uuid, text[]);
DROP FUNCTION app.receivables_open_all();
DROP FUNCTION app.item_profit(date, date, uuid);
DROP FUNCTION app.open_order_quantities(uuid);
DROP FUNCTION app.orders_to_deliver();

-- The three as they stood before (drizzle/0018_sales_invoices.sql, drizzle/0027_commission_ledger.sql).
CREATE OR REPLACE FUNCTION app.order_progress(p_order uuid)
 RETURNS TABLE(line_id uuid, delivered numeric, delivered_base numeric, invoiced numeric)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
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
      coalesce((
        SELECT sum(l.quantity)
        FROM public.sales_lines l
        JOIN public.sales_documents d ON d.tenant_id = l.tenant_id AND d.id = l.document_id
        WHERE l.tenant_id = v_tenant AND d.kind = 'invoice' AND d.status = 'submitted'
          AND (l.source_line_id = ol.id OR l.source_line_id IN (
            SELECT dl.id FROM public.sales_lines dl
            JOIN public.sales_documents dd ON dd.tenant_id = dl.tenant_id AND dd.id = dl.document_id
            WHERE dl.tenant_id = v_tenant AND dl.source_line_id = ol.id AND dd.kind = 'delivery'))
      ), 0)
    FROM public.sales_lines ol
    LEFT JOIN LATERAL (
      SELECT sum(l.quantity) AS quantity, sum(l.base_quantity) AS base_quantity
      FROM public.sales_lines l
      JOIN public.sales_documents d ON d.tenant_id = l.tenant_id AND d.id = l.document_id
      WHERE l.tenant_id = v_tenant AND l.source_line_id = ol.id AND d.kind IN ('delivery', 'invoice') AND d.status = 'submitted'
    ) gone ON true
    WHERE ol.tenant_id = v_tenant AND ol.document_id = p_order;
END $function$
;

CREATE OR REPLACE FUNCTION app.customer_credit(p_customer uuid, p_except uuid DEFAULT NULL::uuid)
 RETURNS TABLE(credit_limit numeric, receivable numeric, open_orders numeric)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
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
        SELECT sum(greatest(o.total - coalesce((
          SELECT sum(i.total) FROM public.sales_documents i
          WHERE i.tenant_id = v_tenant AND i.kind = 'invoice' AND i.status = 'submitted'
            AND (i.source_document_id = o.id OR i.source_document_id IN (
              SELECT n.id FROM public.sales_documents n WHERE n.tenant_id = v_tenant AND n.kind = 'delivery' AND n.source_document_id = o.id))
        ), 0), 0))
        FROM public.sales_documents o
        WHERE o.tenant_id = v_tenant AND o.customer_id = c.id AND o.kind = 'order' AND o.status = 'submitted' AND o.id IS DISTINCT FROM p_except
      ), 0), 4)
    FROM public.customers c
    WHERE c.tenant_id = v_tenant AND c.id = p_customer;
END $function$
;

CREATE OR REPLACE FUNCTION app.commission_month_sales(p_tenant uuid, p_user uuid, p_date date)
 RETURNS numeric
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
    SELECT greatest(coalesce(sum(m.base), 0), 0)
    FROM public.commission_movements m
    JOIN public.commission_accruals a ON a.tenant_id = m.tenant_id AND a.id = m.accrual_id
    WHERE m.tenant_id = p_tenant AND a.user_id = p_user AND a.kind = 'own'
      -- Worked out without a time zone: the month is the calendar's, whatever the session is set to.
      AND m.movement_date >= date_trunc('month', p_date::timestamp)::date AND m.movement_date < (date_trunc('month', p_date::timestamp) + interval '1 month')::date
  $function$
;

DROP INDEX public.sales_line_salespeople_tenant_document_idx;
DROP INDEX public.stock_moves_tenant_source_line_idx;
DROP INDEX public.commission_movements_returns_idx;
-- The row drizzle-kit wrote for 0042_performance (its "when" in drizzle/meta/_journal.json).
DELETE FROM drizzle.__drizzle_migrations WHERE created_at = 1795528744258;
COMMIT;

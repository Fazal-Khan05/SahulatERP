-- Step 39: commission statements.
-- track: C
--
-- Hand-written; no tables. Reverse with drizzle/down/0028_commission_statements.sql.
--
-- A person's commission statement is their commission movements (Step 38,
-- drizzle/0027_commission_ledger.sql) over a period, with what came before it. It is read
-- through functions of its own for two reasons. A statement names the invoice, the customer and
-- the receipt or credit note behind each movement, which the person may not otherwise read (a
-- salesperson reads no receipts, and only their own invoices). And a manager reads their team's
-- statements (the founder's decision, 2026-11-15), which Step 38's policies do not give them:
-- those stay as they are, so the Commission earned page still shows a manager only their own.
--
-- Who reads whose statement:
--   the owner, an accountant and the auditor, working across the whole company: everyone's;
--   anyone else: their own, and their team's: everyone below them in the sales hierarchy as it
--   stands today, at any depth.
-- A statement covers every branch, as a commission payment does (Step 38): a member who works
-- in some branches only reads their own and their team's, like a salesperson.

-- Whose statements the signed-in member may read: null for everyone's.
CREATE FUNCTION app.commission_statement_people() RETURNS uuid[]
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
  AS $$
    SELECT CASE
      WHEN app.tenant_id() IS NULL OR app.tenant_role() IS NULL OR app.current_user_id() IS NULL THEN ARRAY[]::uuid[]
      WHEN app.tenant_role() IN ('owner', 'accountant', 'auditor') AND app.tenant_branch_ids() IS NULL THEN NULL
      ELSE ARRAY(
        WITH RECURSIVE down (user_id, depth) AS (
          SELECT h.user_id, 1 FROM public.sales_hierarchy h
          WHERE h.tenant_id = app.tenant_id() AND h.manager_user_id = app.current_user_id()
          UNION ALL
          SELECT h.user_id, down.depth + 1 FROM down
          JOIN public.sales_hierarchy h ON h.tenant_id = app.tenant_id() AND h.manager_user_id = down.user_id
          WHERE down.depth < 50
        )
        SELECT app.current_user_id()
        UNION
        SELECT down.user_id FROM down
      )
    END
  $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.commission_statement_people() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.commission_statement_people() TO app_runtime;
--> statement-breakpoint

-- One person's statement: first what their movements came to before the period, one row for
-- each type (seq 0, source 'opening'), then each movement in the period, oldest first, with the
-- invoice, the customer and the number of the receipt, credit note or payment behind it.
CREATE FUNCTION app.commission_statement(p_user uuid, p_from date, p_to date)
  RETURNS TABLE (seq bigint, movement_date date, type text, amount numeric, source_type text, source_id uuid, source_number text,
                 invoice_id uuid, invoice_number text, customer_name text, kind text, seller_user_id uuid, team_rate numeric)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_tenant uuid := app.tenant_id();
  v_people uuid[] := app.commission_statement_people();
BEGIN
  IF v_tenant IS NULL OR p_user IS NULL OR NOT (v_people IS NULL OR p_user = ANY (v_people)) THEN
    RAISE EXCEPTION 'not allowed to see this commission statement' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_from IS NULL OR p_to IS NULL OR NOT isfinite(p_from) OR NOT isfinite(p_to) OR p_from > p_to THEN
    RAISE EXCEPTION 'a period is needed' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  RETURN QUERY
    SELECT 0::bigint, p_from, m.type, sum(m.amount), 'opening'::text, NULL::uuid, NULL::text, NULL::uuid, NULL::text, NULL::text, NULL::text, NULL::uuid, NULL::numeric
    FROM public.commission_movements m
    JOIN public.commission_accruals a ON a.tenant_id = m.tenant_id AND a.id = m.accrual_id
    WHERE m.tenant_id = v_tenant AND a.user_id = p_user AND m.movement_date < p_from
    GROUP BY m.type;
  RETURN QUERY
    SELECT m.seq, m.movement_date, m.type, m.amount, m.source_type, m.source_id,
      CASE m.source_type
        WHEN 'receipt' THEN (SELECT r.number FROM public.receipts r WHERE r.tenant_id = m.tenant_id AND r.id = m.source_id)
        WHEN 'credit_note' THEN (SELECT n.number FROM public.sales_documents n WHERE n.tenant_id = m.tenant_id AND n.id = m.source_id)
        WHEN 'commission_payment' THEN (SELECT p.number FROM public.commission_payments p WHERE p.tenant_id = m.tenant_id AND p.id = m.source_id)
      END,
      a.invoice_id, d.number, d.buyer_name, a.kind, a.seller_user_id, a.team_rate
    FROM public.commission_movements m
    JOIN public.commission_accruals a ON a.tenant_id = m.tenant_id AND a.id = m.accrual_id
    LEFT JOIN public.sales_documents d ON d.tenant_id = a.tenant_id AND d.id = a.invoice_id
    WHERE m.tenant_id = v_tenant AND a.user_id = p_user AND m.movement_date BETWEEN p_from AND p_to
    ORDER BY m.movement_date, m.seq;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.commission_statement(uuid, date, date) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.commission_statement(uuid, date, date) TO app_runtime;
--> statement-breakpoint

-- Everyone's statement for a period in short, for the list of statements: for each person the
-- reader may see, their movements added up by type before the period and in it, with the
-- person's email (a former member's too).
CREATE FUNCTION app.commission_statement_summary(p_from date, p_to date)
  RETURNS TABLE (user_id uuid, email text, part text, type text, amount numeric)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_tenant uuid := app.tenant_id();
  v_people uuid[] := app.commission_statement_people();
BEGIN
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'not allowed to see commission statements' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_from IS NULL OR p_to IS NULL OR NOT isfinite(p_from) OR NOT isfinite(p_to) OR p_from > p_to THEN
    RAISE EXCEPTION 'a period is needed' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  RETURN QUERY
    SELECT a.user_id, ms.email, CASE WHEN m.movement_date < p_from THEN 'opening' ELSE 'period' END, m.type, sum(m.amount)
    FROM public.commission_movements m
    JOIN public.commission_accruals a ON a.tenant_id = m.tenant_id AND a.id = m.accrual_id
    LEFT JOIN public.memberships ms ON ms.tenant_id = a.tenant_id AND ms.user_id = a.user_id
    WHERE m.tenant_id = v_tenant AND m.movement_date <= p_to AND (v_people IS NULL OR a.user_id = ANY (v_people))
    GROUP BY 1, 2, 3, 4;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.commission_statement_summary(date, date) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.commission_statement_summary(date, date) TO app_runtime;

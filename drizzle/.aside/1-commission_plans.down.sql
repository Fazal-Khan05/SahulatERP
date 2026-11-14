-- Reverses drizzle/0025_commission_plans.sql. Never run automatically. This DELETES every
-- company's commission plans and sales hierarchy. Run it by hand, as postgres, only after
-- showing it to the founder and getting a yes, and only while nothing (Step 38) depends on them.

BEGIN;

DROP FUNCTION app.commission_managers(uuid, uuid, date);
DROP FUNCTION app.commission_on_line(uuid, uuid, date, uuid, uuid, numeric, numeric, numeric);
DROP FUNCTION app.commission_slabs(uuid, numeric);
DROP FUNCTION app.commission_plan_for(uuid, uuid, date);
DROP TRIGGER sales_hierarchy_no_cycle ON public.sales_hierarchy;
DROP FUNCTION app.check_sales_hierarchy();
DROP TRIGGER commission_plans_dates ON public.commission_plans;
DROP FUNCTION app.check_commission_plan_dates();
DROP FUNCTION app.guard_commission_setup(uuid);
DROP TABLE public.commission_plan_rates, public.commission_plan_tiers, public.sales_hierarchy, public.commission_plans;

-- The row drizzle-kit wrote for 0025_commission_plans (its "when" in drizzle/meta/_journal.json).
DELETE FROM drizzle.__drizzle_migrations WHERE created_at = 1794694912716;

COMMIT;

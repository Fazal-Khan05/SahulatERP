-- Reverses drizzle/0006_items.sql. Never run automatically. This DELETES every company's items,
-- item categories, units and unit conversions. Run it by hand, as postgres, only after showing
-- it to the founder and getting a yes.

BEGIN;

DROP TABLE public.item_units, public.items, public.item_categories, public.units;
DROP FUNCTION app.refuse_base_unit_conversion();

-- The row drizzle-kit wrote for 0006_items (its "when" in drizzle/meta/_journal.json).
DELETE FROM drizzle.__drizzle_migrations WHERE created_at = 1794515415920;

COMMIT;

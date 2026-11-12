-- Reverses drizzle/0007_prices.sql. Never run automatically. This DELETES every company's price
-- lists and prices, every item's default price, and takes every customer off its price list.
-- Run it by hand, as postgres, only after showing it to the founder and getting a yes.

BEGIN;

ALTER TABLE public.customers DROP CONSTRAINT customers_price_list_fk;
UPDATE public.customers SET price_list_id = NULL WHERE price_list_id IS NOT NULL;
REVOKE UPDATE (price_list_id) ON public.customers FROM app_runtime;
DROP TABLE public.customer_prices, public.item_prices_by_class, public.price_list_items, public.price_lists;
REVOKE UPDATE (default_price) ON public.items FROM app_runtime;
ALTER TABLE public.items DROP COLUMN default_price;

-- The row drizzle-kit wrote for 0007_prices (its "when" in drizzle/meta/_journal.json).
DELETE FROM drizzle.__drizzle_migrations WHERE created_at = 1794518805390;

COMMIT;

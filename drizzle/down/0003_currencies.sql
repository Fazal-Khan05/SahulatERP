-- Reverses drizzle/0003_currencies.sql. Never run automatically. This DELETES every company's
-- currencies and exchange rates. Run it by hand, as postgres, only after showing it to the
-- founder and getting a yes.

BEGIN;

DROP TABLE public.exchange_rates, public.currencies;
DROP FUNCTION app.refuse_base_currency_rate();

-- The row drizzle-kit wrote for 0003_currencies (its "when" in drizzle/meta/_journal.json).
DELETE FROM drizzle.__drizzle_migrations WHERE created_at = 1794484850023;

COMMIT;

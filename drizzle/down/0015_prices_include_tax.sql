-- Reverses drizzle/0015_prices_include_tax.sql. Never run automatically. This DELETES every
-- company's answer to whether its prices include sales tax. Run it by hand, as postgres, only
-- after showing it to the founder and getting a yes.

BEGIN;

ALTER TABLE public.company_setup DROP CONSTRAINT company_setup_tax_in_price_only_when_registered;
ALTER TABLE public.company_setup DROP COLUMN prices_include_tax;

-- The row drizzle-kit wrote for 0015_prices_include_tax (its "when" in drizzle/meta/_journal.json).
DELETE FROM drizzle.__drizzle_migrations WHERE created_at = 1794552237581;

COMMIT;

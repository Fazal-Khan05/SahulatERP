-- Reverses drizzle/0023_recovery.sql. Never run automatically. This DELETES every company's
-- follow-ups and promises to pay. Run it by hand, as postgres, only after showing it to the
-- founder and getting a yes.

BEGIN;

DROP FUNCTION app.customer_statement(uuid, date, date);
DROP FUNCTION app.customer_received(uuid, date, date);
DROP TABLE public.payment_promises, public.customer_follow_ups;

-- The row drizzle-kit wrote for 0023_recovery (its "when" in drizzle/meta/_journal.json).
DELETE FROM drizzle.__drizzle_migrations WHERE created_at = 1794690727220;

COMMIT;

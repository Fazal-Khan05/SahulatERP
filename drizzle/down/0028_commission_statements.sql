-- Reverses drizzle/0028_commission_statements.sql. Never run automatically. Run it by hand, as
-- postgres, only after showing it to the founder and getting a yes. It removes three read
-- functions and nothing else: no data is lost.

BEGIN;
DROP FUNCTION app.commission_statement_summary(date, date);
DROP FUNCTION app.commission_statement(uuid, date, date);
DROP FUNCTION app.commission_statement_people();
DELETE FROM drizzle.__drizzle_migrations WHERE created_at = 1794701555014;
COMMIT;

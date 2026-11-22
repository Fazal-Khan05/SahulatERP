-- Reverses drizzle/0033_bank_reconciliation.sql. Never run automatically. Run it by hand, as
-- postgres, only after showing it to the founder and getting a yes. It DELETES every imported bank
-- statement and every match of every company. Nothing in the books changes: reconciling posts
-- nothing.

BEGIN;
DROP FUNCTION app.audit_reserved_bank_match(text);
DROP FUNCTION app.audit_reserved_bank_statement(text);
DROP FUNCTION app.delete_bank_statement(uuid);
DROP FUNCTION app.unmatch_bank(uuid);
DROP FUNCTION app.match_bank_lines(uuid, uuid[], uuid[], text);
DROP FUNCTION app.import_bank_statement(uuid, text, text, jsonb, numeric, numeric);
DROP FUNCTION app.bank_reconcile_may(uuid);
DROP TABLE public.bank_match_journal_lines, public.bank_statement_lines, public.bank_matches, public.bank_statements;
-- The row drizzle-kit wrote for 0033_bank_reconciliation (its "when" in drizzle/meta/_journal.json).
DELETE FROM drizzle.__drizzle_migrations WHERE created_at = 1795006252797;
COMMIT;

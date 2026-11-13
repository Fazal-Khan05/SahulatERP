-- Reverses drizzle/0012_ledger.sql. Never run automatically. This DELETES every journal of every
-- company: the books themselves. Run it by hand, as postgres, only after showing it to the
-- founder and getting a yes, and never once a real company has posted anything. Reverse the
-- later migrations that post journals first.

BEGIN;

DROP FUNCTION app.reverse_journal(uuid, date, text);
DROP FUNCTION app.post_journal(date, text, uuid, jsonb, text, uuid, text);
DROP FUNCTION app.require_open_period(uuid, date);
DROP FUNCTION app.journal_source_reversal_roles(text);
DROP FUNCTION app.journal_source_blocked_controls(text);
DROP FUNCTION app.journal_source_roles(text);
DROP TABLE public.journal_lines, public.journals;
DROP FUNCTION app.check_journal_balanced();
DROP FUNCTION app.check_journal_line();
DROP FUNCTION app.refuse_ledger_change();

-- The row drizzle-kit wrote for 0012_ledger (its "when" in drizzle/meta/_journal.json).
DELETE FROM drizzle.__drizzle_migrations WHERE created_at = 1794541967603;

COMMIT;

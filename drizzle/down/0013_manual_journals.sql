-- Reverses drizzle/0013_manual_journals.sql. Never run automatically. This DELETES every manual
-- journal document of every company, drafts and posted alike. The journals they posted stay in
-- the ledger, with nothing left to say where they came from. Run it by hand, as postgres, only
-- after showing it to the founder and getting a yes, and never once a real company has posted
-- a manual journal.

-- The tightened app.check_account from this migration is left in place: it only refuses more
-- than the one in drizzle/0011_accounts.sql did.

BEGIN;

DROP TABLE public.manual_journal_lines, public.manual_journals;
DROP FUNCTION app.check_manual_journal_line();
DROP FUNCTION app.check_manual_journal();

-- The row drizzle-kit wrote for 0013_manual_journals (its "when" in drizzle/meta/_journal.json).
DELETE FROM drizzle.__drizzle_migrations WHERE created_at = 1794542414236;

COMMIT;

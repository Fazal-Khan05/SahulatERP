-- Reverses drizzle/0049_money_in_out.sql. Never run automatically. Run it by hand, as postgres, only
-- after showing it to the founder and getting a yes. It refuses once any company has recorded money
-- in or out: the journals those entries posted cannot be removed, and would be left with nothing to
-- say where they came from. Such a database goes forward, not back.

BEGIN;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.money_in_out) THEN
    RAISE EXCEPTION 'money in or out has been recorded: 0049 cannot be reversed on this database';
  END IF;
END $$;
DROP FUNCTION app.audit_reserved_money_in_out(text);
DROP FUNCTION app.document_type_mo();
DROP FUNCTION app.document_type_mi();
DROP FUNCTION app.reversal_backed_money_in_out(public.journals, public.journals);
DROP FUNCTION app.journal_backed_money_in_out(public.journals);
DROP FUNCTION app.cancel_money_in_out(uuid, date, text);
DROP FUNCTION app.record_money_in_out(uuid, text, date, uuid, uuid, numeric, text, text, text);
DROP FUNCTION app.money_in_out_other_account(uuid, uuid, text);
DROP TABLE public.money_in_out;
DELETE FROM drizzle.__drizzle_migrations WHERE created_at = 1795723473145;
COMMIT;

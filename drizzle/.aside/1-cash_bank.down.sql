-- Reverses drizzle/0032_cash_bank.sql. Never run automatically. Run it by hand, as postgres, only
-- after showing it to the founder and getting a yes, and never once a real company has recorded a
-- transfer or an expense. It DELETES every transfer and expense of every company, their lines,
-- the tax withheld from them and every bank account's details. The journals they posted stay
-- where they are (they cannot be removed), with nothing to say where they came from.

BEGIN;
DROP TRIGGER accounts_cash_bank_archive ON public.accounts;
DROP FUNCTION app.check_cash_bank_archive();
DROP FUNCTION app.audit_reserved_expense(text);
DROP FUNCTION app.audit_reserved_cash_transfer(text);
DROP FUNCTION app.document_type_tr();
DROP FUNCTION app.reversal_backed_expense(public.journals, public.journals);
DROP FUNCTION app.journal_backed_expense(public.journals);
DROP FUNCTION app.reversal_backed_cash_transfer(public.journals, public.journals);
DROP FUNCTION app.journal_backed_cash_transfer(public.journals);
DROP FUNCTION app.cancel_expense(uuid, date, text);
DROP FUNCTION app.record_expense(uuid, date, uuid, uuid, text, uuid, text, text, jsonb, text, text);
DROP FUNCTION app.cancel_cash_transfer(uuid, date, text);
DROP FUNCTION app.record_cash_transfer(uuid, uuid, uuid, date, numeric, text, text);
DROP FUNCTION app.cash_bank_may_write(date);
DROP FUNCTION app.cash_bank_reverse(uuid, date, text);
DROP FUNCTION app.cash_bank_reopenable(uuid, uuid);
DROP FUNCTION app.cash_bank_account(uuid, uuid);
DROP TABLE public.expense_withholdings;
DROP TABLE public.expense_lines;
DROP TABLE public.expenses;
DROP TABLE public.cash_transfers;
DROP TABLE public.cash_bank_accounts;
DROP FUNCTION app.check_cash_bank_account();
DELETE FROM drizzle.__drizzle_migrations WHERE created_at = 1794936117470;
COMMIT;

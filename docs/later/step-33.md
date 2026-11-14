# Step 33: recovery

Track A. Waits for Step 32 (receipts).

## Decided by the founder (2026-11-14, asked at the start of Steps 31 and 33)

- **Aged receivables by days past the due date**: not due yet, 1-30, 31-60, 61-90 and over 90
  days overdue.
- **A promise to pay is broken** when less than the promised amount has arrived by the promised
  date. A part payment shows what did arrive.
- **Overdue customers and follow-ups are worked by** the recovery officer, the owner, the
  accountant and the sales manager, for all customers of their branches. Salespeople do not.
- **The customer statement is a running balance** for a chosen period: the opening balance, then
  each invoice, receipt and return with the balance after it, with the open invoices listed
  below.

## What was built

- **Overdue customers** (`/recovery/overdue`; `/recovery` is the owner's and sales manager's
  Collections and opens on it; the recovery officer's Overdue customers): everyone with money past its due date, most overdue first, with
  the oldest days late, what is not yet due, the next follow-up and broken promises.
- **A customer's recovery page** (`/recovery/customers/<id>`): what is owed by band and invoice
  by invoice, promises to pay with whether each was kept, and the follow-up log, with forms to add
  either.
- **Follow-ups and promises** (`/recovery/follow-ups`): who is due a follow-up today, the broken
  promises, and promises still to come.
- **Customer statements** (`/recovery/statements`): a running balance for a period, read from
  the books, with the unpaid invoices below; printed on the letterhead and as a PDF.
- **Aged receivables** (`/recovery/ageing`, and on the Reports page under "Receivables"): not
  due, 1-30, 31-60, 61-90 and over 90 days past due, per customer; Excel, CSV and print.
- Migration `0024_recovery` (track A): the tables `customer_follow_ups` and `payment_promises`
  (logs, written once), and the functions `app.customer_received` and `app.customer_statement`.

**The acceptance test**, "Overdue list matches ageing report", holds by construction: both are
`ageOpenItems` over the same rows of `app.receivables_open` (Step 32). The database test
`src/modules/recovery/recovery.test.ts` also checks them against each other and against the
receivables account in the books; the browser test `e2e/recovery.spec.ts` checks the same amount
on both screens.

## Decided for Fazal, to confirm

- **Emailing a statement waits for the email service**, like the sales documents of Step 23: the
  statement prints and downloads as a PDF, and the page says email is not set up. With no service
  there is nothing to send and nothing to log; the statement's email is built with the service.
- **The statement shows one line per document**, its net effect on what the customer owes:
  money received beyond the invoices (an advance) is part of the receipt's line, and setting an
  advance against invoices later, which changes nothing the customer owes, is left out.
- **Money that arrives counts toward a promise from the day the promise was made** to the day
  promised, whichever invoice it pays; a cheque counts from the day it was received (Step 32's
  rule). A part payment shows what arrived. A newer promise does not replace an older one: each
  is kept or broken on its own.
- **A follow-up is a note and, if agreed, a next date.** The customer's latest follow-up decides
  whether they are due today; a newer note with no next date takes them off the list.
- **Customers belong to the whole company**, so follow-ups and promises do too: a member limited
  to some branches sees every customer's notes, but only their own branches' invoices.

## Review of the migration

An independent reviewer attacked this step's migration (then numbered 0023, now `0024_recovery`) as arbitrary SQL from the app's role
(2026-11-15). Nothing crossed a company, a branch or a role. Fixed in the migration:

- the two functions' search path is `pg_catalog, pg_temp`, not empty (see the critical finding
  below);
- a promise's date and a follow-up's next date are checked against the statement's own clock, so
  a transaction held open past midnight cannot date a promise to the day before;
- "infinity" is refused as a date;
- `service_role` loses its rights on the two logs, as in the other steps.

**Critical, shared, fixed jointly on main** in `0023_safe_search_path` (2026-11-15): with an empty search path, Postgres looks for a type name
in the session's temporary schema first. A session as the app's role can make a temporary type
called `uuid` whose check runs its own code; inside any `SECURITY DEFINER` function with
`search_path = ''` that declares or casts to `uuid`, that code runs as the function's owner and
bypasses row-level security. The functions of migration 0000 (`app.tenant_id()` and the rest)
are open to it, so it reaches any query on a table with row-level security. The fix is joint:
take the right to make temporary objects away from the app's role (`REVOKE TEMPORARY ON
DATABASE ... FROM PUBLIC`), and give every such function `pg_catalog, pg_temp`. Reported to the
coordinator on 2026-11-15, who made that joint fix; its first run on a hosted Supabase project
was this step's full browser suite on the Finisher's database (92 of 92 passed).

## Later

- **Advances are not taken off the ageing.** It ages what is owed on invoices; money received
  and not yet set against an invoice shows on the statement and in the receipts, not here.
- **The ageing is as at today.** An ageing as at a past day needs what was settled by that day,
  which `app.receivables_open` does not give.
- **Returns** (Step 21's credit notes) join the statement by themselves, as journal lines on the
  customer's receivables account; the ageing and overdue list take them in when credit notes
  settle invoices through `app.receivable_items` (Step 32's notes).
- **No "Needs attention" entries** for follow-ups due or broken promises yet; they would come
  from `inbox/_sources/selling.ts`.
- **Salespeople see nothing of recovery** (founder's decision), not even their own customers'.

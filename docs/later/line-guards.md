# The line guards (joint migration 0033_line_guards)

Written by the Builder on 2026-11-18, at the coordinator's request, while the founder was away.
**Not on the shared development database and not merged**: it replaces functions that other
steps and tracks wrote, so it needs the founder's own yes.

## The hole

The lines of a document are guarded by a trigger that first looks the document up and holds
it (`SELECT ... FOR SHARE` or `FOR NO KEY UPDATE`), so that a line is written only while the
document is a draft and only if it is a line the document may have. When the lookup found
nothing, every one of these guards let the row through ("a line of no document is left for the
foreign key to refuse").

One session can remove a draft and, in the same transaction, write it again under the same id
(ids are the client's to choose) and post it. A second session writing a line into it waits,
because the guard's lookup holds the row. When the first session ends, the lookup returns
nothing: the row it waited for is gone, and the row written in its place is not one it can see.
The guard then checks nothing. The policy, which reads the database as the statement began,
still sees the old draft; the foreign key, which reads what is there now, sees the new row. The
line goes in, unchecked, into a document that is posted.

Found by the independent reviewer of Step 27 (2026-11-17): a line of Rs 1,000,000 added to a
posted Rs 1 supplier bill, whose "return" then gave a credit that settled real bills; an
allocation added to a posted payment. It needs a member who may write the document, running
their own SQL as the app's role in two sessions at once. It cannot be done from the screens.

**The second form**, found by this migration's own reviewer (2026-11-18): the first session does
not remove the draft but **moves it out of the second member's branches** (the app's role may
change a bill's, a payment's or a receipt's branch, and an order's, a transfer's or an
adjustment's warehouse) and posts it. Five guards apply their checks only to a document the
member may write, and leave anything else to the policy; the policy still sees the old draft in
the member's branch. A line of Rs 1,000,000 went into a posted Rs 1 bill this way, and an
allocation against a draft bill into a posted payment. It also works **for a line taken out**:
a line deleted from a draft moved to another branch and posted. It needs two members, one who
moves the document and one limited to the first branch.

## What was found, from the database's own list

On a local database migrated through 0032 (main once Step 26 is merged), every trigger function
in schema `app` (40) was read with `pg_get_functiondef`, and every table the app's role may
insert into (60) was listed with its guard, its parents, and whether its insert policy asks for
the parent. The guards with the hole are those that hold a parent and fall through when it is
not found, on a table the app's role can insert into:

| Guard | Tables | Written in |
| --- | --- | --- |
| `app.check_manual_journal_line` | manual_journal_lines | 0013 |
| `app.check_opening_balance` | opening_balances | 0014 |
| `app.check_sales_document_part` | sales_lines, sales_line_salespeople, sales_document_links | 0016 to 0018, 0025 |
| `app.check_stock_document_line` | stock_transfer_lines, stock_adjustment_lines, stock_count_lines | 0020 |
| `app.check_receipt_allocation` | receipt_allocations | 0022 |
| `app.check_purchase_document_line` | purchase_order_lines, goods_receipt_lines | 0029 |
| `app.check_supplier_bill_line` | supplier_bill_lines | 0030 |
| `app.check_supplier_payment_allocation` | supplier_payment_allocations | 0032 |
| `app.check_account` | accounts (an account under a heading) | 0011 |

The last is not a document's line, but has the same shape: the app's role may remove a heading
of its own while nothing sits under it, and write it again under the same id as an ordinary
account. A new account waiting to go under it then skipped every check (that it sits under a
heading, not an archived one, takes its kind from its heading, and is at most five levels deep).

**Reproduced, before and after** (`src/db/line-guards.test.ts`, two real sessions each):

- Removed and written again: all fourteen tables let the line in before the migration, and all
  fourteen refuse it after.
- Moved out of the member's branches: bills, payments, receipts, purchase orders, stock
  transfers and adjustments; a line written in and a line taken out. Eleven of the twelve went
  through before (a line written into a receipt was already refused); all twelve are refused
  after.
- The same file checks that a line of a document that is really not there is refused as it
  always was, that an honest line still goes in and comes out, and that the app's role cannot
  move a line to another document.

**The change**, one block in each guard, straight after its lookup:

- where the guard has a rule of who may write the document (bills, payments, receipts, purchase
  documents, stock documents): `IF (NOT FOUND AND TG_OP = 'INSERT') OR (FOUND AND TG_OP IN
  ('INSERT', 'DELETE') AND NOT (<that rule, as the guard already wrote it>))`, refused in the
  policy's words (`42501`);
- the sales documents' guard already refused a document the member may not write; the document
  not found is added to that same refusal;
- manual journals, opening balances: `IF NOT FOUND AND TG_OP = 'INSERT'` (their guards check the
  document's state whoever writes);
- the chart of accounts: `IF NOT FOUND`, in the foreign key's words (`23503`).

One refusal in one place, so a document that is not there and one the member may not see are
refused in the same words from the same line (the reviewer's second finding: before, the two
could be told apart). Nothing else in any function is changed; each body is the database's own
definition with that one block added or extended (the build script asserts it).

**`app.apply_supplier_advance`** (0032) is also written out again: it refused a bill named twice
by comparing the ids as typed, so the same id written two ways passed. It compares the ids
themselves now (found by the same reviewer; no money moved wrongly, the sums were still bounded).

## The UPDATE case

An UPDATE that moved a line to another document would have the same gap, but none of these
tables lets the app's role change the column that names the document (or, for an account, its
heading): the test asks the database for each of the fifteen columns and tries it. The UPDATE
of a document (its branch, its warehouse) is the second form above, and is closed by the guard
of its lines. The only line the app's role may change is a stock count line's counted quantity,
and a count's warehouse cannot be changed.

## The second form: a parent read without holding it

The Finisher found, in its own steps, guards that read a parent with a plain `EXISTS` and trusted
it. On main, every line guard above holds its document. The reads that are not held are of these
kinds, judged safe:

- **A line pointing at a line of another, finished document**: a bill line at a posted goods
  received line (`check_supplier_bill_line`), what a payment settles at a posted bill
  (`check_supplier_payment_allocation`), a goods received line at a submitted order's line
  (`check_purchase_document_line`), a delivery, invoice or credit note line at its source line
  (`check_sales_document_part`). What they read is posted or submitted, which is never changed
  or removed (each table's own guard refuses it), and the posting function reads it again,
  held, before anything reaches the books.
- **A sales document's source** (`check_sales_document`, a delivery note's order, an invoice's
  order or delivery, a credit note's invoice): read without a lock, but refused when not found,
  and `post_delivery`, `post_sales_invoice` and `post_credit_note` read it again `FOR UPDATE` and
  refuse unless it is still submitted.
- **A header's own lines when it is posted** (`check_opening_entry`, `check_sales_document`): read
  inside the posting transaction, which holds the header; a line written meanwhile waits on it.

## Judged safe, and why

- `check_purchase_document` (goods received): holds the order and refuses when it is not found.
- `check_sales_document`: as above.
- `check_journal_line`, `check_journal_backed`, `check_journal_balanced`, `check_document_posted`,
  `check_commission_accrual`: the app's role cannot insert into their tables; only the database's
  own functions write there.
- `check_manual_journal`, `check_opening_entry`, `check_receipt`, `check_stock_document`,
  `check_supplier_bill`, `check_supplier_payment`, `check_customer_credit_limit`,
  `check_commission_plan_dates`, `check_tax_rate_for_kind`, `check_audit_row`: guards of a header
  or a record of its own; they hold no parent to lose.
- `commission_after_document`, `commission_after_allocation`, `commission_after_credit`,
  `commission_after_receipt`: after-triggers of posting, reading inside the posting transaction.
- The `refuse_*` functions refuse every change and look nothing up.
- `check_sales_hierarchy` (not this shape, **noted for whoever owns it**): it walks the chain of
  managers without holding it, so two sessions that each add one side of a loop at the same moment
  may both pass, and the hierarchy would then hold a cycle. Not tested and not changed here.

## A single place to close the whole class?

Asked by the coordinator; not built.

- **The database chooses every document's id** (no INSERT right on `id`, ids only from the
  default). A removed draft could then never come back under its old id, and the whole class is
  closed for every table at once, today's and later ones. The cost: every command that saves a
  draft names the id today (Drizzle writes every column), so the inserts would move to raw SQL
  with column lists, as was done for tables with column-level grants. That is a change across all
  three tracks' code, and a later table that forgets it reopens the hole.
- **Refusing a header insert that reuses the id of a row removed in the same transaction**: the
  database keeps no record of a removed row that a trigger can ask, short of a table of removed
  ids written by a delete trigger on every header. Possible, but more machinery than the per-guard
  change, and a header removed in one transaction and written again in the next would still need
  the guards' change.
- **The guard's own change** (this migration): four lines in each guard, no change to the app, and
  each new guard written from now on is checked by the review. Chosen for that reason. A rule in
  `npm run check` could ask that a guard holding a parent never falls through on NOT FOUND; noted
  for later.

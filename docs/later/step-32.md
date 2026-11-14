# Step 32: receipts and cheques

Being built in track A (selling and collecting). This file is filled in as the step goes.

## Decided by the founder (2026-11-14, asked once for the batch of Steps 32, 21 and 37)

- **The owner, an accountant and the recovery officer record money received.** The sales team
  sees what a customer owes and does not record money.
- **Money received beyond the customer's unpaid invoices, or before any invoice, is kept as the
  customer's advance** and can be set against later invoices.
- **A cheque brings the customer's balance down when it is received.** It sits in "Cheques in
  hand" until the bank clears it; if it bounces, the invoices it paid are unpaid again.
- **"Discount allowed" on a receipt waits for a later step** (a customer who pays a little
  short and is let off the rest).
- **Yes to applying this batch's database changes to the shared database** without asking
  again, each after an independent review. Steps 32 and 37 only add; Step 21 also replaces
  four existing rules for sales documents with wider ones.

## Decided for Fazal, to confirm

Choices that came up while building. Each is the option I would have recommended.

- **A cheque that bounces after it had cleared comes back out of the bank in full, and the
  bank's collecting charge stays an expense.** The first version reversed the charge too. The
  independent accounting check pointed out that a bank returning a cheque takes back the whole
  cheque and keeps its charge, so the books would have ended away from the bank statement.
- **Nothing is recorded with a date that has not come yet** (a receipt, a deposit, a clearance,
  a bounce, a cancellation, an advance set against an invoice). An act dated ahead would stop
  the receipt being bounced or cancelled on its true day. "Today" is Pakistan's day, as
  everywhere in the product until a company can choose its own time zone.
- **A member limited to some branches is shown, and can pay, only those branches' invoices**,
  not another branch's and not the opening balances, which belong to the whole company. Someone
  who works across the company records a receipt for those.
- **Customers that deduct tax when they pay are not handled.** A company that withholds income
  tax from what it pays its suppliers would pay us short and give a certificate; that part of a
  receipt belongs in Advance income tax. The design partner's customers are dealers, so this
  was left out. Until it is built, such a receipt can only be entered short, leaving the
  balance on the invoice.
- **A receipt belongs to one branch or to the whole company, and its entry in the books goes
  there**, whichever branch the invoices it pays belong to. What a customer owes is kept for
  the company, not branch by branch (the opening balances already had no branch).

## Decided while building (by Claude; not reviewed by an accountant)

- **What each act posts** is in `docs/examples/step-32.md`, with the independent check.
- **Cheque details live on the receipt's own row**, not in a `cheques` table as the plan's data
  model has it: a cheque is one receipt, and one row keeps one set of guards. The cheques
  register is the receipts that are cheques.
- **There is no `customer_advances` table either.** An advance is what a standing receipt holds
  beyond the invoices it is set against, worked out from the rows; nothing is stored twice.
- **Depositing a cheque posts nothing.** It is still a cheque. The receipt keeps which bank
  account it went to and when; clearing moves it from Cheques in hand to that account.
- **A bounced or cancelled receipt is final.** When the customer pays again, that is a new
  receipt. A cheque that has gone to the bank is not cancelled: it clears or bounces.
- **A receipt cannot pay an invoice dated after it.** Money that comes first is an advance, set
  against the invoice once the invoice exists.
- **Setting an advance against an invoice is an entry of its own** (advances to the customer's
  account), one for each invoice, with no document number.
- **Opening balances that a standing receipt has been set against cannot be reversed**; the
  receipts are cancelled first. The opening balances screen is shared and was not changed, so
  the refusal shows there as "That did not work" (see Later).
- **The recovery officer chooses the cash or bank account and sees a customer's unpaid invoices
  through database functions that ask who is reading**, without being given the chart of
  accounts or the sales documents themselves.

## For the other steps

These will not be renamed.

- Tables `receipts` and `receipt_allocations`. A receipt's `status` is `draft`, `posted`,
  `bounced` or `cancelled`; a cheque's stage is `cheque_status`: `received`, `deposited`,
  `cleared`, `bounced`. An allocation row counts while `posted_at is not null and voided_at is
  null`; it names `invoice_id` (a posted sales invoice) or `opening_balance_id`.
- **Step 38 (commission released on collection, reversed on a bounce)** can hang its own
  triggers on these changes, each made inside the transaction of the act:
  - money collected in cash or into the bank: `receipts.status` goes `draft` to `posted` with
    `method` in (`cash`, `bank`);
  - a cheque collected: `receipts.cheque_status` goes `deposited` to `cleared` (`cleared_on` is
    the day);
  - an advance set against an invoice later: a row is inserted into `receipt_allocations` with
    `posted_at` set and `journal_id` set (`allocated_on` is the day);
  - taken back: `receipts.status` goes `posted` to `bounced` (`bounced_on`) or to `cancelled`,
    and in the same statement group every one of its allocation rows gets `voided_at`.
  What has been collected on an invoice, as against merely covered by a cheque in hand, is the
  sum of its counting rows whose receipt is `posted` with `method <> 'cheque'` or
  `cheque_status = 'cleared'`.
- **Step 21 (credit notes)**: every question about what is still unpaid on an invoice goes
  through `app.receivable_items(tenant, customer)` (total and settled per invoice). A credit
  note that settles part of an invoice changes that one function, and `app.require_not_overpaid`
  then guards it as well.
- **Step 33 (overdue customers, statements, ageing)**: `app.receivables_open(customer, all)`
  gives each invoice with its due date, total, settled and outstanding, to the owner, an
  accountant, an auditor, the recovery officer and the sales manager, within their branches.
  The Receipts and Cheques menu entries now lead to `/receipts` and `/receipts/cheques`; the
  owner's Collections leads to `/receipts` until Step 33 gives it a page of its own.
- **Step 34 (bank and cash)**: receipts go into the ledger accounts under Cash accounts and Bank
  accounts. A bank's fee for returning a cheque, and paying an advance back to a customer, are
  not built.
- Journal source types added: `receipt`, `cheque_clearance`, `cheque_return`,
  `advance_application`. Number series `RC`.

## Later

- **"Discount allowed" on a receipt** (the founder set this aside): until then a small balance
  stays on the invoice.
- **Paying an advance back to a customer**, and a customer's advance at opening (noted under
  Step 15), need a payment out of cash or bank: Step 34.
- **A post-dated cheque counts as payment from the day it is received.** The independent
  accounting check cautions that this shows the customer as owing less than they do until the
  cheque's date, in the ageing and against the credit limit. If it bites, count a post-dated
  cheque only from its own date.
- **The opening balances screen says only "That did not work" when a reversal is refused
  because receipts have been set against it.** The screen is shared; its command should turn
  the database's code SE109 into words.
- **A cheque cannot be cleared, or bounced after clearing, while the bank account it was
  deposited in is archived**, because the ledger takes no new line on an archived account. The
  refusal says to restore the account first. Nothing stops a bank account being archived while
  a cheque deposited in it has not cleared.
- **A member limited to some branches sees the amount, not the number, of another branch's
  invoice** on a receipt of their own branch that someone working across the company set
  against it.
- **A receipt in a foreign currency** is not handled; sales are in the base currency for now.
- **One receipt, one customer.** A single cheque covering two customers' invoices is entered as
  two receipts.
- **The list of unpaid invoices on the receipt form is the whole list**, sent with the page.

## Reviewed before it was applied

An independent reviewer attacked the migration twice on a throwaway local database as the
app's own database role (2026-11-14 and 15). The first pass found one serious hole: part of an
advance could be set against the same invoice twice by writing its id two ways (in capitals,
say), paying the invoice more than it comes to. It is closed twice over: ids are compared as
ids, and after anything is set against a customer's invoices the database asks once more that
none is overpaid. Five smaller findings were fixed with it (branch limits on what a customer
owes, what a draft row may name, dates that have not come, a bank charge on a cheque before it
clears, an archived bank account). The second pass confirmed those, confirmed the treatment of
a cheque that bounces after clearing, ran three hundred receipts through ten sessions at once
with the books agreeing at the end, and left three small points that were then dealt with as
it asked; those last changes were checked by this step's own tests, not by a third pass.

The accounting was worked out by Claude, worked out again by a second Claude that saw only the
events, and compared with what the software posts (`docs/examples/step-32.md`). Not checked by
an accountant.

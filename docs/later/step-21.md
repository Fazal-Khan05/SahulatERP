# Step 21: credit notes and sales returns

Built in track A (selling and collecting). Migration `drizzle/0023_credit_notes.sql`.

## Decided by the founder (2026-11-14, asked once for the batch of Steps 32, 21 and 37)

- **The owner, an accountant and the sales manager record a return and its credit note.** A
  salesperson asks one of them.
- **Returned goods that are damaged are written off at once**: they do not go back on the
  shelf, and their cost goes to Stock adjustments. Goods that can be sold again go back into
  stock.
- **Yes to replacing the existing database rules for sales documents** with wider ones that
  also allow a credit note, after an independent review; nothing is dropped.

## What was built

A credit note is a sales document of its own kind, made from one posted sales invoice on that
invoice's page ("Record a return"). For each line of the invoice the person enters how much
came back and how much of that is damaged. It is a draft until it is posted; posting is one act
of the database (`app.post_credit_note`), which:

- refuses more than is left of what the invoice billed, line by line, over all its credit notes;
- works each line out as the invoice line's own value and tax in the proportion of the quantity
  (the last return of a line takes whatever is left, so a line's credit notes never come to a
  paisa more or less than the line did), and refuses a credit note whose figures differ;
- takes the number (CN-2627-00001) and posts one journal: Sales, sales tax and further tax come
  down; the customer's account comes down by as much as is still unpaid of the invoice, and
  the rest is the customer's credit (Advances from customers); goods fit to sell go back into
  the warehouse they left at the cost they left at; damaged goods are written off to Stock
  adjustments;
- records what it settled, so the invoice shows as owing less everywhere receipts look.

Credit left over is set against the customer's other unpaid invoices from the credit note's
page (`app.apply_credit_note`). A posted credit note is never changed or cancelled.

Of the four rule replacements the founder approved, three were needed (the policy for writing
a sales document, the document's guard, the lines' guard): the fourth, the end-of-transaction
check, is untouched, because a credit note is refused earlier, in the guard itself. One more
was needed that was not on the list: `app.receivable_items` of Step 32 (what is still unpaid on
an invoice), which now also takes off what credit notes settled. Asked of the founder through
the coordinator on 2026-11-15, before the migration reached the shared database.

## Decided for Fazal, to confirm

These came up while building. Each is the option I would recommend; say if any should change.

1. **A credit note always takes goods back.** It is entered as quantities of an invoice's
   lines. A credit note for a price mistake or an allowance, with no goods coming back, is not
   built yet (see Later).
2. **A credit note first settles what is still unpaid on its own invoice; the rest is the
   customer's credit.** The credit sits with advances from customers until it is set against
   another invoice. Paying it back in cash comes with bank and cash payments (Step 34).
3. **The owner and an accountant set leftover credit against invoices.** The sales manager
   records the return but does not settle a customer's account.
4. **Goods come back to the warehouse they left from**, at the cost they left at (not at
   today's average cost). To put them somewhere else, transfer them afterwards.
5. **A posted credit note is never cancelled**, like a posted invoice. One entered by mistake
   is put right by invoicing the goods again.
6. **A credit note carries tax as its invoice did**, at the invoice line's own rates, even if
   the rates or the company's registration have changed since.
7. **It is dated on or after its invoice and never in the future**, and can be posted even if
   the customer has been archived since the sale.
8. **The salesperson whose sale it was can read the credit note**, but not write it.
9. **Opening balances that a credit note's credit has been set against can no longer be
   reversed** (a credit note cannot be cancelled to free them).
10. **A credit note can be posted for an invoice of any age, and brings sales tax down.** The
    sales tax rules are understood to allow that only within 180 days of the sale, and to want
    a registered customer's debit note first. The credit note has a place for the customer's
    debit note number but does not insist on it, and nothing warns about an old invoice yet.
    Neither point has been checked against the law's text: see the questions at the end of
    `docs/examples/step-21.md`, which are for a tax adviser.

## For the other steps

**Step 38 (commission accruals), what to hang the reversal on.** Nothing about commission is
built here.

- *A return is recorded* when a `sales_documents` row with `kind = 'credit_note'` goes from
  `draft` to `submitted`. Only `app.post_credit_note` can do that, and it writes the audit row
  `credit_note.post` in the same transaction. It never goes back: there is no cancellation to
  undo.
- *What to reverse.* Each line of the credit note has `source_line_id` = the invoice line it
  takes back, `quantity` (in the unit sold) and `value` (before tax, after discount): the
  share of the invoice line's value that came back. A credit note has no rows of its own in
  `sales_line_salespeople` (the database refuses them): the salespeople and their shares are
  those of the invoice line, `sales_line_salespeople.line_id = sales_lines.source_line_id`.
  `damaged_quantity` says how much of the quantity was written off; it does not change the
  value credited.
- *A credit note is not money collected.* What it settles is in `credit_note_allocations`,
  apart from `receipt_allocations`. If commission is released when an invoice is collected,
  the part of an invoice settled by a credit note was never collected. The hooks written in
  `docs/later/step-32.md` (rows of `receipt_allocations`) are unchanged and never include
  credit notes.
- `app.receivable_items` (what is still unpaid on an invoice) now counts both.

**Step 33 (customer statements and ageing).** `app.receivables_open` already shows each
invoice net of its credit notes. On a statement, a credit note is a `sales_documents` row of
kind `credit_note`; what it did to the customer's account is in `journal_lines` with
`customer_id`, under journals of source type `credit_note` (the credit note itself) and
`credit_application` (credit set against another invoice later; this one only moves the amount
from advances to the receivable). Credit not yet used is the credit note's total less its rows
in `credit_note_allocations`, and is part of the customer's balance in Advances from customers
together with what receipts left there.

**Step 23 (print, PDF and email), already merged.** A credit note prints, emails and has a
timeline like every other sales document. Three lines were added to that step's files:
`src/modules/sales-print/rules.ts` (the heading "Credit note"), `src/modules/sales-print/view.ts`
("Credit to" above the buyer) and `src/modules/sales-timeline/rules.ts` (it is "Posted", not
"Submitted"). The printed credit note names its invoice, as a sales tax credit note must.

**Step 34 (bank and cash payments).** Paying a customer's credit back needs a row that takes
it off the credit note (or the receipt) it came from, as `credit_note_allocations` does for an
invoice, so that the credit cannot be both refunded and set against an invoice.

**The sales tax return.** A credit note brings output tax and further tax down in the month
of the credit note, not of the invoice: the journal lines on Sales tax payable and Further tax
payable under source type `credit_note`.

## Later

- A warning on a credit note for an invoice more than 180 days old, and asking for a
  registered customer's debit note number, once a tax adviser has confirmed the rules.
- A report of what came back, by item and by customer (returns are debited to Sales, so the
  accounts alone do not show them).
- A credit note without goods coming back: a price correction or an allowance.
- Paying a customer's credit back in cash or by bank (Step 34).
- Taking back credit that was set against the wrong invoice. Until then it stays where it was
  put; what the customer owes in all is right either way.
- Goods coming back into a different warehouse, or a different branch, than they left from.
- Exchanging goods in one step (a return and a new sale together).
- Returns of goods sold before the books were opened: an opening invoice has no lines to take
  back. Until then: a manual journal, and opening stock for the goods.
- Batches and serial numbers on returned goods (they do not exist anywhere yet).
- More than one draft credit note for an invoice at a time from the screen (the database
  allows it; the screen opens the draft there already is).

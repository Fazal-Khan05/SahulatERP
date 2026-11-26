# Batch A: one-step New invoice, the All lists, Money in and Money out (2026-11-27; not a numbered step of the plan)

Three gaps Fazal found comparing the product with Fast Accounts, which his first customer uses.
Version 1.7.

## What it does

- **New invoice** (Sales, Sales invoices tab). For a customer on the list: customer, where the
  goods leave from, the salespeople and their shares, and the lines priced from the price lists.
  One button makes the sales order, submits it (the credit limit is checked as for any order),
  makes the invoice straight from it and posts it, which takes the goods out of stock and puts
  the sale in the books. All in one transaction, by the same commands the two-step way uses
  (`src/modules/direct-invoices`); nothing new writes a document, a stock move or a journal.
  It ends on the posted invoice, with Print and Download PDF.
  - Over the credit limit, entered by anyone but the owner: kept as an order waiting for the
    owner's approval, and the page says so. Nothing is delivered or invoiced.
  - Over the limit, entered by the owner: the form asks for the reason, as the order form does,
    and keeps nothing until it is given.
  - Short of stock: the order and its draft invoice are kept, and the draft invoice's page shows
    the usual shortage card with "Buy the missing goods from the market". Post it once the goods
    are in.
- **All** on Sales (a tab) and on Purchases (a link in the row of buying screens): every kind
  of document the member can already read, newest first, with a Type column and a search box.
  Read-only, made of the lists each kind already has, so each kind keeps its own permission
  check and row-level security (`src/modules/document-lists`).
- **Money in** and **Money out** (Cash and bank). For money that is none of a customer receipt,
  supplier payment, expense, salary or transfer: the owner's capital, a loan received or repaid,
  drawings, other income. Date, the cash or bank account, what it is (the other account), amount,
  from or to whom, reference, note. Numbered MI-2627-00001 and MO-2627-00001.

## In the database (migration 0049_money_in_out, track C, error codes SE381 and SE382)

- Table `money_in_out`, written only by `app.record_money_in_out` and `app.cancel_money_in_out`;
  the app's role reads it under row-level security (owner, accountant, auditor, who work in every
  branch).
- Money in: debit the cash or bank account, credit the other account. Money out: the other way.
  One journal of two lines, `source_type = 'money_in_out'`, the entry's number on it, and the
  audit rows `journal.post` and `money_in_out.record` (`money_in_out.cancel` on a cancel).
- The other account: takes postings, in use, not a control account (receivables, payables,
  stock, tax, cash and bank, retained earnings, staff advances and the rest), and for money out
  not an expense account.
- Cancelled by a reversal on or after its own day, with a reason, never changed.
- It calls Step 34's `app.cash_bank_may_write`, `app.cash_bank_account`,
  `app.cash_bank_reopenable` and `app.cash_bank_reverse` as they stand, and changes nothing else.

**Ledger and bank reconciliation.** Nothing was added for either: both read journal lines on an
account, whatever posted them, as they do for expenses and transfers. An entry is in its
accounts' ledgers at once, and on a bank account it is offered for matching; the automatic match
finds it by its MI- or MO- number in the statement's reference or description, or by amount and
day. The database test imports a statement and sees both kinds matched.

## Decided for Fazal, to confirm

1. **Short of stock, the order and the draft invoice stay.** That is what "Invoice and deliver
   now" does today, and the market purchase needs a document to come back to. The order takes
   its SO number then. The other choice was to keep nothing and only show the message.
2. **The owner over the credit limit gives a reason on the same form**, rather than the sale
   being put on hold for himself.
3. **A New invoice sent twice could make two invoices.** The button greys out while it works,
   but there is no "sent once" key as the counter sale has: that needs a small table of its own.
   Worth adding if double clicks turn up.
4. **Money in and out belong to the whole company**, like transfers: an accountant limited to
   some branches neither records nor sees them.
5. **Money in may go to an expense account** (a refund of something spent); only Money out
   leaves expenses to the Expenses form.
6. **MI and MO** are the new number prefixes; no other document uses them.
7. **The Purchases All search looks through the newest 200 of each kind**, because the buying
   lists have no search of their own. An older document is found from its own list.
8. **The cash-flow report** was not changed: it places MI and MO by its own rules. Where they
   land (capital and loans should be financing) is not checked; the reports belong to another batch.

## Follow-ups noticed, not done here

- Cash and bank, Accounts: each account's link to its ledger points at `/reports/ledger?account=`,
  but the report is `/reports/general-ledger`. It looks broken; not checked.

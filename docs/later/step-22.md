# Step 22: walk-in counter sales (customer advances were Step 32's; foreign currency is for later)

Track A (selling), built by the Finisher. Migration `0033_counter_sales` (two tables, one
function, three guards; nothing in an existing table changes).

## Decided by the founder (2026-11-15)

- **A walk-in buyer pays at once, at the counter.** One shared "Walk-in customer" per company;
  the buyer's name and phone are typed on the sale; the goods leave stock and the cash or bank
  payment is recorded in the same step. Walk-ins get no credit.
- **No foreign-currency sales for now: "we dont need foreign currency sale right now, only pkr
  sale".** So this step does not build multi-currency sales or the exchange gain or loss on
  settlement. docs/PARALLEL.md says Step 22 builds the exchange gain or loss rule for Step 26 to
  use; it does not exist, so Step 26 (foreign-currency supplier advances) builds it, or asks
  the founder again (passed to the coordinator on 2026-11-15).
- The batch's additive migrations may be applied to the shared database after an independent
  review.

## What a counter sale is

Sales invoices → **New counter sale** (`/sales/counter`). The form is the sales order's: lines
priced from the price lists as for a buyer with no list of their own (the company's default
prices), the warehouse, the date, notes, the further-tax mark and salespeople under "More". In
place of the customer: the buyer's name (required) and phone (if they give it). Below the
lines: how the buyer paid, cash or into a bank account (transfer or card), which account, and a
reference. One button, **Record the sale and the payment**.

In one transaction, through the same code that makes each of them anywhere else:

1. a sales order to the walk-in customer, submitted (SO-), with a `counter_sales` row holding
   the buyer's name and phone;
2. its invoice, made straight from the order on the sale's date and posted (SI-): the goods
   leave stock, and the invoice journal is the usual one (receivables, sales, sales tax, further
   tax, cost of goods sold);
3. a receipt for the invoice's total, set against it in full and posted (RC-): cash or bank
   against receivables.

If any of the three is refused (not enough stock, a closed month, a rate changed), none is made.
The invoice's page says "Counter sale to …, a walk-in buyer" and "Paid in full at the counter in
cash, receipt RC-…" (the receipt's number only to those who read receipts).

The walk-in customer is made the first time it is needed, by `app.walk_in_customer()`:
unregistered, no credit days, no credit limit, named "Walk-in customer" (or "Walk-in customer 2"
and so on when a customer of that name is already on the list). It is a customer like any other
in the Customers list, statements and reports.

## Guards in the database

- The walk-in customer is sold to only at the counter: a quotation or a delivery note to it is
  refused, an order to it is not submitted unless it is a counter sale's, and an invoice to it
  must be made from a counter sale's order (SE122).
- Money from it is only a counter sale's own receipt: cash or bank, never a cheque, posted only
  as paying the counter sale's invoice's whole total, and never cancelled (SE122).
- A counter sale is whole when its transaction ends: its posted invoice and the posted receipt
  for the invoice's total, or the transaction is refused (SE123, asked at commit). A counter
  sale's order is invoiced once, by its own invoice.
- A counter sale names its invoice and its receipt once each and never changes otherwise, and
  is never removed (SE123; the app's role may write only those two columns after the row).
- The walk-in customer can be renamed, given a code, a class or a price list, but not archived,
  given credit days or a credit limit, or registered for tax with an NTN, STRN or CNIC (SE124);
  and its counter sales never carry a customer's NTN, STRN, CNIC or address.
- A sale sent twice (a double click, a retried request) is recorded once: the form sends one key
  per sale, kept unique on `counter_sales`, and the second send returns the first sale.
- The buyer's typed name goes onto the order, the invoice and a later credit note as each is
  submitted (a trigger that runs after `sales_documents_check`).
- The app leaves the walk-in customer out of the customer pickers for orders, quotations and
  receipts, and refuses it with a plain message if it is chosen anyway.

## Decided for Fazal, to confirm

1. **Who sells at the counter: the owner and an accountant.** A counter sale takes money, and
   your decision of 2026-11-14 keeps money away from the sales team (receipts are the owner's,
   the accountant's and the recovery officer's). If the person at the counter is a salesperson
   or the sales manager, they would need to record money too; that is a one-line change.
2. **A counter sale is kept as an order, its invoice and its receipt** (three numbers), rather
   than as an invoice with no order. It reuses everything already tested; the order shows in the
   Orders list as fully invoiced.
3. **Paid in full, in cash or into a bank account; no cheque and no part-payment.** A cheque is
   credit until it clears.
4. **The buyer's phone is optional, and is not printed on the invoice.** It shows on the
   invoice's page. The buyer's CNIC is not asked for (see Later).
5. **A return from a walk-in buyer is a credit note, as for any invoice, and a counter sale's
   receipt is never cancelled.** Because the sale was paid, what comes back is owed to the walk-in
   customer as credit until refunds exist (Step 34 builds refunding an advance). A counter sale
   entered by mistake is undone the same way: a credit note for everything, then the refund. Money
   put into the wrong account is moved with a journal from one account to the other.
6. **The counter sale's date may be today or earlier, never later**, so yesterday's sales can be
   entered the next morning.

## The acceptance: an advance set against an invoice clears both

Customer advances with their own locked account (2130 "Advances from customers") were built in
Step 32: money received beyond a customer's invoices is kept as their advance, and part of it is
set against an invoice later with a journal of its own. `src/modules/counter-sales/counter-sales.test.ts`
proves it again for this step: 5,000 received before any invoice is an advance of 5,000; an
invoice of 3,000 follows; 3,000 of the advance is set against it; the customer then owes nothing
on the invoice, 2,000 of the advance is left, and every journal balances.

## Review

An independent review (2026-11-15) found no critical problem and three medium ones, all fixed in
the migration before it reached any shared database: the database did not itself require the
whole invoice to be paid (or paid at all, past the app); a counter sale's receipt could be
cancelled, leaving a walk-in buyer owing for good; and the walk-in customer could be archived,
given credit or a tax identity. Also fixed: a sale sent twice, clearer refusals, and the new
triggers always on, as their neighbours are. Opening balances can still name the walk-in customer
(the opening screens are shared code); see Later.

## Tests

- `src/modules/counter-sales/rules.test.ts`: what is typed, cleaned, and what is said when it is wrong.
- `src/modules/counter-sales/counter-sales.test.ts`, against the database: the three documents
  and their journals, stock out, nothing owed; the same walk-in customer every time and a bank
  payment; nothing made when any part is refused; who may sell at the counter; a counter sale
  never changed; the walk-in customer refused everywhere else, by the app and by the database;
  one made past the app without its receipt, or paid in part, refused; a sale sent twice
  recorded once; its receipt never cancelled and its order never invoiced twice; the walk-in
  customer kept as it is; the buyer named on a return; the acceptance above.
- `e2e/counter-sales.spec.ts`, in the browser: a cash sale and a bank sale at the counter, a sale
  refused whole for want of stock, the walk-in customer not offered elsewhere, and a salesperson
  with no way in.

## Later

- **Foreign-currency sales** (the founder: not now): an invoice in another currency at the rate
  in force on its date, payment in either currency, exchange gain or loss on settlement, price
  lists in another currency, and whether unpaid foreign invoices are revalued at month end. The
  notes in docs/LATER.md on rates (refuse when none, warn when old, rounding) still stand.
- **Refunding a walk-in buyer** when goods come back (Step 34's refund of an advance).
- **The buyer's CNIC** for a large sale to an unregistered buyer, if the company is registered
  for sales tax and FBR asks for it; FBR invoicing is out of scope for now.
- **A receipt printed at the counter** (a short slip rather than the A4 invoice).
- **Who may sell at the counter** may want a role of its own (a cashier) once a pilot asks.
- **The Customers screens say only "That did not work"** when someone tries to archive the walk-in
  customer or give it credit or a tax number: the database refuses it (SE124), but the parties
  module is shared code and does not put that refusal into words. A shared change.
- **Opening balances naming the walk-in customer** are not refused (the opening module is shared
  code); a walk-in buyer's debt from before the books opened would sit there uncollected.

## On top of this step: Stock in the accountant's menu

The founder's decision of 2026-11-18, relayed by the coordinator: the accountant's menu gets
**Stock**, between Suppliers and Items (the accountant already reads stock, `stock.read`). A small
change of its own in `src/modules/tenant/rules.ts`, with its unit test and a browser test in
`e2e/shell.spec.ts` (an accountant signs in, sees the menu, and reaches the stock from it).

# Quick market purchase (after Step 50; not a numbered step of the plan)

A shop that is short of stock buys the goods from the market and finishes the order. The founder
read "stock never goes below zero" in the guide and asked for something to be done about it.

## Decided by the founder (2026-11-25)

Asked by the coordinator, he chose **a quick market purchase** over allowing stock below zero.
So stock still never goes below zero; what is added is a fast, correct way to bring the goods in
first. In his words from the question: a one-step screen (what was bought, from whom, the cost,
paid in cash or from the bank); stock goes up at once at the real cost and the delivery then goes
through; it is offered right on a delivery that is short.

## What a quick market purchase is

The mirror of the counter sale (Step 22). One command, `postMarketPurchase`, in one transaction,
makes what a slow purchase would leave, each through the code that makes it anywhere else
(nothing here posts anything of its own):

1. a purchase order, written as a draft with a `market_purchases` row beside it, then submitted (PO-);
2. the goods received note for all of it, posted: the goods come into the warehouse at the cost
   typed (GR-), debit Stock in trade, credit Goods received not invoiced;
3. the supplier's bill for exactly those goods at that cost, posted: debit Goods received not
   invoiced, credit Trade payables;
4. the payment out of a cash or bank account that settles the bill in full, posted (debit Trade
   payables, credit the account).

Each takes its number from `number_series` inside the transaction and writes its own audit rows;
the purchase adds one more, `market_purchase.post`. If any part is refused, none is made and no
number is taken. A purchase sent twice (a double click, a retry) is recorded once, by the key the
form sends.

To make this possible the four existing commands were opened up, without changing what they do:
`saveOrderDraftIn`, `submitOrderIn`, `saveReceiptDraftIn`, `postReceiptIn`, `saveBillDraftIn`,
`postBillIn`, `savePaymentDraftIn`, `postPaymentIn` run inside a transaction the caller holds,
and the old commands call them.

**The seller** is a supplier on the list, or someone in the market who is not. For those, each
company has one supplier that stands for every such seller, made by the database the first time
it is needed (`app.market_supplier()`): "Market seller", an unregistered individual. The
seller's name and phone are typed on the purchase and kept on its row; they are also written
into the note of each of the four documents ("Quick market purchase from Anarkali Helmet House
(0300 1234567), cash memo CM-118."), so every screen and print that shows a note shows who sold.

**Dated** today or earlier, never later, never in a locked period or before the books were
opened: the documents' own rules.

**The bill's number.** A bill needs the supplier's invoice number, and the same number twice
from one supplier is refused. For a supplier on the list the cash memo number typed is used, so
the same invoice entered twice is caught. For a market seller (many sellers, one supplier; two
shops can both hand over memo "125") the bill carries the purchase order's number, which no
other bill has, and the memo number is kept on the purchase and in the notes.

## On screen

- **Purchases, Quick market purchase** (`/purchases/market`): a button beside "New purchase
  order" and beside "New supplier bill". One screen: Bought on; Warehouse the goods came into;
  Bought from (a seller in the market, with name and phone; or a supplier on your list); Cash
  memo or bill no.; the lines (item code, quantity, unit, cost of one); Paid now, in full (cash
  or from a bank account, the account, a reference); a note. The button is "Record the purchase
  and the payment".
- **On a delivery that is short.** A draft delivery note, and a draft invoice made straight from
  an order ("Invoice and deliver now"), now show a card "Short of stock at <warehouse>": for
  each item, how many are needed, in stock and short. The owner and an accountant get the button
  "Buy the missing goods from the market", which opens the screen with the item, the missing
  quantity and the warehouse filled in; after recording, they are back on the delivery, which
  says what was bought and that there is now enough. Whoever cannot buy (the warehouse, the
  sales team) is told that the owner or an accountant records it under Purchases, Quick market
  purchase. The card shows quantities only: the warehouse still sees no cost.
- The pages of the order, the bill and the payment a purchase made say so, with links to the
  other documents.

## Guards in the database (`drizzle/0045_market_purchases.sql`, error codes SE267 to SE269)

- `market_purchases` is written once: the row with its draft order, then the note, the bill and
  the payment named once each, in that order; nothing else about it changes and it is never
  removed (SE268). The seller is named on it when, and only when, the order is to the market
  supplier.
- **Whole when its transaction ends** (a deferred check, SE268): the order submitted; one posted
  note that received all of every line; the posted bill from the same supplier for exactly
  those goods (every line received, once, in the quantity received and at the order's cost),
  with no tax on it and nothing withheld; one posted payment to that supplier for the bill's
  total, all of it against that bill. A purchase left without its bill, unpaid, paid in part,
  with only some of the goods in, or billed for the right total but the wrong goods is refused.
- **Who sold is said once** (SE268): the order a purchase was written with keeps its supplier,
  and the seller is named on the purchase when, and only when, that supplier is the market
  supplier (asked when the row is written and again as the transaction ends).
- **The market supplier is bought from in no other way** (SE267): an order to it is submitted,
  and a bill from it is posted, only as a quick market purchase's own. So no expense is billed
  in that name.
- **Nothing is paid to it ahead** (SE267): a payment to the market supplier is posted only with
  every rupee set against its bills, which can only be quick market purchases' bills. The
  purchase's own payment is of that kind; so is the one that pays a bill again after its
  payment was cancelled. An advance, or a payment for more than is owed, is refused.
- **The market supplier stays what it is** (SE269): renamed or given a code, yes; archived,
  given credit days, registered for tax, given an NTN, STRN or CNIC, or marked on the Active
  Taxpayers List, no.
- On the ordinary screens these refusals are said in plain words (a draft order or bill to the
  market supplier that is submitted or posted, a payment ahead, archiving it).
- It is left out of the supplier lists of an ordinary order and an ordinary bill, and the quick
  purchase refuses it as "a supplier on the list".
- Who reads a market purchase is who reads its order (the owner, an accountant, the auditor,
  each in their own branches); who writes one is the owner and an accountant.

## Decided for Fazal, to confirm

1. **Who may use it: the owner and an accountant.** It pays money out, and those are the two
   roles that pay suppliers. A sales manager, a salesperson and the warehouse see what is short
   and are told who can buy.
2. **A seller who is not on the list is allowed**, under one stand-in supplier, with the name
   typed each time (the counter sale's walk-in buyer is the precedent). The alternative, making
   every market shop a supplier first, would put back the slowness this was asked to remove.
3. **No input tax and nothing withheld on a quick market purchase.** Input tax is claimed only
   from a supplier registered with an STRN, on a tax invoice; a market seller is neither, and
   the screen is one step precisely because nothing has to be chosen. Nothing is typed as a
   rate anywhere: there is simply no tax category on the bill's lines and no withholding line
   chosen. The screen says so, and says what to do instead (a purchase order and a supplier
   bill) when the seller gave a sales tax invoice or tax must be withheld. What is typed as
   "cost of one" is what was paid, so any tax inside the price becomes part of what the goods
   cost, which is right when it is not claimed.
   **A company that has withholding switched on** cannot make a quick market purchase from a
   supplier on its list at all: the system knows that supplier and that the company withholds,
   so it is sent to the bill, where the tax is worked out. From a seller in the market it still
   can, and is reminded to check whether this seller is one it must withhold from (the reviewer
   thought this the weakest point; it is on the tax adviser's list below).
4. **A purchase from a supplier on the list is paid at once too.** If it is on credit it is an
   ordinary purchase order and bill.
5. **The cost of every line must be more than zero**, and every line must come to at least a
   paisa. A free sample is an ordinary order's business; a line at nothing would be "paid"
   nothing and bring goods in at no cost.
6. **After it is made, each document follows its own rules.** A payment entered by mistake (the
   wrong account, say) is cancelled and the bill paid again by an ordinary payment, for exactly
   what is owed and no more; this is the one way money can come to be owed to the market
   supplier, it is deliberate, and the audit trail shows it. (A counter sale's receipt, by
   contrast, cannot be cancelled; there the remedy is a credit note. Here refusing to cancel
   would leave a wrongly entered bank payment with no remedy at all.)
   **Goods that go back** are a supplier return, as for any supplier, and that leaves a gap
   that is not this work's to close: see "Money back from a supplier" under Later.
7. **Where it returns to.** Opened from a delivery or an invoice it comes back to that document
   and nowhere else, whatever the address asks for; opened from Purchases it opens the bill it
   made.

8. **A purchase sent again with the same key is the first purchase**, even if what was typed
   changed in between (the counter sale does the same). The form makes a new key each time the
   screen is opened.

## Questions for a tax adviser

- Income tax withheld under section 153 from payments for goods: a company that is a
  withholding agent may have to withhold from a market seller once what it pays that seller in
  a year passes the threshold. A quick market purchase withholds nothing and cannot add up what
  was paid to one unnamed seller over a year. For a company that withholds, is "use a bill
  instead when it applies" enough, or should large market purchases be stopped or flagged?
- Section 21(l) of the Income Tax Ordinance disallows an expense paid in cash above a limit for
  one transaction. Should the screen warn above an amount when "Cash" is chosen?
- The reviewer recalled, without looking it up, a newer disallowance of part of what is bought
  from sellers who have no NTN. If it exists and applies, purchases from the market supplier
  are exactly those; the books can already list them (every bill of that one supplier).

## Later

- **Money back from a supplier is not built, for any supplier.** A supplier return of goods
  already paid for leaves the supplier owing the company (a debit in Trade payables), which an
  ordinary supplier works off against later bills. The market supplier's bills are all paid at
  once, so a return to a market seller leaves that debit standing even after the seller has
  handed the cash back, with no document to record the cash. Until a supplier refund exists:
  the return is still right about the stock and about who owes whom; the cash received cannot
  be entered against it. This wants a small step of its own (a refund from a supplier, the
  mirror of Step 34's refund to a customer).
- Every quick market purchase from an unlisted seller is one supplier's, so the list of goods
  still to bill reads that supplier's whole history each time (twice per purchase), and the
  bill's posting takes the supplier in turn. Fine for years of a shop's purchases; if a company
  makes thousands, give that list a filter in the database.
- `src/modules/supplier-payments/payments.test.ts` picks "a posted payment" with `limit 1` and
  no order, and fails now and then when it picks one that settled no bill (seen once while
  building this; not caused by it).
- **The accountant's menu has no Purchases entry** (their "Bills and payments" link is not built
  yet; noted before this work). An accountant reaches the quick market purchase from a short
  delivery, or by the address, or from the Purchases screens once they are there. The menu is
  not changed here.
- A list of quick market purchases of its own. Today each shows in the lists of orders, goods
  received, bills and payments, and says on its page how it was made.
- Buying for several warehouses at once, or part of the goods into each: one purchase is one
  warehouse.
- An expense with the goods (the rickshaw that brought them): a bill line of its own today, by
  the ordinary bill.
- The shortage card names what the saved draft is short of. Quantities changed on the form show
  in it after "Save as draft", or after a refused "Post".
- Shipments' supplier list still offers the market supplier; a bill from it is refused there as
  everywhere.

## Review

An independent reviewer, who had not seen the work, attacked it with SQL of their own as the
app's role in each role and from another company, on a database of their own.

**Found and put right before the migration was sent:**

- *High.* An ordinary supplier payment could pay the market supplier ahead, with no bill on it,
  or for more than a bill after its payment was cancelled. Now refused (SE267): every rupee of
  a payment to it is set against its bills.
- *Medium.* The "whole" check tied the bill to the goods only by its total: by hand, two
  received and one billed at twice the cost went through, leaving one never billable. The check
  now asks for every line received, once, in its quantity and at the order's cost.
- *Medium-low.* A draft order's supplier could be changed after the purchase's row was written,
  ending with a market purchase with no seller named, or a named seller on a listed supplier's
  order. The order now keeps its supplier, and the rule is asked again as the transaction ends.
- *Medium-low.* The new refusals reached the ordinary screens as "That did not work". Each now
  has its own words.
- *Low.* The market supplier could be given credit days (now refused); a line that came to less
  than a paisa went through beside another (now refused); the message for a day that has not
  come was hard to read (reworded); an item sold only by the carton showed its shortage with no
  unit (now says it is counted in the item's own unit); a reused key from someone who cannot
  see the first purchase got a misleading message (now a plain one).
- The same item on two lines was refused only when both left the unit empty; that rule is gone
  (an order may carry an item twice).

**Found and left, with the reason:** goods returned to a market seller (see Later: money back
from a supplier); a key reused with other contents (decision 8); `?bought=` shows a real
purchase of the company on any draft delivery, to someone who may read it anyway; the list of
goods to bill grows with the one supplier (Later).

**Tried and held** (the reviewer's list): rows forged, changed, deleted, pointed at another
company's documents or written by another role; orders and bills inserted already submitted or
posted; a draft bill's supplier swapped to the market supplier and posted; a purchase left at
any half-way point, including after `set constraints all immediate`; two calls for the market
supplier at once (one supplier); six different purchases at once (numbers without a gap, nothing
owed); a refusal at the receipt and at the bill leaving no row, audit row, stock move or number
taken; branch and company limits. Five lines with four-decimal costs, fractions and cartons
came to one total on the order, the stock, the bill and the payment, with no price difference.

## Tests

`src/modules/market-purchases/market-purchases.test.ts` (against a real database, through the
app's own path), `rules.test.ts`, and `e2e/market-purchase.spec.ts`. See the pull request for
what was run where.

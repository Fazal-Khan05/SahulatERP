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
  those goods at the order's total, with no tax on it and nothing withheld; one posted payment
  to that supplier for the bill's total, all of it against that bill. A purchase left without
  its bill, unpaid, paid in part or with only some of the goods in is refused.
- **The market supplier is bought from in no other way** (SE267): an order to it is submitted,
  and a bill from it is posted, only as a quick market purchase's own. So nothing is left owed
  to a seller nobody can name again, and no expense is billed in that name.
- **The market supplier stays what it is** (SE269): renamed or given a code, yes; archived,
  registered for tax, given an NTN, STRN or CNIC, or marked on the Active Taxpayers List, no.
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
   bill) when the seller gave a sales tax invoice or tax must be withheld. A company that has
   withholding switched on is reminded to check whether this seller is one it must withhold
   from. What is typed as "cost of one" is what was paid, so any tax inside the price becomes
   part of what the goods cost, which is right when it is not claimed.
4. **A purchase from a supplier on the list is paid at once too.** If it is on credit it is an
   ordinary purchase order and bill.
5. **The cost of every line must be more than zero.** A free sample is an ordinary order's
   business; a line at nothing would be "paid" nothing.
6. **After it is made, each document follows its own rules.** Goods that go back are a supplier
   return. A payment entered by mistake (the wrong account, say) is cancelled and the bill paid
   again by an ordinary payment; this is the one way money can come to be owed to the market
   supplier, it is deliberate, and the audit trail shows it. (A counter sale's receipt, by
   contrast, cannot be cancelled; there the remedy is a credit note. Here refusing to cancel
   would leave a wrongly entered bank payment with no remedy at all.)
7. **Where it returns to.** Opened from a delivery or an invoice it comes back to that document
   and nowhere else, whatever the address asks for; opened from Purchases it opens the bill it
   made.

## Questions for a tax adviser

- Income tax withheld under section 153 from payments for goods: a company that is a
  withholding agent may have to withhold from a market seller once what it pays that seller in
  a year passes the threshold. A quick market purchase withholds nothing and cannot add up what
  was paid to one unnamed seller over a year. For a company that withholds, is "use a bill
  instead when it applies" enough, or should large market purchases be stopped or flagged?
- Section 21(l) of the Income Tax Ordinance disallows an expense paid in cash above a limit for
  one transaction. Should the screen warn above an amount when "Cash" is chosen?

## Later

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

## How it was checked

See the pull request: the database tests (`src/modules/market-purchases`), the browser spec
(`e2e/market-purchase.spec.ts`), and the independent review.

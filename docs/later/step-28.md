# Step 28: shipments, import charges and landed cost

Built in track B (stock and buying) by the Builder, on Step 27's supplier returns. Migration
`0034_shipments`. Built while the founder was away (2026-11-17): nothing here was asked of
him, and **the migration is not on the shared development database** (his yes of 2026-11-15
covered Steps 24 to 26 only).

## What was built

- **Shipments** (`/purchases/shipments`, shown when Imports is switched on). A shipment is one
  consignment from a supplier. It takes its number as it is opened (SH-2627-00001) and carries
  what identifies it: where it was shipped from, the port, the container, bill of lading, letter
  of credit and goods declaration (GD) numbers, the GD date, the customs value, and the day it
  is expected. **How far it has come** is one of ordered, shipped, at the port, cleared customs,
  received, and is changed by hand.
- **Its goods** are the goods received notes it brought: posted notes from its supplier into
  its branch, each on one shipment.
- **Its charges.** The freight, duty, clearing, tax paid at import and deposits are entered as
  ordinary supplier bills (from the clearing agent, the shipping line, or customs set up as a
  supplier), with **Goods in transit** chosen as the account of each line. So they are owed,
  paid and, where it applies, have tax withheld like any other bill. Each such line is then put
  on the shipment with what kind of charge it is. **The five kinds:**

  | Kind | Where it goes when the shipment is closed |
  | --- | --- |
  | Part of what the goods cost | Spread over the goods, by value, quantity, weight or volume |
  | Sales tax paid at import, claimed back | 1400 Sales tax receivable (input tax) |
  | Income tax paid at import | 1410 Advance income tax |
  | Deposit that comes back | An asset account you choose (1220 Deposits and prepayments) |
  | Expense, not part of what the goods cost | An expense account you choose |

- **Closing the shipment** spreads every charge that is waiting, in one journal, and credits
  Goods in transit with all of them. A charge that is part of what the goods cost is shared
  over the lines of the goods to the paisa. Then, item by item, the part of what the shipment
  brought that the company **still holds** takes its share into stock (each unit is then
  carried at more), and the part that has **already gone** takes its share to cost of goods
  sold. The page shows all of this before it is done, and the landed cost of one of each item
  after.
- **A charge that comes late** is put on the closed shipment and spread the same way, on its
  own: it adjusts the stock still held and the cost of the units already sold.
- **Goods in transit** on the shipments list: what the account holds, beside the charges that
  explain it (on shipments and not yet spread; billed and not yet on a shipment).
- The stock movement report shows these changes of value, with no quantity.
- **Every command writes an audit row.**

**The acceptance test**, "Port the old allocation tests; a late freight bill adjusts remaining
stock and COGS of sold units": the allocation cases of the old engine
(`reference/tests/qa/09-imports.test.ts`, IMP-017 to IMP-028 and those around them) are carried
over in `src/modules/shipments/rules.test.ts` and, against the database, in
`src/modules/shipments/shipments.test.ts`, to the paisa instead of to four decimals. The late
freight bill: ten arrive at Rs 100, four are sold, duty of Rs 1,000 is spread (600 to stock,
400 to cost of goods sold); a freight bill of Rs 500 comes after the shipment is closed, and
300 goes to the six still held and 200 to the cost of the four sold. On screen:
`e2e/shipments.spec.ts`.

What the old tests covered that is different here, on purpose: a shipment is opened on its
own and goods are put on it (the old one was made from a document); charges are bill lines,
not amounts typed on the shipment, so they are owed to someone and paid; there is no charge in
a foreign currency; allocation happens when the shipment is closed.

## Two things of earlier steps, changed

- `app.check_supplier_bill_line` (Step 25, this track's) is written out again: a bill line may
  be charged to Goods in transit, the one locked account a bill can name; and a line is never
  written into a bill the check has not seen and held (the hole the reviewer of Step 27 found;
  see `docs/later/step-27.md`).
- Two checks on `stock_moves` (stock is this track's) no longer ask every move for a quantity:
  a move may now carry a value and no quantity. Only `app.revalue_stock`, which the app cannot
  call, writes one.

## Decided for Fazal, to confirm

Nobody was asked these. Each is the option I would recommend; say if any should change.

1. **Charges are supplier bills charged to Goods in transit, not amounts typed on the
   shipment.** It means every charge is owed to someone and paid through the same screens as
   any bill, and a charge cannot be put on a shipment twice or at a different amount from its
   bill. Duty paid at the bank is entered as a bill from customs (a supplier called, say,
   "Collector of Customs") and paid with a supplier payment. Once payments out of the bank
   without a bill exist (Phase 5), duty could go straight to Goods in transit.
2. **Spread by value unless you say otherwise.** The form starts on "by value"; quantity,
   weight and volume are one click away. Weight and volume come from the item's card.
3. **What the goods cost is fixed when the shipment is closed.** Until then nothing is added
   to stock, however many bills have come. After that, goods cannot be put on it or taken off.
4. **A late charge is spread on its own, on the day it is spread**, over the same goods. It
   does not go back and change earlier months.
5. **What is "still held" is counted for the company as a whole**, item by item: if the
   shipment brought ten and the company holds six of that item anywhere, six tenths of the
   charge goes into stock and four tenths to cost of goods sold. It never counts more as held
   than the shipment brought. It does not follow which particular units were sold: stock is
   kept at the average, so units are not told apart. Goods moved to another warehouse still
   count as held, and take their share where they are.
6. **Who does what.** The owner and an accountant work on shipments; the auditor reads. The
   warehouse does not see them (they carry cost). It goes on receiving goods as before.
7. **How far a shipment has come is changed by hand**, in any order. Nothing follows from it.
8. **A shipment is one supplier's, in one branch.** A container shared by two suppliers is two
   shipments.
9. **A shipment is never deleted.** One opened by mistake, with nothing on it, is cancelled
   with a reason and keeps its number.
10. **Spreading cannot be undone.** A charge spread wrongly is put right by a journal an
    accountant writes, or by the supplier's credit note when those exist.
11. **Charges and goods are in rupees.** A bill in a foreign currency is not built yet.
12. **Value-addition tax at import** has no kind of its own: where the company can claim it,
    enter it as sales tax paid at import; where it cannot, as part of what the goods cost.
    (For a tax adviser, below.)

## The independent review

To be written when the review is back.

## For a tax adviser

No accountant or tax adviser has checked any of this. To be completed from the second,
independent working of the worked example (`docs/examples/step-28.md`).

## Later

- **Bills and charges in a foreign currency**, and the exchange difference on paying them.
- **Duty and tax paid straight from the bank**, without a bill from customs (needs payments
  out of the bank without a bill, Phase 5).
- **A refund of a container deposit**: today a journal an accountant writes, from the bank to
  the deposit account.
- **A supplier's credit note for a charge**, and undoing a spreading.
- **Item profit** (Step 31's report) takes the cost of what was sold from the deliveries. The
  part of a charge that went to cost of goods sold for units already sold is in the books but
  not in that report's cost of the item.
- **Letter of credit tracking** (margin, charges, retirement) is in the plan's backlog.
- **The goods declaration's own lines** (duty and taxes per HS code) are not kept; only the
  number, the date and the customs value.
- **Lists show the newest 200 shipments**; no search, paging or export yet.

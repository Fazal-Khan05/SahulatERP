# Step 31: stock reports

Track B, built by the Finisher session. Step 31 no longer waits for Step 21 (the coordinator's
assignment, 2026-11-14): returned goods join the movement and profit figures when Step 21 lands.

## Decided by the founder (2026-11-14, asked at the start of Steps 31 and 33)

- **Stock ageing shows both** how old the stock on hand is, by when it came in (the newest goods
  received are taken to be the ones still on the shelf; 0-30, 31-60, 61-90, 91-180 and over 180
  days), and how many days since each item last sold. (Recommended was the first only.)
- **Low stock is free stock below the reorder level**: what is on hand less what open sales
  orders still have to deliver, company-wide against the item's reorder level, with each
  warehouse shown.
- **Costs and margins are for the owner, the accountant and the auditor** (stock valuation, the
  values in ageing and movement, item profit). The warehouse and the sales team see quantities.
- **Item profit is by item**, for a period and a branch: sales, cost of goods sold, profit and
  margin.

## What was built

Five reports, each on screen at `/stock-reports/<report>`, as an Excel or CSV file, and printed
on the letterhead, listed on the Reports page under "Stock" (`src/tracks/stock.ts`). No migration:
they read stock moves, stock balances and posted invoices as they stand, under each reader's own
row-level security.

- **Stock valuation**, as at a day: each item in each warehouse, its quantity, weighted-average
  cost and value, then the stock account (control type `inventory`) in the books on the same day
  for the same branch, and the difference. The acceptance test (valuation equals the inventory
  control account) is `src/modules/stock-reports/reports.test.ts`: opening stock, an adjustment, a
  transfer, a delivery note, an invoice from it and a direct invoice, then the valuation equals
  the books today, on an earlier day, and for one branch.
- **Stock movement**, for a period: opening, in, out and closing per item and warehouse; with an
  item chosen, every move of it with the document behind it and the running balance.
- **Stock ageing**, as at a day: the quantity on hand in 0-30, 31-60, 61-90, 91-180 and over 180
  days, the newest goods received taken to be those still on the shelf; its value; and when the
  item last left that warehouse on a delivery note or invoice that still stands.
- **Low stock**: free stock (on hand less what submitted orders still have to deliver) at or
  below the reorder level, shortest first, with where the stock is.
- **Item profit**, for a period and branch: quantity sold on posted invoices, sales before tax,
  what those goods left stock at, profit and margin. Checked against the books: the November sales
  and cost-of-goods-sold accounts equal the report's totals.

## Decided for Fazal, to confirm

- **"At or below" the reorder level**, not only below: the item screen already says "stock at or
  below it asks to be reordered".
- **Orders waiting for the owner's approval do not count as on order** in low stock: they are
  not yet promised to the customer.
- **Item profit counts an invoice in its own period**, with the cost of the goods it billed (from
  its delivery note when it was made from one). The books put that cost in the delivery note's
  month, so a delivery at the end of a month invoiced the next shows the two months differently
  from the profit and loss account. Said under the report.

## Later

- **Returned goods** (Step 21's credit notes) are in since 2026-11-15: item profit takes a
  credit note's quantity and value off sales, and the cost of the goods that came back onto the
  shelf off the cost (goods written off as damaged stay a cost); stock movement names credit
  notes; ageing counts goods that came back as arriving that day.
- **The warehouse and the sales team see only low stock.** Stock moves can be read only by an
  owner, an accountant or an auditor (row-level security on `stock_moves`, Step 19), and the
  founder chose that costs are theirs; a quantities-only movement or ageing report for the
  warehouse would need its own reading function in the database.
- **Ageing after a transfer starts again** from the day the goods reached the other warehouse;
  goods put back by a cancelled delivery note are aged from the day they came back. Carrying the
  first receipt's date along needs batches (`stock_moves.batch_id`, not used yet).
- **"Last sold" is per warehouse.** An item that sells from one warehouse shows "Never" in another.
- **Low stock is not in "Needs attention"** (UI principle 2 lists "stock below reorder"). It
  would be a `waiting` entry in `inbox/_sources/stock.ts`; no step names it.
- **The stock reports have no saved filters, sorting or column chooser** (UI principle 8), like
  the ledger reports.
- **Quantities in the Excel file are text**, so they keep every decimal and their unit; amounts
  are numbers.

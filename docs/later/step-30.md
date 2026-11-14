# Step 30: stock transfers, adjustments, opening stock and stock counts

Built on 2026-11-14 in track B (stock). Migration `drizzle/0020_stock_documents.sql`.

## Decided by the founder (2026-11-14)

- **A transfer moves stock at once.** One person records it and the goods are in the other
  warehouse as soon as it is posted. There is no "on the way" state and no confirmation by the
  receiving warehouse. A wrong transfer is put right by transferring back.
- **Transfers between two branches wait** (see "Later"). For now a transfer stays inside one
  branch.
- **Only an owner and an accountant adjust stock** (write goods off, add goods, enter opening
  stock). The warehouse reports a difference through a stock count.
- **The warehouse counts; an owner or an accountant posts the differences.** A finished count
  waits in "Needs attention" for them. They post it or send it back.
- **An adjustment says why, from a fixed list**: Damaged, Lost or stolen, Found, Sample or gift,
  Own use, Correction of a mistake, Other. "Other" needs a note.

## Decided while building (by Claude; not reviewed by an accountant)

- **What each document posts.**
  - A transfer posts no journal. The goods leave one warehouse at its weighted-average cost and
    arrive in the other worth exactly that, so the stock account does not change.
  - An adjustment: goods added are a debit to Stock in trade (1300) and a credit to Stock
    adjustments (5110); goods taken out are the opposite. Both pairs are written when one
    adjustment does both, so the ledger of 5110 shows what was added and what was lost.
  - Opening stock is the same document with Opening balance equity (3900) in place of 5110.
    The opening balances screen (Step 15) cannot touch the stock account, so this is how the
    stock a company starts with reaches the books. Once the company's other opening balances
    are posted too, 3900 should come back to nil.
  - A count posts as an adjustment does, to 5110: a shortage leaves at the weighted-average
    cost, a surplus comes in at it.
- **What goods coming in are worth when no cost is stated** (a count that comes out over, an
  adjustment up with the cost left empty): the cost the warehouse already holds the item at, so
  its average does not move. A warehouse that holds none (or holds a remnant worth less than a
  rupee in all, too little to read a cost from) takes what one cost the last time the item came
  into it in a quantity worth a rupee or more. Where there is
  no such cost, or it is nothing, the goods are refused rather than let in for free; they are
  brought in by an adjustment that states their cost. Opening stock always states its cost.
  (The first version took the cost of the last one to leave; the reviewer showed that the very
  last of a stock takes whatever rounding left, which can be nothing or too much.)
- **A posted stock document is never cancelled.** A delivery note can be cancelled because
  putting goods back at exactly what they left at is always possible. Taking goods out again
  "at what they came in at" is not: under weighted-average cost what leaves is valued at the
  average of the day. So a wrong transfer, adjustment or opening entry is put right by an
  opposite document, which is valued like any other. Opening stock can take goods out as well
  as bring them in, so that a wrong opening quantity is corrected against opening balance
  equity and not against this year's profit.
- **"Concurrent-edit warning"** in the plan was read as the old system's "Stock changed since
  you opened this item". A count line keeps what the books held when the line was written (the
  database writes that figure, not the app). The difference posted is counted less that figure,
  applied on top of what the warehouse holds at the moment of posting. If stock has moved in
  between, posting is refused until the poster says which came first: the count (the difference
  is right as it stands) or the movement (the sheet is sent back and brought up to date; the
  items that moved lose what was entered for them and are counted again, so no difference
  appears that nobody found on the shelf). Separately, every stock form refuses to save or post
  over a change someone else made after the form was opened, and the database itself refuses
  to post a count that changed after the poster last looked at it.
- **The count sheet does not show the warehouse what the books say.** The printed sheet and the
  warehouse's entry screen list the items only; an owner or an accountant sees the book figure
  beside each line. (In the database a warehouse manager can still read it, as they can read
  what any warehouse holds; only the screens leave it out.)
- **A count posts only the lines that were counted.** A line left empty stays as the books have
  it. A count of zero is an answer.
- **A member limited to some branches** writes or posts a transfer only between two warehouses
  of their own branches. (The read rule already lets a member see a transfer if either
  warehouse is theirs, for the day transfers between branches exist.)
- **Opening stock is dated on the day the books opened**, once the company's other opening
  balances are posted: it goes to opening balance equity, past the profit and loss account, so
  it is not for any other day. Before the opening balances are posted it may carry any open
  date. It may take goods out as well as bring them in, so that a wrong opening quantity is
  corrected against opening balance equity and not against this year's profit.
- **Items are named by their codes** on these screens and in the opening stock file, with the
  item list offered as the code is typed. The picker of the sales screens belongs to track A
  and was not reused.

## For the other tracks

These will not be renamed.

- Tables: `stock_transfers`, `stock_transfer_lines`, `stock_adjustments`,
  `stock_adjustment_lines`, `stock_counts`, `stock_count_lines`. A posted document has
  `status = 'posted'`, a `number` and `posted_at`; adjustments and counts have a `journal_id`
  (null when nothing of value moved).
- Stock moves written here have `source_type` `stock_transfer`, `stock_adjustment` or
  `stock_count`, `source_id` the document and `source_line_id` its line. A transfer line has
  two moves, one out of the first warehouse and one into the second, of the same value.
- Journals have `source_type` `stock_adjustment` or `stock_count`.
- `app.stock_gain_value(tenant, item, warehouse, quantity)` values goods coming in with no
  stated cost, for any later document that needs the same rule (a sales return of goods whose
  delivery cannot be found, say). It is not callable by the app's role.
- **Step 21 (sales returns)** calls `app.move_stock` as it stands; nothing here changed it.
- **Step 31 (stock reports)**: after every document of this step the stock account (control
  type `inventory`) equals the sum of `stock_balances.value` and the sum of `stock_moves.value`;
  the database tests check it after each scenario. The Reports page already has a "Stock"
  heading with one entry, "Stock on hand" (`src/tracks/stock.ts`); the reports of Step 31 join it.
- Number series: transfers `ST`, adjustments and opening stock `SA`, counts `SC` (new, added
  with `app.document_type_sc()`).

## Later

- **The accountant's menu has no Stock entry**, and the menu's words are shared and fixed. An
  accountant reaches the stock screens from Reports ("Stock on hand") and from "Needs
  attention" when a count is waiting. Adding "Stock" to the accountant's menu is a shared
  change (docs/PARALLEL.md, "Changing something shared").
- **The opening balances screen (Settings) does not mention opening stock.** It is a shared,
  finished screen. A line there pointing to "Enter opening stock" would save a new company a
  search.
- **Transfers between the warehouses of two branches are refused** (decided by Claude after
  the reviewer's finding; the founder to confirm). Every journal belongs to one branch and the
  reports can be read branch by branch. Goods moved from one branch to another change what each
  branch's stock is worth, so each branch's books need an entry: stock against an account that
  stands between the two branches. Posting nothing, as for a transfer inside a branch, left the
  receiving branch holding stock its books did not show. Building it means a new locked
  "inter-branch" account, two journals for one transfer, and a rule for who may post into
  another branch's books. It is a piece of its own; nothing posted meanwhile needs correcting.
- **Two-step transfers** (sent, on the way, received) were set aside by the founder for now.
  They need somewhere for goods on the way to be held and valued, so that the stock valuation
  still equals the stock account while they travel.
- **Opening stock entered before the other opening balances is not tied to a date yet.**
  Posting the other opening balances afterwards is refused if the opening stock is dated before
  their date (SE045, from Step 15), which is correct, but the message does not name the stock
  entry; and opening stock dated after their date stays where it is.
- **Tiny remnants of stock carry a rounded cost.** A warehouse left with a fraction of a unit
  after a move out that was rounded to the paisa holds it at a cost that can be a little off
  (weighted-average cost from Step 19). Goods found beside a remnant worth less than a rupee
  are valued from the last proper receipt instead; above a rupee the remnant's own average is
  used, which can be off by under half a percent. Whole-number stock is not affected.
- **Two people saving the same count sheet with their own SQL can make one wait on the other
  until the database stops one of them.** The app's own save takes the sheet first and is not
  affected; found by the reviewer, no data is harmed.
- **No revaluation.** A wrong cost on stock already in the books is corrected by taking the
  goods out (at the average) and bringing them in again at the right cost, in two documents.
  Landed cost (Step 28) will need to change the value of stock without changing its quantity,
  which `app.move_stock` cannot do today.
- **One draft count per warehouse is not enforced.** Two sheets can be open for one warehouse;
  the second to be posted is warned that stock has moved.
- **A count sheet lists every item the warehouse holds.** There is no count of one category or
  one shelf, and no recount of only the lines that differed.
- **The item list offered as a code is typed is the whole item list**, sent with the page. Fine
  for a few thousand items; beyond that it wants a lookup as the sales screens have.
- **Batches and serial numbers** are still not used; every move here leaves them empty.
- **Step 23 (prints)** may want the count sheet and the posted documents in its own print
  layout; the count sheet here uses the existing letterhead parts.

## Reviewed before it was applied

An independent reviewer attacked the migration on a throwaway local database as the app's own
database role (2026-11-14): direct writes, marking documents posted by hand, posting twice and
at the same moment, other companies, other branches, the warehouse reaching for adjustments and
costs, and some six thousand postings at once. Nothing critical or high was found; the stock
account, the balances and the moves agreed throughout. Seven smaller findings were all dealt
with in the migration itself: transfers between branches (refused for now, above), bringing a
sheet up to date (now clears what was counted), posting a count that changed after it was
looked at (now refused by the database), the cost of found goods (above), two sessions waiting
on each other, opening stock used on any date (above), and an error message that told a member
a document they cannot see exists. The reviewer then ran its attacks again on the revised
migration: six were closed; the seventh (the cost of goods found beside a sliver of stock) was
narrowed once more as it asked, and that last change was checked by this step's own tests, not
by a third pass.

Checked by Claude and by a second Claude acting as reviewer, not by an accountant.

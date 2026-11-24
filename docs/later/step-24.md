# Step 24: purchase orders and goods received

Built in track B (stock and buying) by the Builder. Migration `0029_purchase_orders`.

## Decided by the founder (2026-11-15, in the Builder's chat)

- **The migration was applied to the shared development database** on the founder's yes, after
  the independent review and the local tests. The same yes covers Steps 25 and 26, each after
  its own review.

## What was built

- **Purchase orders.** An order names a supplier, the warehouse the goods are to arrive at, a
  date and lines: so many of an item, in one of the item's units, at what one of that unit
  costs before tax. It is a draft until it is submitted; submitting gives it its number
  (PO-2627-00001). An order is a promise: it posts nothing to the books and moves no stock.
- **Goods received.** Goods arrive against one submitted order, in one lot or several. A goods
  received note says how much of each line came, never more than is left of what was ordered.
  Posting it is one act of the database: the goods are in the order's warehouse at the order's
  cost, and one journal is posted:

  | Account | Debit | Credit |
  | --- | ---: | ---: |
  | 1300 Stock in trade | what the goods cost | |
  | 2120 Goods received not invoiced | | what the goods cost |

  The supplier's bill (Step 25) will move the amount from Goods received not invoiced to Trade
  payables.
- **Goods received, not yet billed** (`/purchases/grni`, also under Reports, "Purchases"):
  every line of every posted note at what it cost, with the total, and beside it what the
  account holds in the books. The two are always the same; the page says so, and says so
  loudly if they ever differ.
- **Cancelling an order** nothing has been received against, with a reason. It keeps its number
  and stays on the list, marked cancelled.
- **Screens.** Purchase orders (`/purchases`), a new order, the order's own page (what was
  ordered, what has arrived, its goods received notes), Receive goods (`/purchases/receive`:
  the orders with goods still to arrive and the notes already written), and the note's own page.
- **Every command writes an audit row**: who wrote, changed, threw away, submitted or cancelled
  an order, and who wrote, changed, threw away or posted goods received.

**The acceptance test**, "GRN without bill shows in the GRNI report at cost":
`src/modules/purchasing/purchasing.test.ts` receives part of an order and reads the report: the
lines at the order's cost, a total of 8,400.00, and 8,400.00 on the account in the books. The
same test file checks after every posting that the stock account, the stock on hand, the stock
movements, the Goods received not invoiced account and the goods received all agree.

## Decided for Fazal, to confirm

Nobody was asked these while building (the standing order was "decide and list it"). Each is
the option I would recommend; say if any should change.

1. **Who does what.** The owner and an accountant write, submit and cancel orders. The
   warehouse receives goods (so do the owner and an accountant). The auditor reads everything.
   A salesperson, a sales manager and a recovery officer see none of it.
2. **The warehouse is not shown what goods cost.** It cannot open an order. On Receive goods it
   sees the order's number, supplier, items and quantities, and nothing of the price. This is
   the same rule as the stock screens (Step 30).
3. **An order needs no approval.** Whoever may write one may submit it. An approval step (for
   orders above an amount, say) can be added later if you want one.
4. **No tax on an order.** The cost on an order is before tax. Tax comes with the supplier's
   bill (Step 25), where input tax and withholding are worked out.
5. **Rupees only.** Orders in a foreign currency come with supplier advances and imports
   (Steps 26 and 44 onwards).
6. **Part of an order can arrive, and the rest later**, on as many notes as it takes. **More
   than was ordered is refused**, with no tolerance: if the supplier sends extra, the order is
   not changed; write a second order for the extra.
7. **One draft note for an order at a time.** A second person who starts receiving against the
   same order is sent to the draft already waiting.
8. **Goods come into stock at the order's cost.** Each line of a note is worth the quantity
   received times the order's cost of one, rounded to the paisa. What one costs can be typed
   with up to four decimals (a carton priced by the piece rarely divides to the paisa). If the
   supplier's bill later differs from the order, Step 25 deals with the difference. Because
   each lot is rounded on its own, an order received in several lots can come into the books a
   paisa away from the order's own line; the books always hold the sum of what was received.
9. **A posted goods received note is never changed or cancelled.** Goods received by mistake
   go back with a supplier return (Step 27). Until Step 27 is built there is no way on screen to
   undo a wrong note, so the note is saved as a draft first and posting is a separate button.
10. **An order with any goods received note, posted or still a draft, is not cancelled.** Throw
    the draft away first. An order that is partly received stays open for the rest; there is no
    "the rest will not come" button yet (see Later).
11. **Dates.** An order's date must fall in an open financial year (its number comes from the
    year). Goods arrive on or after the order's date, never on a day that has not come, and
    never in a locked period.
12. **An archived supplier** cannot be given a new order; an order already submitted to one can
    still be received.
13. **Goods arrive at the order's own warehouse.** To put them elsewhere, receive them and
    transfer them.

## The independent review (2026-11-15)

A reviewer who had not seen the work attacked the migration as a signed-in member running any
SQL as the app's database role, with real sessions racing each other. Nothing serious was
found: every promise above held, including cancelling an order against starting a note, posting
against a line being removed, and two notes for one order. Two small gaps in this migration
were closed, each with a test:

- **An order waiting as a draft while an item's carton size is changed** could be submitted
  with the old size, and the goods would later come into stock by it. Submitting now checks
  every line against the item's units again and refuses (SE222); saving the draft again puts it
  right.
- **The refusal for a goods received note** told someone who may not receive into a warehouse
  whether the order they named existed. It no longer looks the order up for them: the answer is
  the same either way.

Also tightened: an order is not submitted on a day that has not come, and a date must be a real
day (the database's "infinity" is refused).

Found by the review but not this step's to change. Each touches something every track uses, so
it needs a migration the three tracks agree on (told to the coordinator). **All three were
taken up on 2026-11-24 by the security clean-up (`docs/later/security-clean-up.md`), which says
what each now is and what the third still does not do:**

- **Any member except the auditor can take the next PO or GR number** by calling the numbering
  function directly, which leaves a gap in the series. The function is open to the app's role
  because manual journals take their number through it (migration 0008).
- **Look-alike audit rows.** The audit rows only the database may write are protected by their
  exact name; a row named with a trailing space or a capital letter is accepted. A rule on the
  shape of an audit action would close this for every document.
- **A member running their own SQL could lock a table for every company.** The app's role has
  no time limit on a lock or a statement. This is true of every table the app writes.

## Later

- **Step 25 must clear Goods received not invoiced by what was received, not by the order's
  amount**: an order received in several lots can differ from its line by a paisa or two (seven
  grips at 33.3333 received one at a time come to 233.31, the order line to 233.33).
- **A note worth nothing** (a free sample, or a value that rounds to nil) posts with no journal.
  The stock still comes in, at nil.

- **Supplier bills (Step 25).** Until bills exist, everything received is "not yet billed", so
  the report lists every posted note. Step 25 must take billed lines off it.
- **Closing an order short**: saying the rest of a partly received order will not come, so it
  leaves the Receive goods list.
- **Printing or emailing an order to the supplier** (a PDF like the sales documents).
- **Supplier returns (Step 27)**: the only way to undo posted goods received.
- **The report on a past date, and its export to a file.** It shows today's position only, and
  every line with no paging.
- **Landed cost** (freight, duty, clearing added to what goods cost) comes with imports.
- **Approval of orders**, if wanted (point 3).

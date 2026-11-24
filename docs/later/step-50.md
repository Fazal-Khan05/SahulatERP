# Step 50: performance pass

Built by the Builder on 2026-11-22 to 2026-11-24, while the founder was away; his one answer
(the region) relayed by the coordinator. A joint step: its migration replaces three functions
other steps wrote (listed under "What changed").

## The test in the plan

"Aged receivables and stock valuation under 3 s on the seed." On a company of 100,475 posted
invoices (632,362 sales lines, 991,052 journal lines, 325,800 stock moves, 65,835 receipts), on
the Builder's Mac, each run three times as the owner:

| | Best | Worst |
|---|---:|---:|
| Aged receivables | 0.56 s | 0.61 s |
| Stock valuation | 1.10 s | 1.12 s |

Every one of the 93 lists and reports timed is under 3 seconds; the slowest is item profit for
the whole year, 2.2 s. The whole table is at the end.

**The hosted database is slower than this Mac.** Nothing was timed on the shared database (the
coordinator's rule: load only on a local database). Anything over about 1.5 s here could come
near the bar there: item profit for a year (2.2 s), stock ageing (1.7 s), cash flow for a year
(1.6 s). Each reads everything the company has ever posted; see "What grows".

## The seed

`npm run perf:seed` (`scripts/perf/seed.ts`) builds an invented distributor, "Perf Distributors
(Seed)", through the app's own commands, so every row is one the product itself would write:
300 items, 500 customers (three in five registered for sales tax), 40 suppliers, 40
salespeople on a 2% commission plan, two branches with a warehouse each, withholding on. Then,
day by day from 2026-07-01: purchases (order, goods received, bill), sales (order, one in ten
through a delivery note, invoice), goods coming back on credit notes (2%), receipts in cash,
by bank and by cheque (cheques older than a fortnight deposited and cleared), and payments to
suppliers. It refuses any database that is not on this computer unless it is named in
`PERF_DATABASE_OK`. It can be stopped and started again; several processes can share the work
(`PERF_SHARDS`, `PERF_SHARD`).

`npm run perf:measure` times each list and report three times as the owner, for the month and
for the year to date, and writes the table (`PERF_REPORT`). `PERF_ENFORCE=1` fails the run if
anything is over the bar. `npm run perf:reset` removes the company.

Neither runs in `npm run check` or in CI: a full seed takes about an hour and a half.

## What the measurements showed, and what changed

Measure first, then change only what the measurements show. Nothing below changes what any
screen or report answers, with the one exception said under "A difference on purpose"; each is
set beside the old question in `src/db/performance.test.ts` and
`src/modules/commission-ledger/ledger.test.ts`, for every kind of member.

| What | Before | After | Why it was slow |
|---|---:|---:|---|
| Posting an invoice: the seller's sales so far this month, asked for each line | 0.23 s a line at 60,000 invoices; the company posted 88 invoices a minute | 15 ms a line; 1,038 a minute | It read every commission movement of the whole company dated in the month. Because numbering has no gaps, everyone else posting in the company waited behind it. |
| Goods received, not yet billed (the screen and the report) | 19 s | 0.2 s | The planner, reading through the tables' policies, took each table for a row or two and set every stock move beside every item. |
| Orders to deliver | 196 s at 14,000 invoices | 1.0 s at 100,000 | "Invoiced from this order line OR from one of its delivery note lines" read every invoice line for each line of each order. |
| An order's progress (the order's own page) | 7.7 s for 40 orders at 14,000 | 0.09 s | The same OR. |
| A customer's credit (asked whenever an order or invoice is saved) | grew with the company | 4 to 8 ms | The same OR. |
| Item profit | 11 s at 14,000 | 0.8 s for a month, 2.2 s for the year at 100,000 | What each line's goods cost was found by reading the stock moves of the whole document. |
| Low stock (what open orders still have to deliver) | 0.42 s at 14,000 | 1.1 s at 100,000 | Read every order line through the policies. |
| Aged receivables | 0.32 s at 14,000 | 0.6 s at 100,000 | Asked customer by customer. |
| Trial balance, profit and loss, balance sheet, the owner's figures | 0.33 s at 14,000 (owner's figures) | 0.35 to 1.0 s at 100,000 | Each summed every journal line through the policies. |
| Commission statements: the list of what was earned | grew with every line ever earned | 1.2 s | The list was cut to its limit after reading everything. |

The "before" figures at 14,000 invoices were taken part-way through the seed, when the old
questions could still be waited for; at 100,000 most of them would not have come back at all.

**In the database** (the migration):

- Three indexes: who sold a document's lines (`sales_line_salespeople (tenant_id, document_id)`),
  the stock move of a line (`stock_moves (tenant_id, source_line_id)`), and what came back in a
  month for commission (`commission_movements (tenant_id, movement_date)`, only movements that
  are not a line's first and carry a base).
- Three functions **replaced**, each answering as it did: `app.order_progress(uuid)`
  (0018), `app.customer_credit(uuid, uuid)` (0018) and `app.commission_month_sales(uuid, uuid, date)`
  (0027).
- Six functions **added**, each refusing for itself whoever the tables' policies refuse:
  `app.orders_to_deliver()`, `app.open_order_quantities(uuid)`, `app.item_profit(date, date, uuid)`,
  `app.receivables_open_all()`, `app.ledger_totals(date, date, uuid, text[])` and
  `app.goods_received_not_billed()`.

Why functions, and not better SQL in the app: through row-level security the planner cannot
see how many rows a policy lets through, guesses "one or two", and then chooses to loop where
it should hash. Rewriting the SQL did not help (one rewrite ran for ten minutes). A function
that checks who is asking and then reads the tables as their owner is planned with the real
numbers. Each of the six says in its own words who it answers, and its test asks it as every
kind of member and as another company.

**In the app**: the lists and reports above call those functions; the commission list asks for
its limit before reading. `vercel.json` now runs the site's functions in Mumbai (`bom1`), next
to the database, instead of Washington: the founder's answer, "Yes, move to Mumbai."

### A difference on purpose

Low stock, for a warehouse manager only: an order that was invoiced straight from the order
used to be counted as still to deliver, because a warehouse manager does not read invoices and
so could not see that the goods had left. It now counts for them as it does for everyone:
what has left has left.

### Tried and not kept

An index on `commission_movements (tenant_id, movement_date)` for every movement made the
month's sales slower, not faster (27 ms against 3 ms on a small company: the planner preferred
it and read the whole month for every seller). The narrower index above, only for what came
back, is the one kept.

## What the seed left out, and why

The coordinator asked for every document the seed left out to be sorted by the error given,
and for each group whether it was the seed's mistake or a refusal a user could meet wrongly.

**None is a refusal a user could meet wrongly, and none is a bug in the product.** Every one
traces to two mistakes of the seed's own and to its being stopped twice. With both mistakes put
right, a fresh run of 8,000 invoices by four processes at once left out nothing at all.

What can and cannot be said of the 100,000-invoice run:

- The seed counted failures for each of its four processes and kept only the first twenty
  messages of each. The "218" reported was one process; the four together left out **1,076**
  documents after their last restart (365, 250, 243 and 218). Counts from before the two stops
  (the pause, and the laptop's restart) were not kept. So the run's failures cannot all be
  listed; what follows is the 80 messages kept, the 18 drafts left behind, and what the
  finished company itself shows.
- The seed now writes every failure down with the database's own error code
  (`perf_seed.failures`), so the next run can be sorted completely.

| What was said | Kept | Checked how | Whose mistake |
|---|---:|---|---|
| "SI-... has 1,281.00 left to pay, not 1,708.00." (the app, before the database is asked) | 59 of 80 | Each of the 59 invoices looked up: every one has a credit note, the receipt asked for the amount planned when the invoice was posted, and what the message says is left is the total less the credit note. | The seed's. It planned each receipt on the day of the invoice and did not look again when goods came back. |
| "One of the invoices is not an unpaid invoice of this customer any more. Reload the page." | 21 of 80 | The message names no invoice, so these cannot be looked up one by one. Two things in the company give it: 59 invoices were returned in full, leaving nothing to pay; and the day the seed was stopped on was posted again when it restarted (30 August has 1,146 invoices where a day has 694), so receipts already taken were asked for a second time. | The seed's, both ways. |
| A draft invoice left behind, never posted | 15 | Each posted again as the owner in a transaction that was then undone: all 15 post. All are dated 30 and 31 August, the days of the stop. | Neither: the process was stopped between saving and posting. |
| A draft receipt left behind | 3 | Each tried again the same way: the database refuses all three (SE102, "the receipt cannot pay that much of SI-..."). Dated 30 August; the day's second posting had paid the invoice. | The seed's (the stop). |

Over the whole run, 1,779 of the 1,881 invoices that had goods come back were never paid: about
190 of those were never going to be (one invoice in ten is left unpaid on purpose), which puts
the receipts refused for this reason at about 1,500, most of the total. Of invoices with no
credit note, those never paid are the one in ten left unpaid on purpose (5,877 of about 52,000
due before mid-September), so nothing else was being refused.

Both refusals are right: a customer cannot pay more of an invoice than is left on it. A person
at the receipts screen would meet the first only by typing more than the invoice still owes,
and the second only with a page opened before someone else took the payment.

What was put right in the seed: a receipt now asks what the invoice still owes and pays that
(nothing, if nothing is owed), which also covers a day posted twice.

**The proof run** (`perf52`, 2026-11-24): 8,000 invoices, 8,000 orders, 757 delivery notes, 135
credit notes, 5,347 receipts, four processes, never stopped: `perf_seed.failures` is empty, and
no draft was left behind.

## The company the seed made is sound

Checked on all of it after the run, as the owner of the database:

- **No gap and no number used twice in any series**, after 100,000 invoices posted twenty at
  a time: SI 100,475, SO 100,490, RC 65,835, DN 10,019, PO, GR and PB 2,900 each,
  PV 1,901, CN 1,881, SA 4. In each, the counter, the number of documents, the number of
  different numbers and the highest number are the same figure.
- **Every one of 300,140 journals balances**, and debits less credits over the whole ledger
  come to 0.0000.
- **No invoice is paid more than it comes to** (100,475 looked at).
- **Stock never went below nothing** in any of the 600 item-and-warehouse pairs.
- **All 300,360 commission accruals are the sum of their movements.**
- **Trade receivables in the books equal what customers' open items add up to**, to the paisa
  (672,324,670.50).
- No order was invoiced twice.

## What grows, and what would fix it

These are under the bar at 100,000 invoices and get slower in a straight line as the company
gets older. None was changed, because none was over the bar.

- **The ledger reports** (trial balance, profit and loss, balance sheet, cash flow, the owner's
  figures) add up every journal line the company has: 0.35 to 1.6 s at a million lines. The
  fix when it is needed: keep a total for each account and month, written as journals post.
- **Stock valuation, movement and ageing** read every stock move: 0.9 to 1.7 s at 326,000.
  The same fix: a kept balance for each item and warehouse at each month's end.
- **Item profit for a year** reads every invoice line of the year: 2.2 s.
- **The seller's sales so far this month** now reads only that seller's lines of the month
  (about 1,500 here). It no longer grows with the company's age, only with how much one
  person sells in one month. A kept total for each seller and month would make it one row.
- **"What is still to deliver"** (orders to deliver, low stock, a customer's credit) reads the
  lines of every order ever submitted to find the open ones: 1.0 s at 100,000 orders. The fix:
  mark an order closed when its last line is invoiced.
- **Posting is one at a time for each kind of document in a company**, because numbers have no
  gaps: about 17 invoices a second here. That is far more than a distributor posts, and is how
  the rules of this project want it.

## Decided without the founder (to confirm)

- The size and shape of the invented company (above), and that it is built through the app's
  own commands and never by writing rows.
- That the seed and the timings run only on a local database, never the shared one.
- The three functions replaced, and the six added, rather than SQL in the app.
- The warehouse manager's low stock (above).
- That nothing under the bar was changed, however it grows.

## Mumbai

__MUMBAI__

## How to run it

```
npm run db:local -- perf                       # a local database for it
DATABASE_URL=postgres://app_runtime@127.0.0.1:54329/perf MIGRATION_DATABASE_URL=postgres://postgres@127.0.0.1:54329/perf npm run perf:seed
DATABASE_URL=... MIGRATION_DATABASE_URL=... PERF_REPORT=report.md npm run perf:measure
```

A smaller company: `PERF_INVOICES=8000`. Four processes at once: `PERF_SHARDS=4` and
`PERF_SHARD=0` to `3`, one command each. What was left out and why: the table
`perf_seed.failures`.

## Every list and report, on 100,475 invoices

A company of 100,475 posted invoices, 632,362 sales lines, 991,052 journal lines, 325,800 stock moves. 2026-11-01 to 2026-11-21 is "the month"; 2026-07-01 to 2026-11-21 is "the year". Each is run three times; the bar is 3.00 s.

| Where | What | Best | Worst | Rows | |
|---|---|---:|---:|---:|---|
| Every page | the company, its name and switches | 4 ms | 35 ms |  |  |
| Home | the owner's figures, month to date | 332 ms | 363 ms |  |  |
| Home | needs attention: orders on hold | 140 ms | 280 ms | 0 |  |
| Home | needs attention: cheques | 52 ms | 78 ms | 200 |  |
| Sales | list: quotation | 2 ms | 4 ms | 0 |  |
| Sales | list: order | 12 ms | 13 ms | 200 |  |
| Sales | list: delivery | 6 ms | 10 ms | 200 |  |
| Sales | list: invoice | 15 ms | 16 ms | 200 |  |
| Sales | list: credit_note | 7 ms | 9 ms | 200 |  |
| Sales | list: invoices, searching a customer's name | 382 ms | 441 ms | 200 |  |
| Sales | list: invoices, searching a number | 15 ms | 15 ms | 200 |  |
| Sales | list: invoices, searching what nobody has | 370 ms | 381 ms | 0 |  |
| Sales | orders to deliver | 984 ms | 1.00 s | 14 |  |
| Sales | one invoice | 12 ms | 21 ms |  |  |
| Sales | picker: customers | 3 ms | 4 ms | 10 |  |
| Sales | picker: items | 2 ms | 2 ms | 10 |  |
| Sales | a customer's credit | 4 ms | 8 ms |  |  |
| Customers | list | 6 ms | 9 ms | 200 |  |
| Customers | list, searching | 6 ms | 6 ms | 200 |  |
| Suppliers | list | 3 ms | 4 ms | 40 |  |
| Items | list | 3 ms | 4 ms | 200 |  |
| Items | list, searching | 3 ms | 3 ms | 111 |  |
| Price lists | list | 1 ms | 2 ms | 0 |  |
| Receipts | list | 61 ms | 66 ms | 200 |  |
| Receipts | cheques, all | 52 ms | 54 ms | 200 |  |
| Receipts | picker: customers | 3 ms | 3 ms | 25 |  |
| Recovery | aged receivables | 559 ms | 613 ms | 500 |  |
| Recovery | follow-up marks | 2 ms | 4 ms |  |  |
| Recovery | follow-ups due | 2 ms | 3 ms | 0 |  |
| Recovery | promises | 2 ms | 2 ms | 0 |  |
| Recovery | one customer | 6 ms | 8 ms |  |  |
| Recovery | customer statement, the month | 10 ms | 16 ms |  |  |
| Recovery | customer statement, the year | 11 ms | 12 ms |  |  |
| Stock | on hand | 9 ms | 14 ms | 600 |  |
| Stock | transfers | 2 ms | 4 ms | 0 |  |
| Stock | adjustments | 3 ms | 4 ms | 4 |  |
| Stock | counts | 2 ms | 4 ms | 0 |  |
| Stock | item choices | 2 ms | 3 ms | 300 |  |
| Stock reports | choices | 2 ms | 2 ms |  |  |
| Stock reports | valuation, the month | 1.10 s | 1.10 s | 603 |  |
| Stock reports | valuation, the year | 1.11 s | 1.12 s | 603 |  |
| Stock reports | movement, the month | 757 ms | 894 ms | 601 |  |
| Stock reports | movement, the year | 815 ms | 855 ms | 601 |  |
| Stock reports | ageing, the month | 1.61 s | 1.63 s | 601 |  |
| Stock reports | ageing, the year | 1.59 s | 1.72 s | 601 |  |
| Stock reports | low-stock, the month | 1.01 s | 1.06 s | 0 |  |
| Stock reports | low-stock, the year | 1.01 s | 1.07 s | 0 |  |
| Stock reports | item-profit, the month | 730 ms | 784 ms | 301 |  |
| Stock reports | item-profit, the year | 1.80 s | 2.17 s | 301 |  |
| Stock reports | movement of one item, the year | 27 ms | 46 ms | 1183 |  |
| Reports | trial balance, the month | 358 ms | 487 ms | 17 |  |
| Reports | profit and loss, the month | 420 ms | 485 ms | 9 |  |
| Reports | balance sheet, the month | 456 ms | 494 ms | 24 |  |
| Reports | cash flow, the month | 432 ms | 477 ms | 11 |  |
| Reports | general ledger of trade receivables, the month | 687 ms | 723 ms | 502 |  |
| Reports | trial balance, the year | 510 ms | 967 ms | 17 |  |
| Reports | profit and loss, the year | 440 ms | 556 ms | 9 |  |
| Reports | balance sheet, the year | 439 ms | 569 ms | 24 |  |
| Reports | cash flow, the year | 1.39 s | 1.58 s | 11 |  |
| Reports | general ledger of trade receivables, the year | 451 ms | 520 ms | 502 |  |
| Reports | general ledger of trade receivables, the year, as a file | 792 ms | 804 ms | 20003 |  |
| Reports | accounts to choose from | 2 ms | 3 ms | 55 |  |
| Journals | list | 2 ms | 4 ms | 0 |  |
| Purchases | orders | 9 ms | 12 ms | 200 |  |
| Purchases | orders to receive | 80 ms | 161 ms | 0 |  |
| Purchases | goods received | 33 ms | 34 ms | 200 |  |
| Purchases | order choices | 4 ms | 6 ms |  |  |
| Purchases | bills | 5 ms | 6 ms | 200 |  |
| Purchases | payments | 7 ms | 11 ms | 200 |  |
| Purchases | returns | 2 ms | 5 ms | 0 |  |
| Purchases | shipments | 2 ms | 3 ms | 0 |  |
| Purchases | withholding to pay | 14 ms | 19 ms |  |  |
| Purchases | goods received not billed | 202 ms | 228 ms | 0 |  |
| Buying reports | choices | 1 ms | 2 ms |  |  |
| Buying reports | aged-payables, the month | 48 ms | 52 ms | 43 |  |
| Buying reports | aged-payables, the year | 45 ms | 49 ms | 43 |  |
| Buying reports | withholding-register, the month | 14 ms | 15 ms | 197 |  |
| Buying reports | withholding-register, the year | 24 ms | 28 ms | 1392 |  |
| Buying reports | section-165, the month | 6 ms | 6 ms | 190 |  |
| Buying reports | section-165, the year | 18 ms | 20 ms | 1385 |  |
| Buying reports | grni, the month | 202 ms | 210 ms | 3 |  |
| Buying reports | grni, the year | 210 ms | 238 ms | 3 |  |
| Buying reports | supplier statement, the year | 4 ms | 6 ms | 156 |  |
| Commission | plans | 2 ms | 4 ms | 1 |  |
| Commission | earned, everyone | 1.10 s | 1.17 s |  |  |
| Commission | earned, one person | 608 ms | 675 ms |  |  |
| Commission | payments | 2 ms | 3 ms | 0 |  |
| Commission | statements, the month | 1.06 s | 1.12 s |  |  |
| Commission | statements, the year | 1.15 s | 1.22 s |  |  |
| Commission | one statement, the year | 762 ms | 841 ms |  |  |
| Payroll | employees | 2 ms | 8 ms | 0 |  |
| Settings | activity | 610 ms | 622 ms | 100 |  |
| Settings | sign-ins | 143 ms | 151 ms | 0 |  |

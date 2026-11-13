# Step 15 worked example: opening balances

Checked by Claude, not by an accountant (the founder has none; decided 2026-11-13). The expected
journal and the ageing were worked out from standard double-entry practice, worked out a second
time by an independent reviewer who did not see the first answer, and both were compared with
what the software posts. All three agree. The tests "posts one journal that balances through
opening balance equity" and "ages imported receivables from each invoice's own date" in
`src/modules/opening/opening.test.ts` enter these figures and fail if the software ever posts
or ages anything else.

## The company

A trading business moves its books here on 1 July 2026. Its balances at the close of 30 June 2026:

| Account | Balance |
| --- | ---: |
| 1111 Cash in hand | 50,000.00 debit |
| 1121 HBL current account | 450,000.00 debit |
| 1510 Furniture and fixtures | 125,000.00 debit |
| 1530 Vehicles | 1,100,000.00 debit |
| 2510 Loans from banks | 200,000.00 credit |
| 3100 Owner's capital | 2,226,460.00 credit |
| 1300 Stock in trade | 663,230.00 debit (not brought in here) |
| 1200 Trade receivables | 86,240.75 debit (the invoices below) |
| 2110 Trade payables | 48,010.75 credit (the bills below) |

These books balance: debits and credits are both 2,474,470.75.

Customers' unpaid invoices:

| Customer | Invoice | Date | Unpaid |
| --- | --- | --- | ---: |
| Alpha Motors | SI-0412 | 05-03-2026 | 84,500.00 |
| Alpha Motors | SI-0455 | 15-05-2026 | 200.00 |
| Delta Stores | SI-0601 | 20-06-2026 | 1,500.75 |
| Gamma Autos | SI-0490 | 20-04-2026 | 40.00 |

Suppliers' unpaid bills:

| Supplier | Bill | Date | Unpaid |
| --- | --- | --- | ---: |
| Tau Parts | B-77 | 01-06-2026 | 36,010.75 |
| Sigma Imports | B-1 | 10-06-2026 | 12,000.00 |

## The opening journal, dated 1 July 2026

| Account | Customer or supplier | Debit | Credit |
| --- | --- | ---: | ---: |
| 1111 Cash in hand | | 50,000.00 | |
| 1121 HBL current account | | 450,000.00 | |
| 1510 Furniture and fixtures | | 125,000.00 | |
| 1530 Vehicles | | 1,100,000.00 | |
| 2510 Loans from banks | | | 200,000.00 |
| 3100 Owner's capital | | | 2,226,460.00 |
| 1200 Trade receivables | Alpha Motors | 84,700.00 | |
| 1200 Trade receivables | Delta Stores | 1,500.75 | |
| 1200 Trade receivables | Gamma Autos | 40.00 | |
| 2110 Trade payables | Tau Parts | | 36,010.75 |
| 2110 Trade payables | Sigma Imports | | 12,000.00 |
| 3900 Opening balance equity | | 663,230.00 | |
| Total | | 2,474,470.75 | 2,474,470.75 |

Trade receivables is posted once per customer (the sum of that customer's unpaid invoices) and
trade payables once per supplier, so each customer's and each supplier's balance can be read
straight from the ledger. The invoices themselves are kept one by one, with their own numbers
and dates.

## Opening balance equity

Before the last line, debits are 1,811,240.75 and credits are 2,474,470.75. The journal must
balance, so the 663,230.00 between them is debited to Opening balance equity.

That figure is the stock, which this journal leaves out. Stock is brought in item by item when
stock is set up, with "debit Stock in trade, credit Opening balance equity" for 663,230.00, and
Opening balance equity then stands at nil. It is a holding account: nothing should stay in it.

If the books entered do not balance, the amount in Opening balance equity is not the stock's
value, or sits on the credit side. That is the sign that a balance is missing or mistyped; the
screen says so. The first draft of this example had the owner's capital too low, and the
independent reviewer caught it exactly this way.

## Ageing

Each invoice ages from its own date, not from the day it was entered here.

| Invoice | Customer | Date | Days old on 01-07-2026 | Band | Days old on 12-08-2026 | Band |
| --- | --- | --- | ---: | --- | ---: | --- |
| SI-0412 | Alpha Motors | 05-03-2026 | 118 | Over 90 days | 160 | Over 90 days |
| SI-0455 | Alpha Motors | 15-05-2026 | 47 | 31 to 60 days | 89 | 61 to 90 days |
| SI-0490 | Gamma Autos | 20-04-2026 | 72 | 61 to 90 days | 114 | Over 90 days |
| SI-0601 | Delta Stores | 20-06-2026 | 11 | 0 to 30 days | 53 | 31 to 60 days |

| Band | On 01-07-2026 | On 12-08-2026 |
| --- | ---: | ---: |
| 0 to 30 days | 1,500.75 | 0.00 |
| 31 to 60 days | 200.00 | 1,500.75 |
| 61 to 90 days | 40.00 | 200.00 |
| Over 90 days | 84,500.00 | 84,540.00 |
| Total | 86,240.75 | 86,240.75 |

## Assumptions

- Age is the plain number of days from the invoice's date to the day asked about.
- Nothing is received or invoiced between the two dates.
- Every balance is on its usual side: the bank is not overdrawn.

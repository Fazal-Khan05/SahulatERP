# Step 36 worked example: a half year's cash flow, and the owner's figures

**Checked by Claude, not by an accountant.** Every figure below was worked out here, then a second
time by an independent worker given only the journals and the rules, not these answers or the
software; both agree on every figure, and so does the test against the database
(`src/modules/reports/cash-flow-books.test.ts`).

## The journals, July to December 2026

Cash in hand and HBL are the cash and bank accounts; nothing was in them before July.

| | Day | Branch | Debit | Credit | Amount |
| --- | --- | --- | --- | --- | ---: |
| 1 | 5 Jul | Main | Cash in hand | Owner's capital | 500,000 |
| 2 | 10 Aug | City | Cash in hand | Sales | 200,000 |
| 3 | 1 Sep | City | Rent | Cash in hand | 30,000 |
| 4 | 10 Sep | Main | HBL | Cash in hand | 100,000 |
| 5 | 1 Oct | Main | Repairs 50,000 | HBL 45,000, Income tax withheld 5,000 | |
| 6 | 15 Oct | Main | HBL | Loans from banks | 300,000 |
| 7 | 1 Nov | Main | Office equipment | HBL | 80,000 |
| 8 | 31 Dec | none | Cost of goods sold | Other receivables | 120,000 |

## The cash flow, the whole company

| | |
| --- | ---: |
| Received from customers (journal 2) | 200,000 |
| Other receipts and payments (rent 30,000; repairs 45,000) | -75,000 |
| **Net cash from operating activities** | **125,000** |
| Fixed assets bought and sold (journal 7) | -80,000 |
| **Net cash from investing activities** | **-80,000** |
| Loans taken and repaid (journal 6) | 300,000 |
| Owners' capital and drawings (journal 1) | 500,000 |
| **Net cash from financing activities** | **800,000** |
| **Net change in cash and bank** | **845,000** |

The repairs are all money out on the expense, 45,000, the cash that left: the 5,000 withheld is
money out when it is paid to the government. Journal 4 moves money between cash and bank and adds
nothing; journal 8 moves none.

**The acceptance:** cash in hand closes at 570,000 (500,000 + 200,000 - 30,000 - 100,000) and HBL at
275,000 (100,000 - 45,000 + 300,000 - 80,000): 845,000 together, the net change.

## The City branch

Received from customers 200,000, other payments -30,000: **net change 170,000**, what City's cash
lines moved.

## The owner's figures

For the whole company: sales **200,000**; profit **nil** (200,000 less rent 30,000, repairs 50,000
and cost of goods sold 120,000); cash and bank **845,000**, all of it moved in the period. For the
City branch: sales **200,000**, profit **170,000** (the cost of goods sold has no branch).

Operating cash is 125,000 more than the profit: the 120,000 cost of goods sold moved no cash, and
the 5,000 withheld is not paid yet.

## The second working

The independent worker, given the eight journals and the statement's rules alone, found every
figure above: the lines, the three totals, 845,000 net and the two closing balances, City's 170,000,
and the owner's figures for the company and City.

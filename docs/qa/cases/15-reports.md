# 15 — Reports and CSV export (RPT)

Reports: Aged receivables, Customer/supplier statement, Sales analysis, Aged payables, Stock valuation, Stock movements, Profit & loss, Balance sheet, Trial balance, General ledger, Control reconciliation. Each has parameters and Export CSV.

| ID | P | T | Case | Expected |
|---|---|---|---|---|
| RPT-001 | P1 | F | Reports index lists all 11 reports | Yes |
| RPT-002 | P1 | F | Aged receivables default | Buckets current/1-30/31-60/61-90/90+ per customer; totals |
| RPT-003 | P1 | D | Aged total = receivable control | Equal |
| RPT-004 | P2 | F | Aged receivables as-of date in the past | Buckets recomputed for that date; receipts after date excluded |
| RPT-005 | P2 | E | As-of before any invoice | Empty with zero totals |
| RPT-006 | P2 | F | Walk-in customer in aging | One row "Walk-in customer" |
| RPT-007 | P2 | F | Archived customer with balance | Included |
| RPT-008 | P1 | F | Customer statement for a customer | Opening, each invoice/credit/receipt, running balance, closing |
| RPT-009 | P1 | D | Closing balance = customer outstanding | Equal |
| RPT-010 | P2 | F | Statement date range | Opening balance = prior activity |
| RPT-011 | P2 | F | Statement print | Branded; company header; period |
| RPT-012 | P2 | F | Supplier statement | Bills, returns, payments |
| RPT-013 | P2 | N | Statement without party selected | Prompt to choose; no crash |
| RPT-014 | P1 | F | Sales analysis by salesperson | Net, COGS, margin, commission per person |
| RPT-015 | P2 | F | Sales analysis by customer | Walk-in grouped under walk-in |
| RPT-016 | P2 | F | Sales analysis by item | Qty, net, margin |
| RPT-017 | P2 | F | Sales analysis date range | Filters by invoice date |
| RPT-018 | P2 | D | Sales analysis total = revenue in P&L for the range | Equal (net of credit notes) |
| RPT-019 | P2 | F | Aged payables | Buckets by bill due |
| RPT-020 | P2 | D | Aged payables total = payable control | Equal |
| RPT-021 | P1 | F | Stock valuation | Per item/warehouse qty, avg, value; total |
| RPT-022 | P1 | D | Valuation total = inventory control | Equal |
| RPT-023 | P2 | F | Stock movements with date range and item filter | Correct rows |
| RPT-024 | P1 | F | Profit & loss for a month | Revenue, COGS, gross profit, expenses, net |
| RPT-025 | P2 | F | P&L for a year | Sums months |
| RPT-026 | P2 | F | P&L empty range | Zeros |
| RPT-027 | P1 | F | Balance sheet as of date | Assets, liabilities, equity; difference 0 |
| RPT-028 | P2 | F | Balance sheet earlier date | Excludes later postings |
| RPT-029 | P1 | F | Trial balance | Every account with balance; totals equal |
| RPT-030 | P2 | F | General ledger per account with running balance | Correct |
| RPT-031 | P1 | F | Control reconciliation | Each control "reconciled" with ledger vs subledger figures |
| RPT-032 | P1 | D | Introduce a manual journal to 1100 | Reconciliation shows variance (not reconciled) |
| RPT-033 | P1 | F | Export CSV on every report | File downloads; headers; rows match screen |
| RPT-034 | P2 | E | Export with 10,000 rows | Completes; file size sane |
| RPT-035 | P2 | E | Export values with commas (Rs 1,234) | Raw numbers in CSV, not formatted strings (assert) |
| RPT-036 | P2 | E | Export Unicode names | UTF-8 |
| RPT-037 | P2 | E | Export empty report | Headers only |
| RPT-038 | P2 | F | Date pickers default to current month | Yes |
| RPT-039 | P2 | N | From date after to date | Swapped or validation; no crash |
| RPT-040 | P2 | E | Date far future | Empty |
| RPT-041 | P2 | S | Salesperson opens Reports | Limited set or hidden; no ledger reports |
| RPT-042 | P2 | S | Sales Manager sees sales reports, not P&L | Per role |
| RPT-043 | P2 | S | Auditor sees all | Yes |
| RPT-044 | P2 | S | Branch-limited Accountant: P&L | Not available or marked company-wide (journals not sent) |
| RPT-045 | P2 | F | Branch filter on operational reports | Works for stock/sales |
| RPT-046 | P2 | F | Report link from Overview "Needs attention" | Opens correct report |
| RPT-047 | P2 | U | Tables on phone | Horizontal scroll; totals visible |
| RPT-048 | P2 | U | Print a report | Clean print CSS |
| RPT-049 | P2 | F | Reports hidden module | Sidebar gone; Overview unaffected |
| RPT-050 | P2 | D | Aging after partial receipt | Remaining in original bucket |
| RPT-051 | P2 | D | Aging with credit note | Reduced |
| RPT-052 | P2 | D | Aging with overpayment (customer credit) | Negative shown in current or separate |
| RPT-053 | P2 | D | Statement with bounced cheque | Receipt and reversal lines |
| RPT-054 | P2 | D | Statement ordering by date then number | Stable |
| RPT-055 | P2 | D | Sales analysis margin after landed cost | Uses COGS actually posted |
| RPT-056 | P2 | D | Sales analysis excludes drafts/cancelled | Yes |
| RPT-057 | P2 | D | Stock movements sum = valuation delta | Yes |
| RPT-058 | P2 | D | P&L includes expense classification from imports | Yes |
| RPT-059 | P2 | D | P&L includes payroll | Yes |
| RPT-060 | P2 | D | P&L FX gains/losses | Yes |
| RPT-061 | P2 | D | Balance sheet includes cheques in hand (if asset) | Per design |
| RPT-062 | P2 | D | Balance sheet deposits (imports) | Yes |
| RPT-063 | P2 | D | Trial balance excludes zero accounts? | Consistent option |
| RPT-064 | P2 | D | GL running balance across date filter | Opening balance line |
| RPT-065 | P2 | F | Reconciliation after company reset | All zero reconciled |
| RPT-066 | P2 | F | Report parameters persist while switching tabs | Acceptable either way; no crash |
| RPT-067 | P2 | F | Reports keyboard accessible | Yes |
| RPT-068 | P2 | X | P&L on 100k journals | < 3 s |
| RPT-069 | P2 | X | Aging with 10k customers | < 3 s |
| RPT-070 | P2 | F | Customer statement for customer with no activity | "No activity" |
| RPT-071 | P2 | F | Supplier statement for walk-in supplier | Grouped |
| RPT-072 | P2 | F | Sales analysis by salesperson with splits | Each gets share |
| RPT-073 | P2 | F | Sales analysis "no salesperson" bucket | Present |
| RPT-074 | P2 | F | Export file name includes report and date | Yes |
| RPT-075 | P2 | F | Export CSV quoting of notes with newlines | Correct |
| RPT-076 | P2 | F | Report headings and currency label PKR | Yes |
| RPT-077 | P2 | F | Number formatting with tabular numerals | Yes |
| RPT-078 | P2 | F | Negative numbers formatting | `−` or `(…)` consistent |
| RPT-079 | P2 | F | Totals row sticky/bold | Yes |
| RPT-080 | P2 | F | Statement period with locked months | Works |
| RPT-081 | P2 | D | Aging vs statement consistency per customer | Equal closing |
| RPT-082 | P2 | D | Trial balance vs balance sheet + P&L | Consistent |
| RPT-083 | P2 | D | Reconciliation after bounce sequence | Reconciled |
| RPT-084 | P2 | D | Reconciliation after period reopen and reversal | Reconciled |
| RPT-085 | P2 | F | Reports in demo company | Match seeded data |
| RPT-086 | P2 | F | Reports with branch picker (2 branches) | Operational reports filter; ledger reports say company-wide |
| RPT-087 | P2 | S | Direct API export endpoint (if any) auth | 401 signed out |
| RPT-088 | P2 | U | Empty states text | Helpful, no jargon |
| RPT-089 | P2 | U | Report selector on phone | Dropdown/tabs usable |
| RPT-090 | P2 | F | Deep link to a report (if routed) | Opens |
| RPT-091 | P2 | F | Stock valuation includes archived items with stock | Yes |
| RPT-092 | P2 | F | Stock valuation excludes zero-stock items? | Consistent toggle |
| RPT-093 | P2 | F | Aged payables for USD bills | Shown in PKR at bill rate; currency column |
| RPT-094 | P2 | F | Statement for USD supplier | PKR amounts with FX lines |
| RPT-095 | P2 | F | Sales analysis by item with returns | Net of returns |
| RPT-096 | P2 | D | P&L month boundaries use Asia/Karachi dates | Invoice dated 2026-10-31 stays in October |
| RPT-097 | P2 | F | Report refresh after a new command in another tab | Reflects on next load |
| RPT-098 | P2 | F | CSV opens in Excel with correct columns | Yes |
| RPT-099 | P2 | F | Reports accessible screen-reader table headers | `th` scope |
| RPT-100 | P1 | F | End to end: after full trading cycle, every report reconciles to the ledger and to each other | All pass |

Covered by automation: `cash-bank-reports.spec.ts`, unit `reports.test.ts`.

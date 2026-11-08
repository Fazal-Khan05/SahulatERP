# 14 — Accounting: journals, reversals, periods, invariants (ACC)

Every posting is a balanced journal with a source id (unique). Manual journals allowed; operational journals cannot be reversed manually. Periods lock by month; only Owner reopens.

| ID | P | T | Case | Expected |
|---|---|---|---|---|
| ACC-001 | P1 | F | Accounting view: journals list newest first with number, date, memo, status | Yes |
| ACC-002 | P1 | F | Open a journal | Lines with account names, debit, credit; totals equal |
| ACC-003 | P1 | F | Trial balance tab | Debits = credits |
| ACC-004 | P1 | F | Create manual journal Dr 5300 100 / Cr cash 100 | "Balanced journal posted." |
| ACC-005 | P1 | N | Unbalanced journal | "Journal debits and credits must balance." |
| ACC-006 | P1 | N | Unknown account code | "Journal accounts and amounts must be valid." |
| ACC-007 | P1 | N | Line with both debit and credit | Same refusal |
| ACC-008 | P1 | N | Negative amount | Same |
| ACC-009 | P2 | N | One line only | Validation min 2 |
| ACC-010 | P2 | E | Lines with zero on both sides | Dropped; if nothing left, no journal posted |
| ACC-011 | P2 | E | 0.0001 amounts | Posted |
| ACC-012 | P2 | E | Memo empty | Allowed? assert; shows blank |
| ACC-013 | P2 | F | Journal with bank account code | Allowed (bank codes known) |
| ACC-014 | P1 | F | Reverse a manual journal | "Reversal · J-…" journal with swapped lines; reversalOf set |
| ACC-015 | P1 | N | Reverse twice | "Journal is already reversed." |
| ACC-016 | P1 | N | Reverse an invoice journal | "Use the source document's correction workflow for operational journals." |
| ACC-017 | P1 | N | Reverse an opening-balance journal | Same |
| ACC-018 | P2 | N | Reverse a receipt journal | Same |
| ACC-019 | P2 | F | Reverse with custom date | Dated accordingly; period check |
| ACC-020 | P1 | F | Lock period 2026-09 | "Period locked." |
| ACC-021 | P1 | N | Post anything dated 2026-09 | "Accounting period 2026-09 is locked." |
| ACC-022 | P1 | N | Accountant reopens | "Only the owner can reopen an accounting period." |
| ACC-023 | P1 | F | Owner reopens | "Period reopened." |
| ACC-024 | P2 | N | Lock month `2026-00` | Validation |
| ACC-025 | P2 | F | Lock current month, create invoice today | Refused |
| ACC-026 | P2 | F | Lock future month | Allowed; postings there refused |
| ACC-027 | P2 | F | Lock, then view reports for that month | Allowed |
| ACC-028 | P2 | F | Lock then submit draft dated in it | Refused; change date to open month → works |
| ACC-029 | P2 | S | Salesperson sets period | Refused |
| ACC-030 | P1 | D | Source uniqueness: post same source twice | "This source has already been posted." |
| ACC-031 | P1 | D | Every document submit yields exactly one journal | Checked across SAL/PUR/COL |
| ACC-032 | P1 | D | Posted journal immutable | No edit UI; API has no update |
| ACC-033 | P1 | D | Journal numbering sequential | J-2026-0001… |
| ACC-034 | P2 | D | Journal number gap after failed command | None (atomic) |
| ACC-035 | P1 | D | Receivable control = sum open customer balances | Reconciled |
| ACC-036 | P1 | D | Payable control = open supplier balances | Reconciled |
| ACC-037 | P1 | D | Inventory control = stock valuation | Reconciled |
| ACC-038 | P1 | D | Cash/bank control = account balances | Reconciled |
| ACC-039 | P1 | D | Commission payable = earned − paid | Reconciled |
| ACC-040 | P1 | D | Output tax = sum invoice tax − credit note tax | Reconciled |
| ACC-041 | P2 | D | Input tax = bills tax − returns | Reconciled |
| ACC-042 | P2 | D | Balance sheet: assets − liabilities − equity = 0 | Exactly 0 |
| ACC-043 | P2 | D | P&L net = revenue − COGS − expenses | Matches ledger |
| ACC-044 | P2 | D | Retained earnings / current-year profit on balance sheet | Equals P&L |
| ACC-045 | P2 | D | General ledger per account running balance | Correct |
| ACC-046 | P2 | F | Account names table complete (every code used has a name) | Yes |
| ACC-047 | P2 | F | Manual journal in locked period | Refused |
| ACC-048 | P2 | F | Manual journal to control accounts (1100/2000/1200) | Allowed? If allowed, reconciliation shows variance — assert design |
| ACC-049 | P2 | S | Auditor creates journal | Refused |
| ACC-050 | P2 | S | Accountant creates/reverses | Allowed |
| ACC-051 | P2 | S | Sales Manager sees Accounting | Hidden; journals not sent |
| ACC-052 | P2 | S | Branch-limited Owner sees journals | Not sent (company-wide) — per access rule |
| ACC-053 | P2 | F | Journal search by memo/number | Works |
| ACC-054 | P2 | F | Filter by date range | Works |
| ACC-055 | P2 | F | Journal print/export | CSV if present |
| ACC-056 | P2 | D | Rounding: 3 lines of 33.3333 vs 100 | Journal balanced to 4 dp by allocation |
| ACC-057 | P2 | D | FX gain/loss postings balance | Yes |
| ACC-058 | P2 | D | Landed cost postings balance | Yes |
| ACC-059 | P2 | D | Payroll postings balance | Yes |
| ACC-060 | P2 | D | Bounce reversal exact | Yes |
| ACC-061 | P2 | D | Opening balance journal (3000) for opening stock | Yes |
| ACC-062 | P2 | D | Count correction to 5300 | Yes |
| ACC-063 | P2 | D | Stock transfer no journal | Yes |
| ACC-064 | P2 | D | Cancelled draft no journal | Yes |
| ACC-065 | P2 | D | Quotation/order submit no journal | Yes |
| ACC-066 | P2 | D | Delivery journal COGS only | Yes |
| ACC-067 | P2 | D | Invoice from delivery no COGS | Yes |
| ACC-068 | P2 | D | Direct invoice COGS + revenue | Yes |
| ACC-069 | P2 | D | Credit note reverses proportionally | Yes |
| ACC-070 | P2 | D | Supplier return reverses | Yes |
| ACC-071 | P2 | D | Expense journal | Yes |
| ACC-072 | P2 | D | Transfer journal | Yes |
| ACC-073 | P2 | D | Receipt journal | Yes |
| ACC-074 | P2 | D | Cheque clear journal | Yes |
| ACC-075 | P2 | D | Commission accrual journal | Yes |
| ACC-076 | P2 | D | Allocation journal | Yes |
| ACC-077 | P2 | F | Period list shows locked months | Yes |
| ACC-078 | P2 | F | Lock then unlock then lock | State correct |
| ACC-079 | P2 | F | Audit entries for period changes | Yes |
| ACC-080 | P1 | D | Invariant sweep after full trading cycle (SAL-100, PUR-100, COL-100, COM-100, PAY-100) | All controls reconciled; trial balance balanced |
| ACC-081 | P1 | D | Invariant sweep after 100 random valid commands (fuzz) | Still balanced and reconciled |
| ACC-082 | P1 | D | Invariant sweep after retries/duplicates (idempotency keys reused) | No duplicate journals |
| ACC-083 | P2 | D | Journals dated out of order | Trial balance by date filter correct |
| ACC-084 | P2 | D | Year boundary: invoice 2026-12-31 and 2027-01-01 | Numbering resets per year; P&L per year |
| ACC-085 | P2 | D | Database projection: journals table = snapshot journals | `private.sync_projection` consistent (count/sums) |
| ACC-086 | P2 | D | Projection rebuild (`p_rebuild=true`) idempotent | Same rows |
| ACC-087 | P2 | D | `commit_workspace` rejects unbalanced? | Snapshot-level: engine guarantees; DB CHECK not cross-line (documented) |
| ACC-088 | P2 | D | Snapshot revision conflict (expected revision stale) | Commit refused; client retries with fresh state |
| ACC-089 | P2 | F | Accounting hidden? | Not toggleable (always on) |
| ACC-090 | P2 | U | Journal detail on phone | Readable |
| ACC-091 | P2 | U | Debit/credit columns aligned, tabular numerals | Yes |
| ACC-092 | P2 | F | Export trial balance CSV | Balanced totals row |
| ACC-093 | P2 | E | Memo 2,000 chars | Saved/truncated consistently |
| ACC-094 | P2 | E | Journal with 200 lines | Posted |
| ACC-095 | P2 | X | 100,000 journal lines | Trial balance < 3 s |
| ACC-096 | P2 | F | Reversal appears linked from original | Yes |
| ACC-097 | P2 | F | Attempt manual journal on 1100 to "fix" a customer balance | Allowed but reconciliation flags variance (assert) |
| ACC-098 | P2 | F | Period lock blocks cheque clear dated inside | Yes |
| ACC-099 | P2 | F | Period lock blocks payroll pay dated inside | Yes |
| ACC-100 | P1 | F | End to end: close month (lock), owner reopens for correction, reversal, re-lock; reports consistent | All pass |

Covered by automation: unit `database.test.ts` (migrations, RLS, commit), `reports.test.ts`, `fixes.test.ts`; `cash-bank-reports.spec.ts`.

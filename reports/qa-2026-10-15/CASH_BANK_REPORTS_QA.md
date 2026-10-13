# Cash & bank and reports — QA record

**Date:** 15 October 2026 · **Scope:** [plan](../../docs/plans/2026-10-15-cash-bank-reports.md) (backlog T06 UI, reports)

## Result

| Check | Result |
| --- | --- |
| `npm run typecheck`, `npm run build` | Pass |
| `npm test` — 74 tests (9 new in `reports.test.ts`) | Pass |
| `cash-bank-reports.spec.ts` on the QA tenant | Pass |
| All other Playwright suites | Pass; demo unchanged |

## Verified in the browser

- Cash & bank module: provisioned "Main bank account" and "Cash in hand"; a new petty-cash account gets ledger code 1003.
- A cash receipt of 4,000 posts into the chosen account; a 6,000 cheque is recorded, deposited into the main bank account from the cheque register, and cleared there. Balances update on the Cash & bank screen.
- Transfer bank → petty cash and a petty expense ("Courier") post balanced journals and appear in the account's activity list with a running balance.
- Reports: aged receivables with bucket totals; customer statement whose closing balance is zero after the two receipts; profit & loss; balance sheet with zero difference; control reconciliation shows bank & cash reconciled; trial balance exported to CSV with the new account codes.

## Reconciliation notes

- Aged receivables show unapplied customer credits as negatives in Current so the total ties to the AR control.
- The AP control includes import charges allocated to landed cost that have no supplier bill; the reconciliation row labels and includes them (`landedCostPayable`).
- The pre-existing single ledger account 1000 is shown as "Bank & cash (legacy)" only while it has a balance.

## Deferred

Bank statement import/reconciliation (out of scope by decision), cheque printing, multi-currency accounts, budgets.

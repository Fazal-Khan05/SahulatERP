# SahulatERP — SQA Master Test Plan

Written 14 October 2026 for the current product on `main` (violet theme, blurred-backdrop setup, one-step submit, optional customer save, opening stock on products).

## 1. Purpose

A complete, executable set of manual and automatable test cases for every feature in the product, from the happy path down to the absurd ("type an emoji as a price", "submit twice while offline", "sell 0.0001 of a kilo"). Each feature file holds at least 100 numbered cases. The pack is the acceptance gate for every release and the source for automation tickets.

## 2. Scope

| Area | File | Cases |
|---|---|---|
| Sign-in, password reset, sessions | [01-auth.md](cases/01-auth.md) | AUTH-001…100 |
| Onboarding wizard and provisioning | [02-onboarding.md](cases/02-onboarding.md) | ONB-001…100 |
| Settings: company, documents, features, access | [03-settings.md](cases/03-settings.md) | SET-001…100 |
| Products, opening stock, CSV import/export | [04-products.md](cases/04-products.md) | PRD-001…100 |
| Customers and suppliers, walk-in, credit limits | [05-parties.md](cases/05-parties.md) | PTY-001…100 |
| Inventory: stock, transfers, corrections, warehouses | [06-inventory.md](cases/06-inventory.md) | INV-001…100 |
| Sales documents and the invoice editor | [07-sales.md](cases/07-sales.md) | SAL-001…100 |
| Purchasing, foreign currency, supplier payments | [08-purchasing.md](cases/08-purchasing.md) | PUR-001…100 |
| Imports and landed cost | [09-imports.md](cases/09-imports.md) | IMP-001…100 |
| Collections: receipts, cheques, follow-ups | [10-collections.md](cases/10-collections.md) | COL-001…100 |
| Cash and bank | [11-cash-bank.md](cases/11-cash-bank.md) | CSH-001…100 |
| Commissions | [12-commissions.md](cases/12-commissions.md) | COM-001…100 |
| Payroll | [13-payroll.md](cases/13-payroll.md) | PAY-001…100 |
| Accounting: journals, periods, invariants | [14-accounting.md](cases/14-accounting.md) | ACC-001…100 |
| Reports and CSV export | [15-reports.md](cases/15-reports.md) | RPT-001…100 |
| Printing, PDF and document view | [16-printing.md](cases/16-printing.md) | PRN-001…100 |
| Shell: navigation, search, notifications, overview | [17-shell.md](cases/17-shell.md) | NAV-001…100 |
| Security, tenancy, roles, API | [18-security.md](cases/18-security.md) | SEC-001…100 |
| Responsive, mobile, accessibility, motion | [19-ui-accessibility.md](cases/19-ui-accessibility.md) | UIX-001…100 |
| Data integrity, concurrency, failure recovery | [20-data-integrity.md](cases/20-data-integrity.md) | DAT-001…100 |

Out of scope: FBR e-invoicing (dropped from product scope), real bank feeds, real customs lookups (simulated), email delivery of reset links beyond "link arrives".

## 3. Case format

Every case is one table row:

| Column | Meaning |
|---|---|
| ID | `PREFIX-NNN`, stable; never renumber, add at the end |
| P | Priority: **P1** blocks release, **P2** must pass before demo/partner use, **P3** should pass, **P4** cosmetic/low |
| T | Type: **F** functional, **N** negative/validation, **E** edge/boundary, **S** security/permission, **U** UI/UX, **D** data integrity/accounting invariant, **X** performance/limits |
| Case | Preconditions, action and data in one line |
| Expected | Observable result. "Refused: …" means the exact message shown to the user |

Validation messages quoted in Expected are the product's real strings (from the engine), so a test fails if the wording changes.

## 4. Environments and data

- **Local**: `npm run dev` against hosted Supabase, QA tenant `33333333-3333-4333-8333-333333333333`, reset with `npm run qa:tenant`. Owner credentials from `.env.local`.
- **Production**: https://sahulaterp.vercel.app with the demo account's company, reset with `MEMBER_EMAIL=<email> npm run company:reset`. Never test against the Design Partner company.
- **Roles**: Owner, Accountant, Sales Manager, Salesperson, Recovery Officer, Warehouse Manager, Payroll Administrator, Auditor. Role cases are run through "View as role" on a demo company and through real memberships created with `npm run member:create`.
- **Devices**: Chrome and Safari desktop at 1440×900; iPhone (Safari) and Android (Chrome) at 390×844; iPad at 820×1180. Emulation is acceptable for layout only; tap, keyboard, safe-area and overscroll cases need hardware.
- **Fixtures**: synthetic only. No partner data, no real CNICs or salaries.

## 5. Execution order

1. SEC smoke (tenant isolation, role gating) and AUTH.
2. ONB on a fresh tenant, then SET.
3. Master data (PRD, PTY, INV) to seed the trading cases.
4. Trading cycle SAL → PUR → IMP → COL → CSH.
5. COM → PAY → ACC → RPT (they depend on the cycle above).
6. PRN, NAV, UIX, DAT across the data built so far.

Automated suites already cover a thread through each area (`npm run test` 77 unit tests, `npm run test:e2e` six Playwright suites). Cases marked P1 that are not yet automated are the automation backlog.

## 6. Entry and exit criteria

- **Entry**: build green, migrations applied, QA tenant reset, test accounts for every role exist.
- **Exit for a release**: 100% of P1 pass, ≥95% of P2 pass with no open P2 defect in money, stock, tenancy or permissions, all accounting invariants (ACC-080…100, DAT-001…030) pass.
- **Defect severity**: S1 wrong money/stock/permission or data loss; S2 feature unusable with no workaround; S3 workaround exists; S4 cosmetic.

## 7. Invariants checked throughout

These are asserted after every trading case, not just in ACC:

- Trial balance: total debits = total credits, every posted journal balanced.
- Control reconciliation: receivable control = sum of open customer balances; payable control = open supplier balances; inventory control = stock valuation; cash/bank control = account balances.
- Stock quantity per warehouse ≥ 0; a submitted delivery or direct invoice moves exactly its lines' quantities.
- Commission: earned ≥ released ≥ paid for every entitlement; released only grows when customer cash clears.
- Posted documents and journals are immutable; corrections are new documents or reversals.
- Every command is idempotent for its key: a retry never duplicates a document, movement or journal.

## 8. Traceability

Each feature file ends with a "Covered by automation" note listing the spec names that already exercise its P1 cases. Defects reference the case ID. New behaviour must add cases before the PR merges.

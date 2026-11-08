# SahulatERP — Implementation Backlog

Prepared 24 September 2026 and updated 25 September 2026. A production-shaped prototype now covers the application foundation and synthetic end-to-end trading workflows. Discovery, partner validation, regulatory certification, live adapters, recovery rehearsal and commercial launch gates remain open. [EXECUTION-PLAN.md](EXECUTION-PLAN.md) defines the broader product gates.

> **Scope update, 27 September 2026:** FBR integration and its simulator are deferred by the founder. Any FBR tasks below are historical candidates, not active backlog items. Invoice tax amounts and accounting remain in scope.

## 1. Discovery

| ID | Task | Owner | Dependency | Done when |
|---|---|---|---|---|
| D01 | Confirm capacity/runway/constraints | Founder | — | Weekly hours and approved spending envelope recorded |
| D02 | Identify incumbent and observe operations | Founder + partner | Access | Purchasing, sales, collections, commission, payroll and close mapped |
| D03 | Name partner decision makers | Founder + partner | — | Reviewers and meeting cadence agreed |
| D04 | Agree data use and collect exports | Founder + partner | D02, D03 | Protected source data, dates and export instructions recorded |
| D05 | Commission rulebook with exceptions | Founder + sales lead | D04 | Inputs, expected amounts, dates and approver for every rule |
| D06 | Reference dataset/reconciliation | Founder + accountant | D04, D05 | Three usable months; source discrepancies explained |
| D07 | Five additional customer interviews | Founder | Interview guide | Workflow/price evidence recorded without universal claims |
| D08 | ~~Compliance matrix/integrator route~~ **Closed 13 Oct 2026: FBR invoicing out of scope** | Founder | — | Sales-tax bookkeeping only; no FBR submission |
| D09 | Release scope/commercial pilot | Founder + partner | D01–D08 | Profile, exclusions, acceptance and proposed terms recorded |
| D10 | Domain/schema/posting review | Founder + reviewers | D05, D06, D09 | Ownership, states and financial effects understood; G0 passed |

Interview prompts: show the last commission dispute, a partially paid/returned invoice, a late import-cost adjustment and month-end workarounds. Identify the buying decision maker. Measure time/cost and switching objections. Request examples instead of asking whether the idea sounds good.

## 2. Foundations and commission

| ID | Task | Dependency | Acceptance |
|---|---|---|---|
| F01 | Git, scaffold, locked dependencies, CI | D10 | Reproducible setup; actual build/lint/test commands documented |
| F02 | Environments/secrets | F01 | Staging cannot use production credentials or issue real invoices |
| F03 | Tenants/memberships/company/roles | D10, F02 | Tenant and role-denial tests cover database/files/API |
| F04 | Decimal primitives/rounding | D06, F01 | Fractional quantities/rates and serialization verified |
| F05 | Accounts/periods/posting service | F03, F04 | Balanced atomic posting, reversal and lock concurrency tests |
| F06 | Audit/jobs/outbox/monitoring | F03, F05 | Repeated jobs have one local effect; failures actionable |
| F07 | Backup/restore rehearsal | F02, F05 | Isolated database/file recovery demonstrated |
| F08 | ~~FBR sandbox contract exercise~~ **Closed 13 Oct 2026: out of scope** | — | — |
| F09 | Foundation review | F03–F08 | G1 passed; unresolved external issues explicitly tracked |
| C01 | Historical invoice/receipt/return import | D06, F09 | Source IDs/checksums, preview and repeat-safe commit |
| C02 | Versioned plans/assignments/hierarchy | D05, C01 | Historical beneficiaries/rates reproducible |
| C03 | Entitlement/movement calculations | C02, F04, F05 | Partial release/reversal/payout reconcile and explain |
| C04 | Review/adjustment approvals/statements | C03, F03 | Unauthorized changes rejected; reason/provenance retained |
| C05 | Partner reference replay | C04 | G2 passed; rule owners resolve discrepancies |

Historical imports call the same domain operations later used by sales/collections. They are internal validation tooling, not a separately launched product or throwaway architecture.

## 3. Connected ERP

| ID | Task | Dependency | Acceptance |
|---|---|---|---|
| T00 | **Built 14 Oct 2026** — onboarding wizard, module toggles, branding, printable documents — [plan](docs/plans/2026-10-13-onboarding-modules-branding.md), [QA](reports/qa-2026-10-14/ONBOARDING_MODULES_QA.md) | F03 | Owner reaches a branded printable invoice unaided; disabled modules unreachable everywhere; FBR and bank-reconciliation code removed |
| T01 | **Built 14 Oct 2026** — customers, suppliers, products, employees, warehouses and plans screens; archive; CSV import/export — [plan](docs/plans/2026-10-14-master-data.md), [QA](reports/qa-2026-10-14/MASTER_DATA_QA.md). Units of measure and price lists deferred. | F09 | Imports validate identifiers and ownership; all-or-nothing with row-numbered errors |
| T02 | **Built 15 Oct 2026** — PO → GRN → bill with partial receipts, supplier payments with multi-bill allocation and FX difference — [plan](docs/plans/2026-10-15-document-cycles.md), [QA](reports/qa-2026-10-15/DOCUMENT_CYCLES_QA.md) | T01, F05 | Partial receipts/bills and AP/postings reconcile |
| T03 | Stock/reservations/costing/transfers/counts | T02 | Quantity/value, negative-stock and concurrency checks |
| T04 | **Built 15 Oct 2026** — quotation → order → partial deliveries → invoices, multi-line editor, draft edit/cancel, receipts allocated across invoices — [plan](docs/plans/2026-10-15-document-cycles.md) | T03 | Local state and postings agree; printable via the standard template |
| T05 | **Built 15 Oct 2026 (UI)** — return dialog for invoices and bills; over-return refused | T04 | Original quantity/cost/tax references; no over-return |
| T06 | **Built 15 Oct 2026 (UI)** — PDC register with deposit/clear/bounce, receipts into named bank/cash accounts, multi-invoice allocation — [plan](docs/plans/2026-10-15-cash-bank-reports.md), [QA](reports/qa-2026-10-15/CASH_BANK_REPORTS_QA.md) | T04, F03 | Partial allocation and bounce handled; overrides attributable |
| T07 | Trading-to-commission connection | C05, T05, T06 | One event has one effect; G3 passed |
| I01 | FX bills/payment/revaluation | T02, F05 | Accountant-approved realized/unrealized FX cases |
| I02 | Shipment/GD/classified costs | T03, I01 | Cost versus recoverable/expense/deposit reviewed |
| I03 | Cost allocation/finalization/late adjustment | I02 | Cost-pool totals and sold/unsold portions reconcile; G4a passed |
| X01 | Approved effective-dated tax rules (bookkeeping only, no FBR submission) | T04, I02 | Applicable/exempt cases and status snapshots validated |
| X02 | ~~Production FBR adapter/state machine~~ **Closed 13 Oct 2026: out of scope** | — | — |
| X03 | Invoice outputs/correction procedures | X02, T05 | Required fields and correction scenarios accepted |
| X04 | Tax workpapers/exports/reconciliation | X03, I03 | Accountant completes current-format rehearsal; G4b passed |
| P01 | Employees/salaries/attendance | F03, F04 | Effective dates and access boundaries verified |
| P02 | Applicable statutory payroll | P01 | Reviewed payroll, adjustments and historical reruns match |
| P03 | Commission/payroll approval/payslip/export | P02, T07 | No payout enters two payrolls; GL/liabilities reconcile; G4c passed |
| R01 | ~~Bank-statement import/reconciliation~~ **Closed 13 Oct 2026: out of scope.** Cash & bank accounts, transfers, expenses and the cheque register were built 15 Oct 2026 instead — [QA](reports/qa-2026-10-15/CASH_BANK_REPORTS_QA.md) | — | — |
| R02 | Financial/operating reports/close — **reports built 15 Oct 2026** (aged AR/AP, statements, stock valuation/movements, sales analysis, P&L, balance sheet, trial balance, general ledger, reconciliation, CSV/print); period close and tax controls remain | I03, X04, P03 | Subledgers and tax controls reconcile to GL |
| R03 | Migration/billing/support/export tooling | R02 | Standard onboarding rehearsal, safe migration; G5 passed |

The accounting posting map must prevent double recognition of commission expense when transferring an existing accrued liability into payroll.

## 4. Production and launch

| ID | Task | Dependency | Acceptance |
|---|---|---|---|
| L01 | Independent money/security/recovery review | R03 | Critical findings fixed/retested; recovery targets demonstrated |
| L02 | Opening-data rehearsal/source-of-truth register | L01 | Trial balance, open items, stock, cheques and liabilities accepted |
| L03 | Training/controlled cutover | L02 | Named issuers/support/recovery; no duplicate FBR issuance |
| L04 | At least three months of partner operations | L03 | Three monthly closes and at least two payout cycles accepted |
| L05 | Second/third paying customers | Stable L04 operations | Standard configuration/migration; no bespoke fork |
| L06 | Public-release review | L04, L05 | G6 passed; scope/pricing/support/limitations/evidence agree |

## 5. Regression scenarios

| Scenario | Invariant |
|---|---|
| Cross-tenant read/write/reference/file/export | No tenant obtains/modifies another's data |
| Repeated posting/job/double click | One operation creates one local effect |
| Concurrent sale of final units | No duplicate stock issue |
| Partial delivery/bill/payment | Remaining quantity and balance traceable |
| Double or excessive receipt allocation | Over-allocation rejected under concurrency |
| Cheque received then bounced | Collection/release follows approved cleared-funds policy |
| Historical rule/hierarchy change | Original entitlement reproducible |
| Partial return after payout | Earned, unreleased, unpaid and recoverable reconcile |
| FBR accepted but response lost | Reconciliation before unsafe resubmission |
| Late landed cost after partial sale | Inventory plus COGS equals approved adjustment |
| Commission transferred into payroll | No double expense or payment |
| Locked period/correction | History preserved and authorization recorded |
| Restored database/attachments | Balances/documents and recovery targets verified |
| Replayed migration | No duplicate balances or historical FBR submissions |
| Commission released after an earlier payroll paid part of it | Later release is payable in a new run (`tests/domain/fixes.test.ts`) |
| Cheque bounces after its commission was paid | Overpayment recovered through payroll; payable equals earned less paid |
| Late landed cost after a transfer | Cost follows the transferred units, not COGS |
| Unbalanced or rewritten journal reaches the database | Whole save, snapshot included, rolls back (`tests/domain/database.test.ts`) |

## 6. Prototype status note (12 October 2026)

The prototype re-test is in `reports/qa-2026-10-12/`. All 17 findings from 29 September plus 5 scan findings are fixed; open items there need founder or reviewer decisions, not code:

- **Persistence model (affects F03/F05):** saves are now atomic (snapshot and relational projection in one transaction, migration `202610120001`), but the JSON snapshot is still the source of truth and the server reads it with the service-role key after an explicit membership check. CLAUDE.md requirement 4 wants ordinary runtime queries off that key. Moving to normalized tables as the source of truth, with a restricted database role, needs the D10 schema/posting review first.
- **Commission target multiplier (C02/C03):** once a target is crossed, the multiplier applies to the whole line, not only the amount above target. Confirm against reviewed partner examples (D05).
- **Salesperson accounts:** `memberships.employee_id` must be set for a salesperson to see or create their own sales.

## 7. Execution discipline

Before implementation identify actor, input/output, postings, authorization, failures and approved numerical examples. Review schema/migration. Build the complete slice, verify its criteria, demonstrate it with reference data and retain evidence before marking done.

Keep one primary active item. Split work that cannot reach a reviewable result in roughly a week while preserving end-to-end criteria. Re-estimate when assumptions fail. Generated code or a rendered screen does not establish completion.

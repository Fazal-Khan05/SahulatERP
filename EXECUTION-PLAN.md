# SahulatERP — Product and Execution Plan

Prepared 24 September 2026. Planning baseline v1.

**Founder direction:** prioritize a complete product over a fixed launch date. The December 2026 launch deadline is retired. This plan replaces the earlier delivery sequence and proposed release scope; the September 22 research remains background material.

**Scope update, 27 September 2026:** the founder has deferred the FBR module and integration. The live prototype must not show an FBR section or create submission simulations. Earlier FBR requirements below are retained as historical planning notes and are not in the current development scope. Ordinary invoice tax amounts and accounting remain in scope.

**Recommendation:** build a complete ERP for Pakistani importer-distributors with sales teams. Prove commission calculations early, then complete accounting, inventory, purchasing, imports, collections, payroll and compliance around them. Release publicly after controlled customer operation and repeatable onboarding.

“Complete” means the agreed target business can run its normal operations and month-end close in SahulatERP. It does not mean supporting every industry or exception in Pakistan. Required exports to banks, accountants and government portals are part of a complete workflow; rebuilding calculations manually in spreadsheets is not.

## 1. Product promise and customer

**Promise:** know what stock actually cost, what customers owe, what each salesperson earned, and whether the business records reconcile.

The initial buyer is an owner or finance manager of an importer-distributor selling goods through a sales team. The design partner is the first source of requirements, but five other businesses must be interviewed before its unusual practices become general product features.

Primary users: owner, accountant, purchasing/warehouse operator, sales manager, recovery staff and payroll administrator. Begin with desktop-oriented workflows and responsive viewing/approval on phones. An offline field-sales app is a later product surface.

Evidence available: the founder reports a committed partner with commission and invoicing pain. Missing evidence: actual source exports, agreed calculations, volumes, willingness to pay a specific price and independently verified competitor capabilities. Treat “no competitor does this” as an unproven hypothesis. Demonstrate a superior workflow without making that claim.

## 2. First complete release

Initial supported profile: a Pakistani trading company, PKR base currency, foreign-currency purchasing where needed, multiple branches/warehouses and an agreed set of goods and tax treatments. Support one legal company per tenant initially; include company ownership in the domain model so companies are not conflated with branches. Validate this restriction during discovery.

| Area | Required capability | Boundary |
|---|---|---|
| Organization/access | Company, branches, warehouses, invitations, memberships, permissions, approvals, audit history, fiscal periods | Managed onboarding; no general workflow designer |
| Accounting | Chart of accounts, opening balances, posting engine, AR/AP, journals, cash/bank books, bank-statement import/reconciliation, trial balance, P&L, balance sheet, close/reopen | Accountant-reviewed templates and accounting policies |
| Parties/products | Customers/suppliers, tax identities, credit terms, categories, units/conversions, price lists, HS/PCT mapping | Batch/expiry if selected launch goods require it |
| Sales | Quote/order, dispatch, invoice, discounts, partial fulfilment, receipt/allocation, return/adjustment, printable documents | No retail till hardware or loyalty engine |
| Purchasing | Purchase order, partial receipt, supplier bill/return, payment/allocation, outstanding balances | Domestic and required foreign purchase currencies |
| Inventory | Receipts, issues, transfers, counts, adjustments, reservations, valuation, stock/ledger reconciliation | One approved costing method; block negative stock initially |
| Imports | Shipment, multiple purchase/receipt lines, GD references, charges, allocation per cost line, provisional/final cost, late adjustments, FX settlement | GD capture/import; direct PSW/WeBOC access requires separate verification |
| Collections | Credit limits/authorized overrides, ageing, statements, follow-up notes, PDC received/deposited/cleared/bounced | Commission release follows agreed cleared-funds policy |
| Commissions | Effective-dated hierarchy/plans, category/customer rules, splits, agreed slabs/targets, accrual, partial release, approval, returns/bad-debt adjustments, per-amount explanation | Confirmed plan types; no arbitrary user scripting |
| Payroll | Employees, attendance import/manual exceptions, salaries, allowances/deductions, commission, applicable statutes, payslips, journal, payment export | No recruitment suite or biometric integration |
| Tax/FBR | Supported goods rules, invoice data, integrator onboarding, submission/reconciliation, correction flows, reviewed return workpapers/exports | No promise of automatic filing or undocumented portal APIs |
| Reporting | Cash/bank, customer/supplier balances, margin, stock ageing, shipment cost, sales/collections, commission and payroll liabilities, tax reconciliation | Useful fixed reports before a custom report builder |
| SaaS operations | Subscription records/manual billing, customer export, backups/restore, monitoring, support, deployment/migrations | Payment-gateway automation can follow paying customers |

Defer manufacturing, restaurant workflows, retail hardware, offline order booking, multi-company consolidation, provincial service-tax integrations, e-commerce and a full fixed-asset register. Opening balances and reviewed journals can accommodate existing asset/depreciation balances. If discovery establishes a deferral as essential to the selected customer, change the scope and estimate explicitly.

## 3. Workflows that define completion

| Workflow | End-to-end result |
|---|---|
| Import to profit | Foreign PO → shipment/partial receipt → bill and classified charges → inventory cost → sale → correct margin → settlement FX |
| Sale to collection | Order → dispatch/invoice in agreed sequence → applicable FBR processing → receivable → partial receipts → balance and credit availability |
| Sale to pay | Invoice line → employee/plan snapshot → accrual → cleared receipt allocation → release → approval → payroll/payable → payment |
| Return after payout | Original sale reference → stock/tax/accounting adjustments → commission adjustment → recoverable balance or future offset under approved policy |
| Month-end close | Bank, AR, AP, stock, commission, payroll and tax reconciliations → reviewed financial reports → locked period |
| New customer | Standard template → validated opening data → reconciled balances → training → cutover without customer-specific code |

These workflows are acceptance tests. Functioning screens alone do not establish completion.

## 4. First four weeks

Proposed start: 28 September 2026. Founder coordinates; partner accountant and sales manager validate outcomes. Their availability is not yet confirmed.

| Week | Work | Output and exit condition |
|---|---|---|
| Sep 28–Oct 4 | Observe purchasing, sale, recovery, commission and payroll. Identify incumbent/export capabilities. Confirm founder capacity and budget. | Workflow map, named decision makers, sample exports, problem priorities |
| Oct 5–11 | Obtain three months of invoices/lines, receipts/allocations, returns, payouts, balances, stock, GDs and payroll. Resolve source discrepancies. | Protected reference dataset, expected results and commission rulebook |
| Oct 12–18 | Interview five other businesses. Validate goods/taxes and payroll with a Pakistani accountant. Begin integrator access/sandbox setup. | Evidence log, assigned legal/API questions, scope baseline and proposed offer |
| Oct 19–25 | Review domain boundaries, postings, role matrix, preliminary schema and wireframes. Re-estimate from actual data. | G0 decision, backlog and human-reviewed schema proposal |

Raw CNICs, salaries, credentials and customer exports stay outside Git. Keep protected originals separately and redacted/synthetic test fixtures in the codebase. Document partner data permissions and retention.

The commission rulebook must answer: invoice versus collection basis; treatment of tax, freight and discounts; partial allocation; cleared versus received cheques; hierarchy dates; splits; target periods; marginal versus retroactive tiers; returns after payout; bad debt; employee departure; rounding; manual adjustments; and dispute authority. Unanswered rules are decisions to obtain, not developer guesses.

## 5. Delivery sequence, effort and schedule

This is a forecast, not a deadline commitment. Estimates include AI-assisted implementation, review and verification for the selected vertical product.

**Capacity assumption:** 30 founder hours/week: 22.5 planned delivery hours and 7.5 for coordination, learning, operations and interruptions. Reforecast if availability differs. Specialist review and customer waiting time are additional constraints. Do not promise dates until discovery and foundations establish actual throughput.

| Stage | Effort | Work/dependency | Exit |
|---|---:|---|---|
| 0. Discovery | 60–100 h | Real rules/data, business validation, access | G0: business and scope understood |
| 1. Foundation/posting | 160–240 h | Git/CI/environments; auth/RLS; roles; money; journals/periods/audit; basic parties/items | G1: tenancy and accounting invariants proven |
| 2. Commission proof/module | 100–160 h | Historical events; calculation/explanation/approval on permanent domain model | G2: reviewed commissions reproduced |
| 3. Trading/stock | 220–320 h | Sales, purchasing, receipts, returns, stock, cash/bank, AR/AP, collections; connect commission | G3: trading cycle reconciles |
| 4. Imports/currency | 140–220 h | Shipment costing, GD capture, adjustments, settlement/revaluation | G4a: representative import closes |
| 5. Tax/FBR/returns | 180–280 h | Adapter, error/timeout reconciliation, goods rules, corrections, workpapers/exports | G4b: compliance scenarios accepted |
| 6. Payroll | 120–180 h | Salary/attendance, statutes, commission transfer, approvals, journals/payment export | G4c: payroll matches reviewed expectations |
| 7. Complete-product beta | 120–180 h | Reports, bank reconciliation polish, migration, usability, support, subscriptions, docs | G5: rehearsal close/cutover accepted |
| 8. Operations/launch | 160–240 h | At least three months of partner operations, fixes, independent review, two more customers, restore drills | G6: release criteria met |
| **Total** | **1,260–1,920 h** | At 22.5 delivery hours/week: **56–86 working weeks** | Reforecast at each gate |

The order describes primary implementation effort. FBR access and accountant validation start in discovery; an initial sandbox request/response exercise happens during foundations. Do not wait for Stage 5 to discover an integration blocker. Budget these investigations inside existing stages; a solo founder does not have parallel teams.

**Planning envelope: approximately 15–24 months from October 2026, or January–October 2028 for public release.** Use July 2028 as a provisional 21-month budget scenario, not a promised date. This includes uncertainty, external coordination and a minimum three-month pilot. Release earlier if delivery is faster and every gate passes. Recalculate after six weeks and monthly thereafter from actual completed work.

Internal demonstrations arrive earlier: foundation/ledger, commission proof, then connected trading. The partner previews each stage. Any earlier production use requires the relevant gate and does not silently redefine the complete release.

Scope changes require a decision record: customer need, evidence, affected workflow, effort and forecast impact. Fix correctness failures before adding modules. Keep one primary feature slice in progress.

## 6. Architecture

Retain TypeScript, Next.js App Router, PostgreSQL/Supabase, Drizzle, Tailwind and shadcn/ui. Use a modular monolith: one product codebase and relational database, with owned domain modules. Keep accounting and commission calculations independent of UI/framework code. Use one durable Postgres-backed job mechanism; choose worker hosting during foundations from a deployed proof.

Modules: identity/access, parties/catalog, accounting, sales, purchasing, inventory, imports, collections, commissions, payroll, tax/compliance and reporting. Modules expose business operations; screens do not write journal lines or stock balances directly.

| Decision | Baseline |
|---|---|
| Money | PostgreSQL NUMERIC and decimal-safe application arithmetic; decimal strings at serialization boundaries. Document amount, quantity, rate and FX precision/rounding. No silent conversion to JavaScript Number. |
| Tenant boundary | tenant_id on tenant-owned records, membership and company/branch permissions, tenant-aware foreign keys/uniqueness. Deliberately separate shared reference data. |
| Database access | Restricted runtime role subject to RLS; tenant context comes from validated identity/membership. Prove transaction-scoped context works with the connection pool. |
| Privileged access | Separate migration/admin credentials. Review workers, storage, views, exports and support tools. Supabase service-role access bypasses RLS; do not use it as the ordinary customer query role. [Source](https://supabase.com/docs/guides/database/postgres/row-level-security) |
| Journals | Editable drafts, immutable posted entries, explicit reversals. Atomic posting validates balanced base-currency lines, accounts, period and source uniqueness; deny direct posted-line mutation. |
| Balance enforcement | Controlled posting transaction and suitable database triggers/permissions, plus concurrency tests. A normal row CHECK cannot enforce a sum across other rows. [Source](https://www.postgresql.org/docs/current/ddl-constraints.html) |
| Local atomicity | Related local invoice, journal, stock, commission and outbox changes commit together where required. Remote FBR acceptance cannot join the same database transaction. |
| External operations | Persist intent, attempts, responses and reconciliation. Local operation uniqueness is distinct from remote duplicate handling; verify the latter before retries after ambiguous timeouts. |
| History | Snapshot prices, taxes, FX, plans and assignments. Effective dates alone are insufficient if historical values are overwritten. |
| Inventory | Moving weighted average proposed, subject to review. Separate quantities, valuation, cost adjustments and GL. Explicitly handle costs arriving after units sell. |
| Time/periods | UTC timestamps and Asia/Karachi business dates; controlled period reopen with reason and audit. |
| Deployment | Separate development/staging/production; reviewed migrations, isolated test data, secrets, observable jobs, alerts and reversible app releases. |

Schema design is a deliberate deliverable. AI may draft; founder and competent reviewer must understand ownership, constraints, posting effects and migrations before implementation. The old entity sketch is not a final SQL design.

## 7. Commission, costing and compliance

### Commission is an auditable balance

Keep entitlement per invoice line, beneficiary and plan version. Record immutable accrual, release, release-reversal, payout and entitlement-adjustment movements with allocations to source receipts/returns. Derive balances; do not overwrite history to force agreement.

Distinguish earned entitlement, unreleased portion, released unpaid portion and paid amount. A post-payment reduction may create a recoverable amount. Each adjustment has an actor, reason and approval. Review contractual/legal recovery before deducting negative commission from salary.

Illustrative test, not a confirmed partner rule: an eligible net sale of Rs 100,000 at 2% creates Rs 2,000 entitlement. Cleared collection covering 40% of the eligible basis releases Rs 800. Paying Rs 800 leaves Rs 1,200 unreleased. If a fully collected invoice is subsequently fully returned, its final earned entitlement becomes zero and paid amounts enter the approved recovery process. Define partial-return/allocation rules before fixing their expected values.

### Import outlay and inventory cost need separate classification

The old notes list LC margin, duties, sales tax and advance income tax together. Do not automatically capitalize every amount. Have the accountant classify each as inventory cost, recoverable tax, deposit/advance, expense or another balance-sheet item, including eligibility evidence. Allocate only the approved inventory-cost pool. Define estimates, late bills, rounding residue and sold-stock adjustments. IAS 2 provides the inventory-cost/costing-method starting point for review. [Source](https://www.ifrs.org/issued-standards/list-of-standards/ias-2-inventories/)

### Verify the FBR contract before implementing it

The official API v1.12 currently linked by FBR describes a PRAL-issued bearer token and `postinvoicedata` / `validateinvoicedata` methods with sandbox variants. It does not establish the OAuth client-credential flow in the old notes. Archive a dated contract and verify sandbox behaviour. A local idempotency key does not establish remote deduplication. [Official API PDF](https://download1.fbr.gov.pk/Docs/20257301172130815TechnicalDocumentationforDIAPIV1.12.pdf)

Model pending, accepted, rejected, outcome-unknown and reconciled states. Hold outcome-unknown submissions for verified reconciliation instead of blind replay. Retain protected evidence and sanitized operational logs. Agree with integrator/accountant when dispatch, accounting posting and invoice printing are permitted.

FBR's FAQ confirms PRAL offers free integration and describes debit/credit notes for relevant invoice adjustments. Free integration does not eliminate our engineering/support costs. Bundled compliance remains a commercial choice. The FAQ does not substantiate the earlier blanket 72-hour edit/delete rule. [FBR FAQ](https://fbr.gov.pk/faqs/173967/173969)

Maintain a compliance matrix: rule, legal provision/SRO, dates, applicability/exemptions, source, test cases, reviewer and next review. Confirm sales-tax versus income-tax status, goods classification, sale type, schedules, withholding, input eligibility and payroll rules. Do not turn the research's 18% + 4% or Section 8B summaries into universal rules.

Validate Annex-A/B/C/I and STR-7 workpapers/export formats against current official templates and the accountant's workflow. Portal auto-population does not establish an API our app can use. The accountant retains filing authority unless an authorized integration is separately established.

## 8. Quality and release gates

Each slice includes migration, logic, usable UI, permissions, audit, failure handling and relevant tests. Test money/access rigorously and use focused workflow tests elsewhere. Reference data can contain incumbent mistakes: resolve disagreements with the accountant rather than copying every number.

| Gate | Required evidence |
|---|---|
| G0 — build | Agreed rules/workflows, representative data, five interviews, partner responsibilities, scope/capacity/budget; unresolved external issues owned |
| G1 — foundation | Two tenants cannot access/link each other's data; actual restricted-role tests; unbalanced/duplicate postings and posted-line edits rejected; restore rehearsal |
| G2 — commission | Reviewed examples match rounding policy; partial payment/reversal/hierarchy/payout replay tests; sales manager/accountant can explain each result |
| G3 — trading | Partial sale/purchase/return flows reconcile AR/AP/stock to GL; concurrency cannot oversell, overallocate or duplicate effects |
| G4a/b/c — specialist domains | Late-cost import closes; applicable FBR and timeout/correction procedures verified; payroll/commission/GL reconcile without double counting |
| G5 — beta | Rehearsal opening balances and close accepted; safe import/migration replay; operators complete tasks; support/backups/recovery exercised |
| G6 — public release | Three consecutive months of real partner operations/closes; at least two real commission/payroll payouts; no unresolved critical money/access defects; two additional paying customers onboarded normally |

Proposed operational targets, frozen at G0: normal pages p95 under 2 seconds and local posting p95 under 3 seconds at twice observed partner peak load, excluding provider wait. Measure FBR latency separately. Size imports from actual line counts/payroll volumes.

Before production, test tenant boundaries across files/exports/jobs, escalation, double clicks, concurrent postings, duplicate jobs, timeout after remote acceptance, locked periods, partial returns, bounced cheques, schema upgrades and restoration of database plus attachments.

Target restoration within 4 hours and no more than 1 hour of unrecoverable production data loss. These are internal targets, not a customer SLA until demonstrated. Fund and test a database/PITR plus attachment-backup arrangement that meets them. Daily backup alone does not satisfy the one-hour target. Supabase currently lists Pro from $25/month and PITR separately from $100/month; include actual add-ons/projects in the budget. [Pricing](https://supabase.com/pricing)

Use zero unexplained financial reconciliation differences as the money gate. Separate invalid customer inputs from product-caused FBR rejections; “zero rejections” alone does not establish correctness.

## 9. Migration, pilot and cutover

1. Stage parties/items/source identifiers; preview duplicate keys, invalid units/currencies and missing tax data before committing.
2. Import opening trial balance, customer/supplier open items, stock quantity/value, uncleared cheques, commissions and payroll liabilities. Reconcile subledgers to control accounts.
3. Import sufficient history for unpaid invoices, returns and commission obligations. Preserve external invoice identifiers. Never re-submit historical accepted invoices to FBR.
4. Replay history and run a supervised shadow cycle. Clearly mark shadow records; disable live FBR/payment actions in staging/shadow mode.
5. Agree cutover date and source-of-truth register. Every transaction has one issuing system. Reconcile final deltas, obtain partner acceptance and enable trained users.
6. Operate for at least three months with weekly reconciliation/monthly close. Parallel calculations are permitted during validation and retired after acceptance.
7. On serious failure, stop affected writes, preserve evidence, restore and reconcile. After real transactions exist, recovery must not erase issued documents or create duplicate issuance.

No public self-serve signup until three customers onboard successfully. Assisted onboarding is expected; customer-specific forks are not. Reusable configuration and import mappings are acceptable.

## 10. Commercial plan and funding

Start with one complete importer-distributor package including commissions and bundled compliance. The old three-tier offer hides the defining feature in the top tier and complicates validation. Revisit tiers after usage/support costs are known.

**Pricing hypothesis:** Rs 25,000–40,000/month and Rs 50,000–150,000 implementation, with explicit user/branch/migration limits. These are experiments, not established willingness to pay or a published offer. Agree pilot terms, charging start, support and export/exit arrangements. Do not promise custom development for a subscription.

Measure before/after commission-preparation time, disputes, import reconciliation and month-end close time. Test the same demonstration with three prospects and record objections/price response. Acquire the next customers through founder outreach and accountant/referral relationships; defer paid advertising until onboarding repeats.

The following are budget allowances, not supplier quotes. Obtain scoped quotes and approval before commitments. Existing subscriptions may reduce incremental spend.

| Cost | Allowance |
|---|---:|
| Hosting, database, worker, backups, storage, monitoring | Rs 10,000–40,000/month, stage-dependent |
| AI/developer tools | Rs 5,000–20,000/month incremental |
| Domain/email, support and incidental operations | Rs 5,000–10,000/month |
| Accountant, independent engineering/security and commercial-document review | Rs 200,000–400,000 total reserve; obtain quotes |
| Contingency | 25% of the above |

At the 21-month scenario, recurring costs total Rs 420,000–1,470,000. Add specialist reserve and 25% contingency for approximately **Rs 775,000–2,337,500**. This sensitivity range excludes founder living/salary costs, hardware, sales travel, taxes and extraordinary remediation. Add `monthly personal cash need × runway months`. Validate foreign-currency vendor charges and recovery needs before approving hosting costs.

Contribution/customer = subscription collected minus incremental hosting/support/payment costs. Cash break-even customers = fixed monthly cash cost divided by contribution/customer, rounded up. Track founder support hours separately: excluding wages does not establish profitability. Do not assume early subscriptions will fund the entire build.

## 11. Ownership and operating rhythm

| Owner | Responsibility |
|---|---|
| Founder | Scope, architecture understanding, implementation, commercial terms, releases, support and runway |
| Partner owner/manager | Data/operator access, workflow decisions, pilot commitment and acceptance |
| Partner accountant plus retained Pakistani accountant | Posting/costing/tax/payroll expectations, reference disputes, close and compliance acceptance |
| Partner sales/payroll lead | Commission rules/targets/disputes, approvals and employee statements |
| Independent engineer, to be engaged | Foundation and pre-production review of tenancy, transactions, integrations and recovery |

Weekly: partner demonstration, backlog triage and reconciliation review. Monthly: runway, delivery throughput, unresolved rules and official compliance changes. Accountant reviews occur at discovery, posting design, domain integration and pilot closes; one final review is insufficient.

For each release candidate retain version, migrations, test evidence, supported tax scenarios, known limitations, deployment/recovery steps and business reviewers.

## 12. Risk responses

| Trigger | Response |
|---|---|
| Partner cannot supply data/rules by G0 | Continue interviews/synthetic prototypes; replace partner or hold dependent work. Never invent reference results. |
| Commission pain does not repeat | Reassess positioning/pricing before committing to breadth. |
| Capacity/estimates change | Reforecast from completed slices; change dates before compromising controls. |
| Integrator access/semantics unclear | Follow official support process; evaluate another licensed integrator with clear cost/contract; hold compliance go-live. |
| Reconciliation failure or tenant exposure | Stop affected operations, preserve evidence and remediate; release gate fails. |
| Unrelated industry requests | Separate expansion backlog; require repeated demand, then explicitly change scope. |
| Support consumes founder | Fix onboarding/defect causes, cap intake and fund help when contribution supports it. |
| Runway below six months | Reassess spend and delivery scope before commitments; retain quality gates. |

## 13. Decisions to close during discovery

| Decision | Due | Provisional assumption |
|---|---|---|
| Founder hours/budget | Week 1 | 30 h/week; budget unapproved |
| Company count, branches, warehouses, goods, volumes | Week 1 | One legal company; actual volume unknown |
| Incumbent/export and migration access | Week 1 | Structured export not yet demonstrated |
| Commission rules/hierarchy/exceptions | Week 2 | Recovery-linked is a hypothesis |
| Accounting, inventory costing and currencies | Week 3 | PKR base, USD/CNY purchases, weighted average proposed |
| Tax/payroll applicability and integrator | Week 3 | PRAL preferred; scope unconfirmed |
| Recovery and production hosting | Week 4 | One-hour data-loss/four-hour restoration targets |
| Pilot fees, data terms, acceptance and owners | Week 4 | Written agreement required |

See [IMPLEMENTATION-BACKLOG.md](IMPLEMENTATION-BACKLOG.md) for tasks/dependencies. All work is currently unstarted. This plan itself makes no external purchase, outreach, deployment or tax filing.

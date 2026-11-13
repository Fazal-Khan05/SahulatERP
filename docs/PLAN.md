# Build plan

Instruction set for rebuilding SahulatERP, one Claude Code session per step. Claude Code reads this file; do only the step you are asked.

## How to use this plan

One session per numbered step, in order. Each step is sized so that a single session can finish it with tests passing. Never combine steps, and never let a session "also fix" something from a later step.

Definition of done for every step, no exceptions:

1. Migration applied to the dev Supabase project with `npm run db:migrate`, and reversible (a down migration or a documented drop).
2. Unit tests for the business rule in the step; a Playwright test for the screen if the step has one.
3. The feature works for the role that uses it and is invisible or refused for roles that should not see it.
4. The audit log records the action with who, when and what.
5. The founder, not Claude Code, has clicked through it on the dev deployment.

If a session ends with failing tests, the next session's first job is to fix them, not to start the next step.

## Decisions already made

These are fixed. Do not reopen them unless something in the build proves one wrong.

| Decision | Choice | Why |
| --- | --- | --- |
| Repository | Same repo, reset in place. Old code on branch `prototype-archive`; research, plans, old tests, old migrations and old engine under `reference/` (read-only, never imported or run) | Keeps the Vercel and Supabase links; keeps the rules and tests as reference |
| Stack | TypeScript, Next.js (App Router), PostgreSQL on Supabase, Drizzle ORM, Tailwind + shadcn/ui, decimal.js, zod, Vitest, Playwright | Claude Code knows it well; nothing to relearn |
| Storage design | Relational tables per entity. No workspace blob. Posting engine runs inside a database transaction per command | The old blob design could not scale or support concurrent users |
| Tenancy | One Supabase project, every table carries `tenant_id`, RLS on every table, app-level permission checks on top | Standard SaaS; cheapest |
| Hosting | Vercel Hobby + Supabase Free while building. Railway Hobby + Supabase Pro + Cloudflare R2 from the day the first real company enters data | Backups and commercial-use terms; about $35/month |
| Target customer | Trading and distribution SMEs: importers, wholesalers, distributors, parts dealers. 1–50 users | One builder; this segment pays and has the needs the differentiators serve |
| First customer | A bike-parts import business: 1 branch, under 1,000 SKUs, under 50 invoices/day, not yet sales-tax registered, migrating from Fast Accounts | Sets the launch bar |
| FBR digital invoicing | Module switched off by default; all tax and FBR fields present in the tables from the first migration; integration built in Phase 7 before the first registered customer | Unregistered customers never see it; registered ones cannot be sold to without it |
| Currencies | A table the tenant edits; PKR base; any number of foreign currencies with dated rates | Import currency unknown; must not be hard-coded |
| Out of v1 | Mobile app, Urdu UI, WhatsApp sending, offline/PC version, manufacturing, CRM pipeline, POS, loyalty, e-commerce | Founder's decision for launch; see Phase 9 |
| Pricing | Per company per month, unlimited users; Starter ~Rs 6,000, Business ~Rs 12,000 with FBR included; setup fee for migration | Infrastructure cost per customer is under Rs 1,000 |

Open item that does not block the build: the company/product name. Settings must let the product name and logo be changed without a code change.

## Architecture

A modular monolith: one Next.js app, one Postgres database, one background worker process, one object store. No microservices, no message broker, no second database.

- **Browser (Next.js UI):** role-first screens and a to-do inbox. Loads only the page it shows; never holds the company's data.
- **Print and PDF:** every document has a print view with the tenant's letterhead; FBR number and QR appear only when the FBR module is on.
- **Application server (Next.js server actions and route handlers):** auth and permissions (Supabase Auth, membership, role, branch scope); the posting engine (one command = one transaction = documents + stock moves + journal, all or nothing); the tax engine (item category × buyer status × date → rate, further tax, withholding); audit (every command writes who, when, what, before, after).
- **Background worker:** a second process in the same Railway service (or a Vercel cron during development) that polls a `jobs` table: FBR submissions with retries, report generation, nightly exports, scheduled reminders. Jobs are rows, so they survive restarts.
- **PostgreSQL on Supabase:** one project, many tenants; `tenant_id` + RLS on every table; triggers enforce balanced journals, immutable posted rows, gapless numbers. Daily backups on Pro; nightly export to R2.
- **Cloudflare R2:** scans, PDFs, logos, nightly tenant exports; served by signed links.
- **FBR / PRAL API:** called by the worker only when the module is on.

Modules live in `src/modules/<name>/` with the same four files each: `schema.ts` (Drizzle tables), `rules.ts` (pure functions, no I/O, fully unit-tested), `commands.ts` (the transactional handlers), `queries.ts` (read models for screens and reports). Screens live in `src/app/(app)/<module>/`. A module may import another module's `rules.ts` and `queries.ts`, never its `commands.ts`; cross-module writes go through the posting engine in `src/modules/ledger/`.

## Data model

Every table has `tenant_id uuid`, `id uuid` (never sequential), `created_at`, `created_by`, and RLS that filters on `tenant_id` through the member's active membership. Money columns are `numeric(20,4)`; quantities `numeric(20,4)`; FX rates `numeric(20,8)`. Document numbers are text, per tenant, per document type, per fiscal year, allocated from a `number_series` table inside the posting transaction so they are gapless.

| Module | Tables | Day-one fields that are easy to forget |
| --- | --- | --- |
| Tenant | `tenants`, `memberships`, `branches`, `warehouses`, `number_series`, `settings`, `modules_enabled`, `audit_log`, `jobs`, `files` | `settings.product_name` and logo; `settings.fbr_enabled`; `files` stores R2 keys, never bytes |
| Currencies | `currencies`, `exchange_rates` (currency, date, rate, source) | Base currency fixed per tenant at setup; rates dated; every foreign-currency document stores the rate it used |
| Ledger | `accounts` (editable tree under locked control accounts), `journals`, `journal_lines`, `fiscal_periods`, `opening_balances` | `accounts.is_control` and `accounts.control_type` (AR, AP, inventory, tax, bank, payroll, commission); `journal_lines.cost_centre_id` nullable from day one |
| Tax | `tax_categories` (standard 18%, reduced with SRO reference, exempt, zero-rated, Third Schedule retail price), `tax_rates` (category, effective_from, rate), `withholding_rules` (income tax s.153 by supplier type and ATL status; sales-tax withholding; provincial services tax by province) | Dated rates, never a single number in settings. Items reference a category, not a rate |
| Parties | `customers`, `suppliers`, `contacts`, `party_addresses` | `ntn`, `cnic`, `strn`, `registration_type`, `atl_status` + `atl_checked_at`, `province`, `credit_limit`, `credit_days`, `customer_class`, `price_list_id`, `supplier_type` (company/individual/AOP), `is_withholding_agent` |
| Items | `items`, `item_categories`, `units`, `item_units` (conversion), `price_lists`, `price_list_items`, `item_prices_by_class` | `hs_code`, `fbr_uom_code`, `tax_category_id`, `retail_price`, `sale_type`, `track_batches` and `track_serials` (default false), `reorder_level`, `weight`, `volume` |
| Sales | `sales_documents` (quotation, order, delivery, invoice, credit note; one table, `kind` column), `sales_lines`, `sales_line_salespeople`, `sales_document_links` | Per line: `tax_category_id`, `tax_rate`, `tax_amount`, `further_tax_rate`, `further_tax_amount`, `extra_tax_amount`, `sro_schedule_no`, `sro_item_serial`, `fbr_uom_code`, `sale_type`, `retail_price`. Per document: buyer snapshot (name, NTN/CNIC, registration type, province, address), `fbr_invoice_number`, `fbr_submission_id`, `fbr_status`, `offline_flag` |
| Purchasing | `purchase_documents` (order, GRN, bill, return), `purchase_lines`, `supplier_advances`, `withholding_entries` (document, rule, base, rate, amount, challan_no, deposited_on) | Supplier bill: `supplier_strn`, `input_tax_claimable`, withholding type and amount; GRN links to shipment when imported |
| Imports | `shipments`, `shipment_lines`, `shipment_charges` (class: inventory cost, recoverable sales tax, value-addition tax, advance income tax, deposit, expense), `landed_cost_allocations` | `gd_number`, `gd_date`, `port`, `container_no`, `lc_number` (nullable), `customs_value_pkr`, status flow; allocation basis per charge |
| Inventory | `stock_moves` (the only source of stock truth), `stock_balances` (derived), `stock_adjustments`, `stock_transfers`, `stock_counts` | `stock_moves.batch_id` and `serial_id` nullable now; weighted-average cost recalculated per move |
| Collections | `receipts`, `receipt_allocations`, `cheques` (received, deposited, cleared, bounced), `follow_ups`, `customer_advances` | Bounce reverses allocation, receivable and commission release in one transaction |
| Cash and bank | `bank_accounts`, `cash_accounts`, `bank_transactions`, `bank_statement_lines` (imported), `bank_reconciliations`, `reconciliation_matches`, `expenses`, `transfers` | Statement import keeps the raw line; matching is a separate table so it can be undone |
| Commissions | `commission_plans`, `commission_plan_rules`, `sales_hierarchy`, `commission_accruals`, `commission_movements` (accrued, released, release_reversed, approved, paid, recovered; immutable) | Port the rules and tests from `reference/` exactly |
| Payroll | `employees`, `employee_pay_components`, `payroll_runs`, `payslips`, `payslip_lines`, `statutory_rates` (EOBI, social security, income tax slabs; effective_from, province) | Slabs are rows shipped and updated with the tax year; EOBI base = minimum wage row, not salary |
| Reports | Views or SQL functions only; no tables. `annex_c_rows`, `annex_h1_rows` as SQL views | Report code never recomputes tax; it reads what the posting stored |

Rules the database itself enforces, with triggers or constraints:

1. A posted journal's debits equal its credits (deferred constraint trigger on `journal_lines`).
2. A posted journal cannot be updated or deleted; only a reversal journal that references it.
3. One source document produces at most one posting journal (`unique (tenant_id, source_type, source_id)`).
4. No stock move into a locked fiscal period.
5. Document numbers are unique per tenant and series; series allocation uses `select ... for update`.
6. A receipt's allocations never exceed the receipt amount; an invoice's allocations never exceed its total.
7. Every table's RLS policy checks membership; service-role credentials are used only by migrations and the worker.

## UI principles

1. **A home screen per role, not a dashboard.** Owner: cash, receivables, today's sales, approvals waiting. Salesperson: their customers, open orders, drafts. Recovery officer: cheques due, overdue customers, today's follow-ups. Warehouse: receipts to put away, deliveries to pick. Accountant: unposted items, unreconciled bank lines, period close.
2. **One inbox.** A single "Needs attention" list: drafts to submit, cheques to deposit, bills due, follow-ups due, FBR submissions failed, stock below reorder. Each row opens the thing to do.
3. **Progressive disclosure on every document.** Invoice shows customer, lines, totals. Tax category, salesperson split, FX rate, FBR fields sit behind "More" and appear only when they matter.
4. **Modules off means invisible.** No menu entry, no column, no report section.
5. **One document pattern.** Header, lines, totals, status bar with the next action as the primary button, a timeline of what happened on the right.
6. **Keyboard-first entry.** Item code + quantity + Tab; the mouse is optional.
7. **Print is a first-class screen.** `/print/<kind>/<id>` with the tenant's letterhead, and a PDF of the same.
8. **Lists are tables with saved filters**, with sort, filter, column chooser, CSV/Excel export.
9. **PKR formatting with lakh/crore grouping**; dates DD-MM-YYYY; Urdu-ready layout even though v1 is English.
10. **Mock-ups before screens** (Step 1). Do not build screens until two of the people who called the old UI complicated say they would use the new one.

## Build sequence

Fifty-two steps in nine phases. Phases finish in order; steps inside a phase mostly must too.

### Phase 0: Reset and foundation

| Step | Deliverable | Acceptance | Status |
| --- | --- | --- | --- |
| 0 | Repo reset, archive branch, new scaffold, Supabase reset, CLAUDE.md, docs/PLAN.md | `npm run check` passes; dev Supabase has no old tables; Vercel deploys | Done 2026-11-08 |
| 1 | Paper or Figma mock-ups of the five role home screens, the inbox and the invoice screen (no code), reviewed by at least two of the people who called the old UI complicated | Two reviewers say they would use it; objections written into `docs/UI-NOTES.md` | Done 2026-11-11 |
| 2 | Tenant, membership, auth: sign-in, forgot/reset, sign-out, tenant switcher, eight roles (Owner, Accountant, Sales Manager, Salesperson, Recovery Officer, Warehouse Manager, Payroll Administrator, Auditor), branch scoping, `audit_log` table and a helper every command calls. RLS on every table created so far | Playwright: two tenants, a user in each, neither sees the other's rows via the API; audit row written on sign-in | Done 2026-11-11 |
| 3 | App shell: role-aware navigation, inbox page (empty), settings skeleton, `settings.product_name` and logo used in header and print header, module on/off table with dependency rules | Switching a module off removes its menu entry; renaming the product needs no deploy | Done 2026-11-11 |
| 4 | `jobs` table + worker loop (poll, lock, run, retry with backoff, dead-letter) and a `files` table backed by Supabase Storage now, R2 later behind one interface | A test job runs, fails twice, succeeds on the third try; a file uploads and downloads via signed link | Done 2026-11-11 |

### Phase 1: Master data and settings

| Step | Deliverable | Acceptance | Status |
| --- | --- | --- | --- |
| 5 | Currencies and dated exchange rates; tenant base currency fixed at setup | Rate lookup by date returns the latest rate on or before the date | Done 2026-11-12 |
| 6 | Tax categories, dated tax rates, withholding rules tables, seeded with 2026-27 Pakistani values (18%, 4% further, exempt, zero-rated, Third Schedule; s.153 rates; Eleventh Schedule; provincial 16/15/15/15) and an "effective from" on every row | A rate lookup for an invoice dated before a change returns the old rate | Done 2026-11-12 |
| 7 | Customers and suppliers with every tax field, credit limit and days, class, price list; archive/restore; CSV import (atomic, bad-row report) | Import of 500 rows with 3 bad rows imports nothing and lists the 3 | Done 2026-11-12 |
| 8 | Items, categories, units and conversions, HS code, FBR UoM code, tax category, retail price, reorder level; CSV import | Carton-to-piece conversion applies on a line entered in cartons | Done 2026-11-13 |
| 9 | Price lists (per list, per customer class, per customer, with validity dates) and the price-resolution rule: customer-specific > class > list > item default | Unit test table of 12 cases passes | Done 2026-11-13 |
| 10 | Branches, warehouses, number series per document type and fiscal year, fiscal periods with lock/unlock (owner only) | Two concurrent invoice posts get consecutive numbers with no gap (test with 20 parallel requests) | Done 2026-11-13 |
| 11 | Setup wizard (company, tax registration status, base currency, modules bundle, first branch and warehouse, chart of accounts template) | A new tenant can reach an empty inbox in under five minutes | Done 2026-11-13 |

### Phase 2: Ledger core

| Step | Deliverable | Acceptance | Status |
| --- | --- | --- | --- |
| 12 | Chart of accounts: tree, locked control accounts with `control_type`, user-editable accounts beneath, template seeded at setup | Deleting an account with postings is refused; adding a sub-account under Expenses works | Done 2026-11-13 |
| 13 | Posting engine: `postJournal(tx, source, lines)` inside a transaction; balanced-lines trigger; immutable-posted trigger; one-journal-per-source constraint; reversal | 1,000 random balanced postings succeed; one unbalanced posting is rejected by the database, not the app | Done 2026-11-13 |
| 14 | Manual journals: draft, submit, reverse; period lock enforcement | Posting into a locked month is refused with a clear message | Done 2026-11-13 |
| 15 | Opening balances: trial balance import; customer-wise and invoice-wise AR; supplier-wise and bill-wise AP; bank and cash; an opening journal that balances via an equity suspense account | Imported AR ages correctly from the original invoice dates | Done 2026-11-13 |
| 16 | Reports: trial balance, general ledger, balance sheet, P&L, with date range, branch filter and CSV/Excel export; print with letterhead | TB totals equal; BS balances; P&L net equals change in retained earnings | Done 2026-11-13 |

### Phase 3: Sales and the tax engine

| Step | Deliverable | Acceptance | Status |
| --- | --- | --- | --- |
| 17 | Tax engine `rules.ts`: given item, buyer, date, currency → rate, tax, further tax, extra tax, retail-price base, sale type code. No I/O | 25-case unit table covering registered/unregistered, ATL/non-ATL, exempt, zero-rated, Third Schedule, reduced-rate with SRO | Done 2026-11-13 |
| 18 | Sales documents table and the one document screen: quotation and sales order (draft/submit, lines, price resolution, line discounts, salesperson splits summing to 100%, credit-limit check with owner override, keyboard entry) | Over-limit sale blocked; override logged with reason | Done 2026-11-13 |
| 19 | Delivery note from order (partial, remaining qty tracked) with stock moves at weighted-average cost | Stock and COGS move; delivering more than ordered is refused | |
| 20 | Sales invoice from delivery or order; posting: AR, revenue, output tax, further tax, COGS; buyer snapshot stored; FBR fields stored (module off, so not submitted) | Journal matches a hand-worked example for a registered buyer and an unregistered one | |
| 21 | Credit note / sales return: restock (saleable or damaged), reversal postings, commission reversal hook | Returning more than invoiced refused; partial return posts partial reversal | |
| 22 | Walk-in customer, multi-currency sale with FX gain/loss on settlement, customer advances with own control account | Advance applied to an invoice clears both correctly | |
| 23 | Print and PDF for all sales documents; email sending with PDF; document timeline | Email arrives with the PDF; print header uses the tenant logo | |

### Phase 4: Purchasing, imports, withholding

| Step | Deliverable | Acceptance | Status |
| --- | --- | --- | --- |
| 24 | Purchase order and GRN (partial), goods-received-not-billed accrual | GRN without bill shows in the GRNI report at cost | |
| 25 | Supplier bill: match to GRNs, input tax by supplier STRN, s.153 income-tax withholding by supplier type and ATL, Eleventh Schedule sales-tax withholding, provincial services tax on service bills; `withholding_entries` | A Rs 100,000 goods bill from a non-ATL company withholds 10% and posts to the withholding payable account | |
| 26 | Supplier payments with withholding deducted, challan recording, supplier advances in foreign currency with revaluation | Payment of a bill with an advance applied nets correctly | |
| 27 | Supplier returns (debit notes) | Reverses GRNI or AP as appropriate | |
| 28 | Shipments: status flow, GD number/date, port, container, LC number; shipment charges with the five classes; landed-cost allocation by value/qty/weight/volume; late charges re-allocate and adjust inventory and COGS | Port the old allocation tests; a late freight bill adjusts remaining stock and COGS of sold units | |
| 29 | Reports: aged payables, supplier statement, withholding register, s.165 quarterly export, GRNI | Withholding register totals equal withholding payable | |

### Phase 5: Inventory, collections, cash and bank

| Step | Deliverable | Acceptance | Status |
| --- | --- | --- | --- |
| 30 | Stock transfers, adjustments with reasons, bulk opening stock, stock count sheets with variance posting; concurrent-edit warning | Count variance posts to the inventory adjustment account | |
| 31 | Reports: stock valuation, stock movement, stock ageing, low stock, item profitability (margin) | Valuation equals the inventory control account | |
| 32 | Receipts (bank, cash, cheque) allocated across invoices; cheque lifecycle received → deposited → cleared/bounced; bounce reverses allocation, AR and commission release in one transaction; cheques-in-hand register; bank charges on receipt | Bouncing a cheque restores the invoice balance and reverses the released commission | |
| 33 | Recovery: follow-ups, promise-to-pay with broken-promise list, customer statement print and email, aged receivables | Overdue list matches ageing report | |
| 34 | Bank and cash accounts, transfers, expenses, petty cash; archive only at zero balance | Expense with provincial services tax withholding posts correctly | |
| 35 | Bank statement import (CSV/Excel from HBL, Meezan, UBL formats; generic column mapper), matching rules, reconciliation screen, unreconcile | 90% of a sample statement auto-matches; reconciled balance equals ledger | |
| 36 | Cash-flow statement; owner dashboard with date and branch filters | Cash-flow net equals change in bank and cash | |

### Phase 6: Commissions and payroll

| Step | Deliverable | Acceptance | Status |
| --- | --- | --- | --- |
| 37 | Commission plans and rules (flat, category, class, per-unit, tiered with targets), non-overlapping dates, sales hierarchy with cycle check. Port rules from `reference/` | Old unit tests pass against the new `rules.ts` | |
| 38 | Accrual on invoice, release on collection (partial), reversal on bounce/return, approval, payment, recovery from later pay; immutable movements | Port the old workflow tests; every movement sums to the accrual | |
| 39 | Commission statements per salesperson (print/PDF), approval screen, manager override percentage | Statement equals movements for the period | |
| 40 | Employees, pay components, attendance (CSV), statutory rate tables seeded (TY2027 slabs, EOBI on minimum wage by province, social security) with effective dates | Tax on a Rs 150,000/month salary matches the slab calculation by hand | |
| 41 | Payroll runs draft → reviewed → approved → paid, cancel; commission settlement without double expensing; payslips PDF and email | Approving a run after a commission changed is refused | |
| 42 | Salary bank-transfer file (per-bank layout, starts with one bank), s.149 annual statement export, loans/advances with instalments, final settlement | Bank file validates against the bank's sample | |

### Phase 7: FBR digital invoicing (module)

| Step | Deliverable | Acceptance | Status |
| --- | --- | --- | --- |
| 43 | FBR settings: enable toggle, token (encrypted at rest), sandbox/production, seller details; PRAL client for `validateinvoicedata` and `postinvoicedata`; reference-data sync (provinces, UoM, HS codes, sale types, SRO schedules) into tables | Validate call succeeds against the sandbox with a seeded invoice | |
| 44 | Submission pipeline: on invoice submit, enqueue job; store full payload and response; FBR invoice number on the document; failure states and retry; ambiguous-timeout rule (never blind resubmit; query first); offline flag with 24-hour re-upload job; credit/debit notes through the same path | Sandbox scenarios SN001–SN028 pass for the tenant's sector; a killed worker mid-submit does not double-submit | |
| 45 | Print: FBR invoice number, DI logo, QR code on invoices with a number; invoice cannot be printed as a tax invoice without one when the module is on; ATL check via `statl` on customer save | QR decodes to the FBR number | |
| 46 | Sales-tax return exports: Annex-A, B, C, C1, H1 as SQL views and Excel files in FBR layout | Annex-C total equals output tax in the ledger for the month | |

### Phase 8: Operations and launch readiness

| Step | Deliverable | Acceptance | Status |
| --- | --- | --- | --- |
| 47 | 2FA (TOTP or SMS), session timeout, login history, password policy; secrets audit | A member without 2FA is prompted on next login | |
| 48 | Nightly per-tenant export job to R2 (every table as CSV + files), restore script, and a one-click "export my data" for the owner | Restore into a fresh dev project reproduces the trial balance | |
| 49 | Migration importer for Fast Accounts, Tally and Excel: customers, suppliers, items with stock, opening balances; `docs/MIGRATION.md` checklist | The pilot company's Fast Accounts export imports with a matching trial balance | |
| 50 | Performance pass: seed 100,000 invoices; every list and report under 3 seconds; indexes; query plans checked | Aged receivables and stock valuation under 3 s on the seed | |
| 51 | Railway service, Supabase Pro, R2 bucket, domain, monitoring (uptime check + error alerts), spend alerts; `docs/RUNBOOK.md` | Deploy from main; restart loses nothing | |
| 52 | Go-live with the pilot company: migrate, train, run one month in parallel with Fast Accounts, reconcile month-end | Month-end TB matches Fast Accounts within explained differences | |

### Phase 9: after launch, first 90 days

In this order, each a step with the same discipline: batch/expiry and FEFO; serial numbers; barcode on receipt and count; scheme engine (slabs, free goods, buy-X-get-Y, time-bound) with principal claims; payment reminders by SMS and WhatsApp; fixed assets with depreciation; cost centres on every posting; sales pivot and dashboard filters; reorder suggestions that draft POs; LC tracking per shipment. The order-booker mobile app is a separate decision after ten paying customers.

## Launch gate

Sellable to an unregistered trading company when Steps 0–42 and 47–52 are done and the pilot company has closed one month in parallel with Fast Accounts. Sellable to a sales-tax-registered company only when Phase 7 is also done and one real company has a production FBR token issued through the product.

- [ ] `npm run check` green; Playwright suite green on the deployed URL
- [ ] Two tenants on the same database; no cross-tenant read or write via UI, API or export
- [ ] Month-end trial balance of the pilot company matches Fast Accounts within explained differences; control reconciliation report shows zero variance
- [ ] Restore from the nightly R2 export tested into a fresh project; trial balance matches
- [ ] 2FA on for every owner and accountant login
- [ ] Statutory rate tables checked by Claude against the law texts and recorded in `docs/RATES-REVIEW.md`; each company confirms its own rates during setup (the founder has no accountant; decided 2026-11-13)
- [ ] Pricing page, terms of service and a data-processing statement
- [ ] Support channel with a stated response time
- [ ] Product name decided and set in settings; domain live

After launch, nothing from Phase 9 starts until the pilot company has run two clean month-ends. Bugs found in production outrank every roadmap item.

## Risks

1. **Scope creep by the builder.** Every "while I'm here" addition pushes launch by days. "Do only Step N" is the defence.
2. **Accounting correctness with no accountant.** The founder has no accountant (decided 2026-11-13). Steps 13, 20, 25, 28, 32 and 41 each produce a worked example that Claude checks: the expected journal is derived from the law texts and standard practice, an independent reviewer derives it again without seeing the first, and the two are compared with what the software posts. Each is recorded as checked by Claude, not by an accountant. A tax practitioner's read of `docs/RATES-REVIEW.md` and the six examples before the first paying customer files a return is advised, not required.
3. **FBR contract drift.** Keep the client code in one module, pin the API version in config, re-run the sandbox scenarios before every release that touches invoices.
4. **Statutory rates changing every July and by SRO mid-year.** Dated rate tables make updates a data change, not a deploy.
5. **The pilot company losing patience.** Agree the parallel month in advance, with a date.
6. **Rebuilding the UI the same way.** Step 1 exists so the design is tested on people before any screen is coded.

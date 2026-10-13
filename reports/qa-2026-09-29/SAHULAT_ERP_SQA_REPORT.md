# SahulatERP — comprehensive prototype SQA report

**Test date:** 29 September 2026  
**System:** [deployed prototype](https://sahulaterp.vercel.app/) and the matching local Next.js checkout  
**Tester perspective:** owner, customer-facing workflow, financial controls, security boundaries, accessibility, responsive layout, and source/data integrity  
**Decision:** **Not ready for design-partner business data or unattended use.** It is suitable for a guided synthetic-data demonstration once users understand the defects below. The highest-risk items are broad role access to the full data snapshot, disagreement between the live snapshot and relational tables, and incomplete account recovery.

## Executive result

The application loads on Vercel and presents all 11 intended navigation modules. The owner can sign in and switch between the demo and empty Design Partner workspace. Sales and inventory filters, invoice and item detail views, stock-edit preview, and transfer preview work in the tested paths. The financial engine rejects negative stock and posting into a locked period, enforces command roles, and deduplicates repeated idempotency keys. All 15 existing domain tests, the extended browser review, TypeScript check, and production build passed. The existing owner browser test passed when run alone; it failed intermittently in earlier runs while sign-in/navigation stalled, so reliability under test load merits investigation rather than a definite product defect.

**17 findings** are recorded below: **6 high**, **10 medium**, and **1 low**. Severity reflects potential effect, not implementation effort. One high finding is a code-proven exposure for *future non-owner memberships*; there is currently only one real auth user, so it was not exercised with a separate account. A test limitation is never evidence that isolation works.

The current deployed demo remained unchanged by this test. Invoice submission, payroll payment, cheque transitions, reset, and partner import were not clicked against the hosted tenant because they would alter its existing data. Those paths were checked through isolated in-memory workflow tests and code review where possible. No real bank, customs, payroll, or FBR transaction was attempted. FBR is deliberately outside current scope at the owner's request and is **not** counted as a missing feature.

## Scope and method

| Area | What was exercised | Result |
| --- | --- | --- |
| Deployment | Open Vercel app and an invoice in the deployed browser | Pass |
| Authentication | Owner sign-in through local browser; anonymous and unauthorized API reads | Pass for tested paths; recovery fails |
| Navigation | All 11 modules, 8 role previews, tenant picker | Pass with role-preview trap |
| Sales | Invoice list, type/customer/search/date filters, clear, full invoice view | Pass with credit-display issue |
| Inventory | Search/category/warehouse/stock filters, clear, full item view, quantity edit preview, transfer preview | Pass with valuation defect in calculation engine |
| Other module controls | Primary buttons/dialogs in Purchasing, Imports, Collections, Commissions, Payroll, Accounting, Reports, Settings | Several wrong or incomplete actions |
| Financial domain | 15 existing unit tests plus negative stock, full transfer, locked period, role denial, duplicate request, future-year numbering probes | Controls mostly pass; 2 defects reproduced |
| Database | Read-only hosted schema and snapshot/projection comparison | 23 SELECT policies; projections diverge |
| Responsive | 1440, 768, and 390 px screenshots; document overflow check | No page overflow; tables need undisclosed horizontal scrolling |
| Build | `npm run typecheck`, `npm test`, `npm run build` | Pass |

The [browser observation log](evidence/observations.json), [database observations](evidence/database-observations.json), [domain probes](evidence/domain-probes.json), and [screenshots](evidence/) preserve the evidence. The repeatable read-only test is [qa-review.spec.ts](../../tests/e2e/qa-review.spec.ts); the isolated calculations are [domain-probes.ts](domain-probes.ts). Browser review had no captured page JavaScript errors. A count of 0 errors does not prove every untested action is safe.

## Detailed findings

### SQA-01 — Members can receive data from modules outside their role — High, code-proven

**Reproduction:** Add a non-owner member in a permitted tenant and request `GET /api/workspace` with that tenant ID, or load the workspace page and inspect its initial client data. The API checks *membership* but sends the entire `Workspace` object, including employees, salaries, payroll, financial journals, customer details, and other module data. The page also passes the entire workspace to the client. The role-based navigation only hides screens. The snapshot SELECT RLS policy similarly checks tenant membership, with no module-level read restriction.

**Expected:** A salesperson, warehouse user, or recovery officer should receive only data authorized for that role and branch. **Observed:** The server response is not filtered by role/branch. The user interface may hide it, but an authenticated member can inspect the network response. This was verified from `src/app/api/workspace/route.ts`, `src/app/[[...path]]/page.tsx`, and the RLS policy. A separate non-owner account was unavailable for runtime proof. **Fix:** Introduce role- and branch-scoped read endpoints or server projections; test every role against sensitive fields and cross-branch data.

### SQA-02 — Live snapshot and relational tables disagree — High, hosted DB observation

The demo snapshot is revision **44** with **9 documents, 21 journals, 20 stock movements, and 44 audit events**. The corresponding relational tables contain **8, 19, 18, and 41**. `POST /api/workspace` updates only `workspace_snapshots`; normal commands do not update the document, journal, stock, or audit tables. A downstream report or export reading those tables will miss transactions. The intended relational foreign keys, balanced-journal and immutability protections are not applied to the live snapshot mutations.

**Expected:** One authoritative write path with matching projections or fully normalized transactional writes. **Fix:** Choose the source of truth, migrate to transactional writes, and add reconciliation checks/migration for existing divergence. Avoid presenting current relational tables as reliable accounting books. Evidence: [database comparison](evidence/database-observations.json) and `src/app/api/workspace/route.ts`.

### SQA-03 — Password-reset link has no password-change screen — High, deployed reproduction

**Steps:** Follow the destination used by “Forgot your password?”, `/auth/callback?next=/account/reset`, then visit `/account/reset` after authentication. **Observed on Vercel:** `/account/reset` displays the standard Overview dashboard. There is no form or call to update the password. The catch-all page ignores the path. The reset email itself was not sent during QA.

**Expected:** A valid recovery session opens a password-change form, validates the new password, confirms success, and rejects expired links. **Fix:** Implement the dedicated recovery route and test the full email-to-new-password journey. Evidence: deployed browser and `src/components/login-screen.tsx`, `src/app/auth/callback/route.ts`, `src/app/[[...path]]/page.tsx`.

### SQA-04 — “New transaction” opens an unrelated sales invoice in six modules — High, browser reproduction

In **Imports & costing, Commissions, Payroll, Accounting, Reports, and Settings**, the header button opens **“New sales invoice”**. Purchasing opens purchase order, Collections opens receipt, and Sales opens sales invoice. A user in Payroll or Accounting can be led into the wrong financial document flow. **Expected:** A relevant module action or no header action. **Fix:** Map each module to its real action, and hide the button when none exists. Evidence: [browser observation log](evidence/observations.json), `src/components/workbench.tsx`.

### SQA-05 — Reset has no confirmation and leaves relational projections stale — High, browser/source review

The Settings **“Reset demo”** button immediately posts to `/api/demo-reset` without a confirmation explaining that current demo changes will be overwritten. The API updates only `workspace_snapshots`; the other demo tables are not reset. I deliberately did **not** press it because the hosted demo currently has user changes at revision 44. **Expected:** Explicit confirmation, reliable reset of every authoritative/projection store, and verified isolation from partner data. **Fix:** Add a confirmation with a clear scope, atomic reset/rebuild, and a test tenant reset rehearsal. Evidence: `src/components/workbench.tsx`, `src/app/api/demo-reset/route.ts`.

### SQA-06 — Full warehouse transfer leaves negative value in zero stock — High, isolated domain reproduction

**Steps:** Start with the seeded workspace; transfer all **200** units of item `i-5` from Karachi Port. **Before:** quantity `200.0000`, value `1,213,882.3529`. **After:** quantity `0.0000`, value **`-0.0071`**. Item `i-6` also reproduced a negative residual (`-0.0129`) in a separate probe. The transfer multiplies a rounded average cost by quantity instead of moving the exact remaining value for a full transfer. That leaves a warehouse with no stock but a nonzero, negative inventory value. **Fix:** On full transfer, use exact remaining value; add property tests for quantity/value zero and repeated transfers. Evidence: [domain probe](evidence/domain-probes.json), `src/modules/erp/engine.ts`.

### SQA-07 — Role preview can trap the owner in a restricted interface — Medium, browser reproduction

From Settings, choose Sales Manager, Salesperson, Recovery Officer, Warehouse Manager, or Payroll Administrator in **“View as role”**. Settings and its role selector disappear, so there is no visible way to return to Owner. Reloading the page restores Owner because preview state is temporary. Accountant and Auditor retain Settings. **Expected:** A persistent owner-only “Exit role preview” control outside role-filtered navigation. Evidence: [role observations](evidence/observations.json).

### SQA-08 — “All branches” is a dead button — Medium, browser reproduction

Clicking the page-header **“All branches”** button changes nothing and opens no menu. It appears on all desktop modules. It suggests a filter that is not implemented. **Expected:** A working branch selector that updates cards/tables, or no clickable button until it works. Evidence: [browser observation log](evidence/observations.json).

### SQA-09 — Global search and ⌘K affordance do nothing — Medium, browser/source reproduction

The top bar displays **“Search anything ⌘ K”** as plain text, without a search input or handler. `ControlOrMeta+K` opened no search interface during the browser run. **Expected:** Working search with keyboard access, or remove the shortcut claim. Evidence: [browser observation log](evidence/observations.json), `src/components/workbench.tsx`.

### SQA-10 — Dashboard sales/collections chart is fabricated — Medium, source review

The chart draws a fixed array of bar heights and September labels, independent of documents or receipts, while the surrounding page says figures come from the persisted ledger. Changing transactions will not change this chart. **Expected:** Date-bucketed sales and cleared collections calculated from the active tenant. Until then, label it as illustrative. Evidence: `src/components/workbench.tsx` Dashboard chart.

### SQA-11 — Returned invoice shows a negative “Balance due” — Medium, browser reproduction

Open **INV-2026-0002**. Its detail view shows **“Balance due Rs -53,100”** after a paid/returned scenario. The arithmetic can indicate a customer credit, but calling a negative amount “due” is confusing and the list labels it “partially paid.” **Expected:** Show a distinct customer credit/refund balance and an appropriate collection state, with drill-down to credit note. Evidence: [browser observation log](evidence/observations.json).

### SQA-12 — Document numbers stay in 2026 for 2027 documents — Medium, isolated domain reproduction

Creating a sales invoice dated **2027-01-05** produces **`INV-2026-0005`**. Document, credit-note, and shipment prefixes are hard-coded to 2026. **Expected:** Numbering should derive from configured fiscal year/date and remain unique across rollover. Evidence: [domain probe](evidence/domain-probes.json), `src/modules/erp/engine.ts`.

### SQA-13 — Mobile tables hide action and amount columns without a cue — Medium, visual reproduction

At **390 px**, Overview, Sales, and Inventory do not overflow the document, but their internal tables require horizontal scrolling. The screenshots show important right-hand values and **View/Edit** actions outside the visible width, with no scroll indicator or explicit instruction. **Expected:** Keep primary actions visible through a compact card/stacked row layout or a clearly indicated horizontal scroll region. Evidence: [390 px screenshots](evidence/) and the `tableScrollNeeded=true` measurements in the [browser log](evidence/observations.json).

### SQA-14 — Mobile navigation button has no accessible name — Medium, source/DOM review

The hamburger is an icon-only `<button class="mobile-menu">` with no `aria-label`; a screen reader encounters an unnamed button. **Expected:** “Open navigation” / “Close navigation” label and `aria-expanded`. Evidence: `src/components/workbench.tsx`.

### SQA-15 — Recovery follow-up command does not save the note — Medium, source review

The `follow_up` command validates party, note, and next date and creates an audit message, but does not add a recovery-activity record to workspace data. The supplied note and next action cannot be revisited as a task history. There is currently no visible follow-up button, so this is a backend incompleteness rather than a clicked dead control. **Expected:** Persist the activity and expose it in Collections. Evidence: `src/modules/erp/engine.ts`.

### SQA-16 — “Today” uses UTC, which can be wrong in Pakistan — Medium, source review

The client helper uses `new Date().toISOString().slice(0,10)` for default transaction and payroll dates. Between midnight and 05:00 in Asia/Karachi, this is the previous calendar day. A user may unknowingly post to the wrong date or period. **Expected:** Use the configured company time zone and display the selected posting date before submission. Evidence: `src/components/workbench.tsx`.

### SQA-17 — Notification bell is visual only — Low, browser/source review

The top bar displays a Bell icon without a button, label, count, or action. It creates an expectation of notifications but cannot be used. **Expected:** Add a notification queue/control or remove the icon. Evidence: `src/components/workbench.tsx`.

## Control inventory and behavior

| Surface | Tested controls | Outcome |
| --- | --- | --- |
| Global header | All branches, New transaction, search shortcut, bell | Branch/search inert; transaction wrong in six modules; bell inert |
| Workspace switcher | Open picker, select same tenant, select Design Partner | Works in existing owner browser test; no unapproved partner writes |
| Overview | Attention queues, recent invoice number/View | Queues navigate; invoice detail opens; chart static |
| Sales | New invoice, filters, View, draft Submit presence | Filters and View work; submission not clicked on hosted tenant |
| Purchasing | New purchase order | Correct dialog opens; draft/submit not clicked on hosted tenant |
| Imports | Allocate button presence, header action | Header opens sales invoice; allocation not clicked on hosted tenant |
| Inventory | Search/category/warehouse/level filters, clear, View, Edit preview, transfer preview | Tested interactions work; full-transfer value defect in domain engine |
| Collections | Record receipt dialog, receipt rows | Correct dialog opens; receipt/cheque changes not clicked on hosted tenant |
| Commissions | Entitlement list and header action | List loads; header opens sales invoice; approval unavailable for current 0 pending rows |
| Payroll | Run list, create/next-state controls, header action | List loads; header opens sales invoice; state-changing controls not clicked on hosted tenant |
| Accounting | Trial balance/journal rows, header action | Read-only tables load; header opens sales invoice |
| Reports | Control reconciliation table, header action | AR/inventory controls load; header opens sales invoice |
| Settings | Role preview, audit, reset presence, header action | Role preview can trap; reset deliberately not clicked; header opens sales invoice |

The inventory and sales filter combinations were tested with positive, empty-result, and clear-filter states. Example: filtering item `HM-002` to Lahore showed **150 pcs**, and an edit to **999 pcs** previewed **+849 pcs** before cancellation. Sales date filtering returned one expected record for the chosen range. These are observations, not guarantees for all data combinations.

## Acceptance against the earlier prototype plan

The original “complete working prototype” plan is substantially broader than the deployed interface. These are **scope gaps**, not necessarily regressions in an existing control. They should be explicitly prioritized before using “complete ERP” language:

- **Access/setup:** invitation management, independent real role accounts, branch permission management, and full partner-isolation test are not demonstrable yet.
- **Master data:** customers, suppliers, employees, items, pricing, units, and CSV import have engine/schema concepts but lack complete visible create/edit/import workflows.
- **Sales/purchasing:** the interface exposes basic invoice/order entry and lists; quotation/order/delivery conversion, partial fulfilment, supplier payment, returns, and printable/exportable documents need full UI journeys and acceptance tests.
- **Imports/inventory:** shipment creation, cost-line entry/classification, allocation detail, stock count/ageing and reconciliation views are incomplete in the current visible surface.
- **Collections/commissions:** ageing, recovery-task history, cheque lifecycle controls, commission-plan editing, approval and statement explanation need visible end-to-end flows.
- **Payroll/accounting/reporting:** payslips, attendance, bank reconciliation, period close, drill-down reports, and CSV/print exports need interface coverage. Current Reports shows only AR and inventory controls, not all planned control accounts.

Because the previous plan is a long-term target, these gaps should enter a release backlog rather than be presented as 17 more confirmed bugs. The current app is a useful prototype shell with some real accounting calculations, not yet the plan's accepted complete product.

## Security and data notes

- Anonymous `GET /api/workspace` returned **401**; authenticated requests with no tenant and a tenant without membership returned **403**. These are positive boundary results. The hosted database has **23 SELECT RLS policies**; app tables have forced RLS, with only the migration tracking table excluded.
- Independent-user cross-tenant read/write/export tests were **not possible** with the single current auth user. The owner is a member of both tenants, so switching between them does not prove isolation for a partner user.
- Role preview is explicitly interface-only. The server executes writes using the actual membership role; the preview does not grant extra write privileges. It also does not validate confidential read filtering (SQA-01).
- Database and service-role credentials were shared earlier in this project conversation. Rotate them before inviting a real partner or importing private data. Do not place them in the repository or in this report.

## Recommended release order

1. **Before partner data:** fix SQA-01, SQA-02, SQA-03, and SQA-05; rotate exposed credentials; create separate real role and partner accounts; run cross-role, cross-branch, and cross-tenant read/write/export tests.
2. **Before financial workflow trials:** fix SQA-06 and SQA-12, add ledger invariants, and test complete invoice/receipt/return/payroll lifecycles against a disposable QA tenant.
3. **Before unguided demos:** fix SQA-04 and SQA-07 through SQA-11; make mobile table actions obvious. Remove placeholder controls or implement them.
4. **For plan completion:** deliver the visible workflows in the acceptance-gap list and verify them with scenario-driven browser tests and reconciliation to the database.

## Verification record and limits

- `npm run typecheck` — **pass**.
- `npm test` — **pass, 15/15 domain tests**.
- `npm run build` — **pass**, production Next.js bundle generated.
- `npm run test:e2e -- qa-review.spec.ts owner-workspace.spec.ts --workers=1` — extended read-only QA test **passed**, owner test **failed once during sign-in wait**. An earlier parallel run had transient navigation timeouts. `npm run test:e2e -- owner-workspace.spec.ts --workers=1` then **passed** alone. The flaky startup/sign-in behavior should be watched in CI; it is not assigned a product defect without a repeatable user-facing cause.
- Hosted `db:check` and read-only SQL audit — **pass for connectivity**, **fail for snapshot/projection consistency**.
- Hosted Vercel smoke test — dashboard and invoice detail loaded. `/account/reset` rendered Overview, confirming SQA-03.

This report does not certify live payments, statutory calculations, actual FBR integration, disaster recovery, performance under load, or accessibility conformance. The most consequential untested state-changing flows require a separate disposable QA tenant so tests can create, return, pay, reset, and reconcile records without damaging the owner's demo.

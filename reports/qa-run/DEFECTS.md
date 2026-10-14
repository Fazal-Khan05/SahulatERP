# SahulatERP SQA run: defect register

Drafted 14 October 2026 from branch `qa-execution`. Sources: `reports/qa-run/results.json` (2,000 cases: 1,829 pass, 114 fail, 57 manual, 0 not run), `vitest.json` (engine pass) and the Playwright files `playwright.json`, `playwright-money.json`, `playwright-shell.json`, `playwright-print-ui.json` (PRN/UIX/DAT, final). `playwright-shell-isolation.json` and `playwright-shard-uix.json` are confirming reruns: they reproduced the same NAV and UIX failures.

## Summary

The 114 failing cases come from **76 distinct root causes**. Each case is assigned to exactly one cause. **Eight are S1, and they block release.** Two put the ledger out of balance: a supplier bill priced at a different FX rate from its GRN, and reversing an opening-stock journal. Two pay or show the wrong amounts: supplier payments are accepted when they differ from their allocations, and payroll accepts 31 days of attendance on import. Quantity and price precision is not enforced, so invoiced and moved quantities can disagree. The supplier statement adds payments to the balance instead of subtracting them. Database RLS lets every member read every document. Every non-Auditor role can change company settings, branding and modules. The S2 group adds features that cannot be used on a real company: payroll needs settings that have no screen, and the Imports screen cannot create shipments or add costs. It also covers printed documents that show wrong currency, tax details or totals, and four security weaknesses (open redirect, CSV injection, branding path traversal, and audit entries recording a display name instead of a user ID). Most S3 and S4 items are about phone layout, search, filters, accessibility and wording. Money invariants not listed here passed, including every commission case.

| Severity | Distinct defects | Failing cases |
|---|---|---|
| S1: wrong money/stock/permission/security, or data loss | 8 | 15 |
| S2: feature unusable, no workaround | 14 | 20 |
| S3: workaround exists | 26 | 47 |
| S4: cosmetic | 28 | 32 |
| **Total** | **76** | **114** |

Severity note: when the per-area agents rated the same cause differently, the register uses the stricter rating where the ledger, stock or tenant data is affected, and the milder one where the data is correct and only a view or message is wrong. Disputed ratings carry a "Why:" line.

---

## S1: release blockers

**D-01 · S1 · Supplier statement adds payments to the balance**
Cases: PUR-044, PTY-099, RPT-012.
What happens: a supplier payment increases the statement balance. In PUR-044 the statement shows 417,200 owed when 137,200 is owed.
Expected: bills raise the balance; payments and returns lower it.
Where: `src/modules/erp/reports.ts:61` `partyStatement`. The receipt amount is always negated and then multiplied by `sign` (−1 for suppliers).
Fix: sign each event by party type before applying `sign` (a supplier payment should be `+amount`), or drop the double flip.

**D-02 · S1 · Supplier payment amount need not equal its allocations; the difference is booked as an FX gain/loss**
Cases: PUR-032, PUR-085.
What happens: paying 5,000 against a PKR bill allocated at 4,000 is accepted, and 1,000 is posted to 5400 as an exchange loss. The "PKR actually paid" field is shown for every supplier, including all-PKR ones.
Expected: refuse with "Allocations must equal the receipt amount." unless an allocated bill is in a foreign currency.
Where: `engine.ts:136` (`create_receipt` checks equality for customers only), `engine.ts:106` `clearReceipt` (variance to 5400), `src/components/document-dialogs.tsx:152`.
Fix: require equality whenever every allocated bill is PKR, and show the field only for non-PKR bills.

**D-03 · S1 · Bill rate different from GRN rate leaves a GRNI residue**
Cases: PUR-020.
What happens: the GRN credits 2010 at the GRN rate, but the bill debits 2010 at the bill rate. 2010 keeps a 5,000 debit and nothing posts to 5400.
Expected: 2010 cleared at the GRN value; the rate difference posted to FX (5400).
Where: `engine.ts:93`, the `supplier_invoice` posting when `parentId` is set.
Fix: debit 2010 with the GRN's booked value and post the difference to 5400.

**D-04 · S1 · An opening-stock journal can be reversed and breaks the inventory control**
Cases: ACC-017.
What happens: `reverse_journal` reverses the Dr 1200 / Cr 3000 journal from `bulk_stock_increase` (purpose `opening_stock`). Stock moves stay, so 1200 no longer equals the stock valuation.
Expected: refused with the "Use the source document's correction workflow…" message.
Where: `engine.ts:178`. The guard only catches document IDs, sourceIds containing ":", or memos starting "Opening"; this journal's memo is the user's reason.
Fix: tag stock-backed journals (sourceId or a flag) and refuse to reverse any journal that has stock moves.

**D-05 · S1 · Amount, quantity and FX precision is not enforced at input (the 4-dp gap)**
Cases: SAL-013, DAT-004, PRD-035, PRD-016, PUR-095.
What happens: values are stored as typed (price 12.345678, rate 280.12345, quantity 0.00001). Stock moves are rounded to 4 dp, so a line of 0.00005 moves 0.0001 (DAT-004). A quantity of 0.00001 is accepted (SAL-013). Opening quantity 0.00001 creates a zero-quantity move that carries value (PRD-035).
Expected: quantise to the defined precision (half-up), then refuse any quantity that rounds to 0.
Where: `engine.ts:20-22` (the `decimal`, `pos`, `nonneg` schemas never quantise) and `engine.ts:51` `move()` (`money(quantity)`).
Fix: quantise in the schemas (amount/quantity 4 dp; FX rate at a defined precision) and re-check `> 0` after rounding.
Why S1: invoiced and stocked quantities disagree. The [documented] DAT-005 case (FX stored as entered) must be decided together with this fix.

**D-06 · S1 · Payroll attendance import accepts 31 days and overpays**
Cases: PAY-032.
What happens: the attendance import caps at 31, but `save_employee` caps at 30. Basic pay is salary × attendance ÷ 30, so 31 days pays 31/30 of salary.
Expected: 31 is a row error.
Where: `engine.ts:204` (`import_records` attendance uses `.max(31)`).
Fix: share one attendance schema (`max(30)`) between the import and `save_employee`.

**D-07 · S1 · RLS lets any member read every document in the tenant**
Cases: SEC-030.
What happens: a Salesperson querying PostgREST directly with the publishable key reads `goods_receipt`, purchase documents and other people's sales. The API projection is scoped correctly; the database is not.
Expected: role-scoped RLS matching `scopeWorkspace`.
Where: `supabase/migrations/202610120001_transactional_projection.sql:40-53`. The role-scoped loop omits `documents` (and likely `parties`, `receipts`, `stock_moves`), which keep the plain tenant-member policy.
Fix: add role-aware policies for the remaining projection tables, with RLS tests per role on the direct path.

**D-08 · S1 · Every non-Auditor role can change company settings, branding and modules**
Cases: SEC-100.
What happens: Salesperson, Recovery Officer, Warehouse Manager and Payroll Administrator can run `save_company`, `save_branding` and `set_modules` on the server.
Expected: Owner/Accountant only once setup is complete.
Where: `engine.ts:23`, the `allow` map (`save_company:["Accountant","Sales Manager","Salesperson",…]`), which was widened for the setup wizard.
Fix: allow setup-time saves only while `setupComplete` is false; after that, restrict to Owner/Accountant.

## S2

| ID | Title | Cases | What happens → expected | Where | Fix direction |
|---|---|---|---|---|---|
| D-09 | Payroll cannot run on a real company | PAY-062 | Engine demands "Settings → Payroll", which does not exist; no UI calls `save_settings` → a Payroll settings section | `engine.ts:124` `payrollConfigured`; `settings-view.tsx` | Add a Settings → Payroll form (EOBI, tax, numbering) shown while Payroll is on |
| D-10 | A stale draft payroll cannot be fixed | PAY-025 | After a commission changes, review is refused, there is no cancel command, and the month cannot be recreated → a cancel or recalculate path | `engine.ts:139-140` | Add `cancel_payroll` (draft only) or a recalculate action |
| D-11 | Imports screen is read-only | IMP-054, IMP-055 | No control to create a shipment or add or classify a cost (engine only) → add-cost dialog with classification help | `workbench.tsx:183` (imports view) | Build new-shipment and add-cost dialogs over the existing commands |
| D-12 | Aged balances for a past date include later receipts | RPT-004 | As of 30 Sep, an invoice paid on 10 Oct shows 0 → 1,000 in 1–30 days | `reports.ts:28` (current `outstanding()`) | Rebuild the open amount from allocations dated ≤ `asOf` |
| D-13 | Branch-limited Accountant sees an empty P&L | RPT-044 | Journals are withheld, so the P&L shows 0 revenue as if real → hide the ledger reports or mark them company-wide | `workbench.tsx:140` `ledgerView` ignores `branchIds` | Add `&& !actor.branchIds.length` |
| D-14 | Foreign-currency documents print "Rs" | PRN-026, PRN-072 | A USD PO prints "Rs 100" with no PKR equivalent → "$10.00" plus PKR totals | `money.ts:15` `formatMoney`; `document-preview.tsx:61-68` | Pass the currency to the formatter; add a PKR total line |
| D-15 | Reprint ignores the invoice-time tax snapshot | PRN-069 | Prints the party's current NTN/registration → the `taxSnapshot` values | `documents.ts:70` | Read `doc.taxSnapshot` for the tax ID and status |
| D-16 | App-wide table CSS leaks into the print template | PRN-039, PRN-040, PRN-044, PRN-045, PRN-046 | Totals table is 100% wide, so notes shrink to 0 px, "Balance due" is clipped on Letter and on long A4 invoices, long names don't wrap, and a 10-line invoice takes 2 pages → printed totals in full | `globals.css` `table`/`td` rules reach `.doc` | Scope the app table rules away from `.doc`; give totals a fixed width |
| D-17 | Retry after commit returns an empty record ID | DAT-011 | Replay returns `recordId ""` with "already completed", so the editor skips the follow-up submit → the original result | `engine.ts:127` | Store the result with the idempotency key and return it on replay |
| D-18 | Open redirect in `/auth/callback?next=` | SEC-089 | `/\evil.com` passes the `startsWith('/')` check and lands on evil.com → stays on the same origin | `auth/callback/route.ts:10` | Resolve the URL and compare origins, or allow-list paths |
| D-19 | Branding path traversal | SEC-054 | `<tenant>/../<other>/logo.png` passes the prefix check, and paths are signed with the service role → refused | `engine.ts:186` | Accept only exact `${tenant}/(logo\|letterhead).(png\|jpg)` |
| D-20 | CSV formula injection | SEC-053 | `toCsv` writes `=cmd()`, `+`, `@` and `-` cells unchanged → neutralised | `master-data.ts:183` | Prefix risky leading characters with `'` |
| D-21 | Audit records the editable display name | SEC-066 | `actor: actor.name` → user ID plus role | `engine.ts:218` | Store `actor.userId`; show the name at read time |
| D-22 | Back after sign-out shows workspace content | AUTH-019 | Browser history cache restores `.app-shell` → login | `next.config.ts` headers; no `no-store` on app pages | Send `Cache-Control: no-store` on authenticated pages |

Why: D-14, D-15 and D-16 are S2, not S1, because the ledger is correct; only the customer-facing document is wrong, with no in-app way to print it correctly. D-19 is S2, not S1, because exposure is limited to another tenant's logo or letterhead, and only if storage resolves `..`. D-12 and D-13 are S2 because the ledger and today's ageing are right; only the historical or branch view is wrong.

## S3

| ID | Title | Cases | What happens → expected | Where | Fix direction |
|---|---|---|---|---|---|
| D-23 | Raw "[DecimalError] Invalid argument" shown | PRD-014, PRD-031, PUR-007 (also SAL-009 [documented]) | Zod 4 runs the chained `pos`/`nonneg` refines after the `decimal` refine fails, and `D("")` throws → "Enter a valid number…" or "Amount must be greater than zero." | `engine.ts:20-22` | Use `{abort:true}`/`superRefine`, or guard `D()` in the later refines |
| D-24 | Draft and cancelled documents print without a status | PRN-020, PRN-021 | No DRAFT/CANCELLED mark → a visible status banner | `document-preview.tsx` (ignores `view.status`) | Show a watermark or banner when status ≠ submitted |
| D-25 | Bounced cheque missing from the statement | RPT-053 | Only cleared receipts are listed → receipt plus reversal lines | `reports.ts:57` | List bounced receipts with a matching reversal |
| D-26 | Sales analysis ignores commission splits | RPT-072 | Split lines fall into "Unassigned" → 60/40 shares | `reports.ts:100` `keyOf` | Apportion line net by `splits` |
| D-27 | Omitted `taxRate` defaults to 18% on a company with no tax rate | SET-085 | API line without a rate → 18% instead of 0 (UI sends a rate) | `engine.ts:57` `lineInput` | Default from `settings.taxRate` (blank = 0); see the decisions section |
| D-28 | Salesperson's "No, don't save" fails on a fresh company | PTY-030 | Creating the shared walk-in account needs `save_party`, which is refused → the No path works | `document-editor.tsx:127` | Provision walk-in accounts at setup, or create them server-side inside `create_document` |
| D-29 | Whitespace-only names are stored empty | PRD-095, DAT-075 | `min(2)` runs before trim, so "   " saves as "" → refused | `engine.ts:180-181` | `z.string().trim().min(2)` |
| D-30 | Unexpected errors return 400 with raw text and are not logged | SEC-068, DAT-060 | TypeError text, or "Unexpected request failure.", returned as 400 → 500, generic message, server log | `api/workspace/route.ts:14-22` | Map only known domain errors to 4xx; log and 500 the rest |
| D-31 | Session cookies readable by JavaScript | AUTH-065 | `@supabase/ssr` default `httpOnly:false` → HttpOnly | `src/lib/supabase/*` cookie options | Server-only session cookies, or an accepted risk with a CSP |
| D-32 | Workspace POST accepts any content type | SEC-046 | `text/plain` → 200 instead of 400 | `api/workspace/route.ts:39-41` | Require `application/json` |
| D-33 | Command dropped if the browser closes mid-request | DAT-058 | Session and snapshot are read before the body, so an aborted body loses the command; invoice stays draft → server completes it | `api/workspace/route.ts:37-39` | Read the body first (low priority: nothing is corrupted) |
| D-34 | 401 in another tab shows an error, not the login | AUTH-049 | `command()` shows the message → redirect to login on 401 | `workbench.tsx:146` | On 401, go to login |
| D-35 | Phone top bar is wider than the screen | UIX-001, UIX-005, UIX-099, ONB-067, ONB-069 | `.topbar-right` pushes the page to 392–431 px at 390 px (also behind the setup card; the Documents-step preview adds width) → no horizontal scroll | `globals.css` topbar rules | Let the top bar shrink: hide the date/breadcrumb and let the search collapse |
| D-36 | Large data sets render slowly | INV-086, COL-084, NAV-028, PTY-098 | Stock tab 7.6 s, Collections 6.2 s, search 300–976 ms per keystroke, 10k-customer datalist 1.5 s → under 2 s / 100 ms | Whole workspace rendered client-side; no pagination or virtualisation | Paginate or virtualise lists; cap datalist and search results |
| D-37 | 20 MB CSV freezes the tab before being refused | PRD-076 | 3 s main-thread block → refuse early | `csv-import-dialog.tsx` | Check size or row count before parsing; parse in a worker |
| D-38 | Search dialog keyboard and record opening | NAV-015, NAV-026, NAV-027 | Enter and arrow keys do nothing; a click opens the module, not the record → select and open | `workbench.tsx` search dialog | Add an active index and open the record dialog on select |
| D-39 | Search does not cover journals, cheques or shipments | ACC-053, COL-076, IMP-056 | Not findable by JV number, cheque number or container → found | Global search covers documents, parties and items only | Extend the search index |
| D-40 | Missing list filters and sort | COL-075, IMP-082, IMP-083 | No receipt method/status filter, no shipment status filter, shipments oldest first → filters, newest first | `workbench.tsx` Collections and Imports cards | Add the filter bar used on Sales; sort by date descending |
| D-41 | No customs/GD lookup (simulated) | IMP-037 | Not present → lookup returns stub data | Imports view | Add the simulated lookup or remove the case |
| D-42 | Overdue supplier bills not in the attention queue | PUR-070 | No payable entry → listed when past due | `workbench.tsx:57` `attentionItems` | Add an overdue-bills queue |
| D-43 | Report printing is unusable | RPT-011, RPT-048 | Sidebar and grey background print, and the statement omits the customer when the parameter row is hidden → clean print with header and period | `globals.css` print rules; `reports-view.tsx` | Add `@media print` for reports and a printed title line |
| D-44 | No per-employee payroll lines view | PAY-063 | Runs show totals only → a per-employee lines table that scrolls on phone | Payroll view | Add a run-detail table |
| D-45 | Focus is lost when a dialog closes | UIX-030 | Focus drops to `<body>` → returns to the trigger | Dialog wrappers in `document-dialogs.tsx`/`workbench.tsx` | Keep a mounted trigger, or restore focus manually |
| D-46 | Notice off-screen on phone | UIX-089 | Notice renders above the heading out of view → visible after the action | `workbench.tsx` notice placement | Use a toast or sticky notice |
| D-47 | Colour contrast failures | UIX-024, UIX-027, UIX-092 | Danger badge 4.15:1, setup footer about 1.9:1, `.doc-title-meta th`, unfocusable scroll regions → 4.5:1 and axe clean | `globals.css` tokens; `.table-scroll` | Darken the danger token, make the footer scrim opaque, add `tabindex` to scroll regions |
| D-48 | Stale setup card in a second session | ONB-088 | "Setup is already complete." stays on the card → open the workspace | `setup-wizard.tsx` | On that error, reload the workspace |

Why: D-23 is S3 even though PRD-031 and PUR-007 are P1: nothing wrong is saved, only the message is unreadable. D-35 is S3 because the app is still usable by scrolling sideways.

## S4

| ID | Title | Cases | Where / fix direction |
|---|---|---|---|
| D-49 | Offline errors read "Failed to fetch" | AUTH-061, ONB-093 | Login and branding upload `catch`: map `TypeError` to a "No internet connection" message |
| D-50 | Forgot password with empty email sends a request | AUTH-032 | `login-screen.tsx` `reset()`: check the email first |
| D-51 | Login submit enabled before hydration | AUTH-083 | `login-screen.tsx`: render disabled until mounted |
| D-52 | Refreshing `/account/reset` after success shows the form again | AUTH-084 | `reset-password.tsx`: show a completed or expired state |
| D-53 | Reduced motion stops the provisioning ring | ONB-061 | `globals.css:533` global `!important` rule beats `.provision-ring`; exempt the ring |
| D-54 | `set_modules` silently drops unknown keys | ONB-077 | `engine.ts:187`: refuse unknown keys |
| D-55 | Follow-up accepted on a supplier | COL-053 | `engine.ts:193`: require `type === "customer"` |
| D-56 | Metric cards never stagger | NAV-037, UIX-053 | `workbench.tsx:218` `Metrics`: set `style={{'--i':i}}` |
| D-57 | Internal wording visible | NAV-043, PAY-094 | "Revision" label in `settings-view.tsx:34`; "prototype rules" message at `engine.ts:139` |
| D-58 | Long company name wraps in the switcher | NAV-082, UIX-083 | Sidebar switcher: add `nowrap` + `text-overflow: ellipsis` |
| D-59 | Escape does not close the phone drawer | NAV-054 | Add a keydown handler on `.sidebar.mobile-open` |
| D-60 | "Draft sales documents" link does not preset the filter | NAV-076 | Pass `status=draft` when navigating to Sales |
| D-61 | Phone search input is 15.2 px (iOS zooms on focus) | NAV-080 | `.search-dialog .search-input` overrides the 16 px phone rule; raise its specificity |
| D-62 | Tablet Overview overflows (799 px at 768) | UIX-003 | Wrap the metric grid to two columns below about 900 px |
| D-63 | Phone sheets keep 20 px bottom corners | CSH-051 (and PRN-062 [documented]) | `globals.css:454` radius beats the `:636` phone rule; reorder or raise specificity |
| D-64 | Sticky hover shadow after a tap | CSH-095 | Gate the card hover in `@media (hover:hover)` |
| D-65 | Negative bank balance not red | CSH-050 | `cash-bank-view.tsx`: add a negative class |
| D-66 | Payroll status badges share a colour | PAY-064 | Four statuses use three colours; add a distinct tone |
| D-67 | Trial balance columns left-aligned | ACC-091 | Add the `num` class to the debit/credit/net cells |
| D-68 | Set-quantity dialog lacks the current value | INV-063 | `inventory-view.tsx`: show the value next to the quantity |
| D-69 | Branding preview font differs from print | SET-069 | Preview inherits Geist; apply the print font stack to the `.doc` preview |
| D-70 | Features tab has no "N turned on" count | SET-075 | Add the count to the Features header |
| D-71 | Stray border radii (3/4/5/8/9 px) | UIX-062 | Replace legacy radii with the 6/10/14/20 tokens |
| D-72 | Default (blue) focus ring on scroll regions | UIX-029 | Add the violet `:focus-visible` to `.table-scroll` and `.branding-preview-frame` |
| D-73 | Empty states offer no next action | UIX-059 | Add a primary action to the "No records yet." variants |
| D-74 | Printed quantities lack thousands separators | PRN-016 | `documents.ts:45`: format the quantity |
| D-75 | Company address newlines lost in the print header | PRN-091 | `.doc-identity span { white-space: pre-line }` |
| D-76 | Document-chain rows are not links | PRN-056 | `document-details.tsx`: make each row open its document |

## Not defects, but worth deciding

- **Tax default 18% (SAL-023, and SET-085 = D-27).** `lineInput` defaults an omitted `taxRate` to 18. Decide whether the default comes from Settings, and add a Settings field for it, since `save_settings` has no UI either (see D-09).
- **Sign-out ends every session (AUTH-019/049/090, ONB-073).** `auth.signOut()` uses global scope. Decide between global and local scope (`scope:'local'`).
- **Login pre-fills `owner@sahulaterp.com` (AUTH-001).** This is fine for the demo, but it reveals an account email on production.
- **Reset demo (SET-048, SEC-058).** The route always rebuilds the demo tenant, even when it is pressed from a non-demo workspace. Hide the button outside the demo company, or confirm which company will be reset.
- **Idempotent replay returns `recordId ""` (SEC-039).** This is recorded as accepted behaviour, but it causes D-17.
- **FX rate stored as entered (DAT-005)** conflicts with the PUR-095 expectation (D-05). Pick the FX precision before fixing D-05.
- **Cash & bank reconciliation compares the account total with itself (CSH-034)**, so it can never show a variance. This is a placeholder that looks like a control.
- **Security posture:** SameSite=Lax cookies with no Origin check and `?tenant=` accepted (SEC-048); no CSP (SEC-050); no request rate limiting beyond the password throttle (SEC-060).
- **Ledger gaps:** 2400 statutory payable is never settled in-app (PAY-081/082); bank transfers have no balance check (CSH-013); future dates are accepted everywhere (INV-017, DAT-063); a landed cost has no currency (IMP-045).
- **Snapshots:** branding is not snapshotted on documents (PRN-068), and party names are not snapshotted (PTY-086). Compare with the CLAUDE.md requirement for transaction snapshots.
- **Navigation:** no URL routing for modules or reports (RPT-090, NAV-060), so Back leaves the app.
- **Perf watch:** DAT-051 (10k documents, under 4 s) passed in the final run but measured 4.27 s in the stopped DAT shard. Treat it as borderline.

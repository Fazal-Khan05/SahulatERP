# SahulatERP — SQA re-test after fixes

**Test date:** 12 October 2026
**Baseline:** [29 September report](../qa-2026-09-29/SAHULAT_ERP_SQA_REPORT.md) (17 findings) plus 6 findings from a full code scan
**System:** local Next.js checkout against the hosted Supabase project, after applying migration `202610120001_transactional_projection.sql`

## Result

All 17 earlier findings and all 5 code-scan bugs are fixed and covered by automated tests. The sixth scan item, the commission target multiplier, needs a business decision and was left unchanged. One more defect was found and fixed during this re-test: some snapshots were stored as double-encoded JSON.

| Check | Result |
| --- | --- |
| `npm run typecheck` | Pass |
| `npm test` (domain, access, and real-migration database tests in PGlite) | **39 / 39 pass** (was 15) |
| `npm run build` | Pass |
| `owner-workspace.spec.ts` (owner journey, all modules) | Pass |
| `qa-regression.spec.ts` (each SQA finding, desktop and 390 px) | Pass, 0 browser errors |
| Hosted migration dry run (applied inside a transaction, then rolled back) | Pass, after fixing the double-encoded snapshot |
| Hosted snapshot vs relational tables after migration and a live write | Identical counts; ledger difference 0.0000 |

## Earlier findings

| ID | Finding | Fix | Evidence |
| --- | --- | --- | --- |
| SQA-01 | Every member received the full workspace | The server scopes data by role, employee and branch before sending it (`src/modules/erp/access.ts`). RLS now limits snapshots, journals, audit and bank lines to Owner, Accountant and Auditor, and salaries and payroll to pay roles. Members can no longer read the snapshot directly. | `access.test.ts`, `database.test.ts` (RLS) |
| SQA-02 | Snapshot and relational tables disagreed | `commit_workspace` writes the snapshot and the projection in one transaction. The migration rebuilt the stale projections: the hosted demo went from 8 to 9 documents and from 19 to 21 journals, now equal to the snapshot. | `database.test.ts`, hosted check |
| SQA-03 | Password-reset link opened the dashboard | Added an `/account/reset` page with a new-password form and validation. Expired or used links say so. | `qa-regression`, `account-reset-expired.png` |
| SQA-04 | "New transaction" opened a sales invoice in 6 modules | Each module has its own header action, or none | `qa-regression` (`headerDialogs`) |
| SQA-05 | Reset ran without confirmation and left tables stale | Reset now asks for confirmation and states its scope. It rebuilds the snapshot and every projection atomically, for demo tenants only. | `qa-regression`, `database.test.ts` |
| SQA-06 | A full transfer left a negative value on zero stock | Any outflow of the whole balance (transfer, sale, adjustment) moves its exact value | `fixes.test.ts` |
| SQA-07 | Role preview trapped the owner | An "Exit preview" control sits in the top bar. The preview now shows the data that role would actually receive. | `qa-regression`, `preview-*.png` |
| SQA-08 | "All branches" did nothing | A working branch filter. Ledger views say the general ledger is company-wide. | `qa-regression` (6 → 3 rows for Lahore) |
| SQA-09 | Search and ⌘K did nothing | Search dialog over documents, parties and items, opened by click or ⌘/Ctrl+K | `qa-regression` |
| SQA-10 | The dashboard chart was fabricated | Weekly invoiced sales and cleared collections, computed from records | `qa-regression` (`chartLabel`) |
| SQA-11 | Negative "Balance due" | Shown as "Customer credit Rs 53,100" with a "customer credit" status | `qa-regression` |
| SQA-12 | Numbers fixed to 2026 | Numbering uses the document's own year and continues from the highest sequence for that prefix and year | `fixes.test.ts` |
| SQA-13 | Mobile tables hid actions | The action column stays pinned, with a scroll shadow and a swipe hint | `qa-regression`, `390-sales.png` |
| SQA-14 | The mobile menu button had no name | Labelled "Open navigation"/"Close navigation", with `aria-expanded` | `qa-regression` |
| SQA-15 | Follow-up notes were discarded | Follow-ups are saved (snapshot plus a `follow_ups` table) and listed in Collections, where they can also be logged | `fixes.test.ts`, `qa-regression` |
| SQA-16 | "Today" used UTC | The date is computed in Asia/Karachi everywhere, and forms now show the posting date | `fixes.test.ts`, `qa-regression` |
| SQA-17 | The bell was decorative | The bell lists due queues (approvals, cheques, follow-ups, drafts) with a count | `qa-regression` |

## Code-scan findings

| Finding | Fix | Evidence |
| --- | --- | --- |
| Membership queries didn't filter by user. A second member would break `.single()`, and the page could show another user's role. | Every membership query filters by `user_id`; RLS shows other members' rows only to owners | `database.test.ts` |
| Database integrity triggers never ran on live writes | Each save goes through one transaction, so the balance, immutability and source-uniqueness checks now reject bad data and roll back the whole save | `database.test.ts` (unbalanced journal, rewritten journal, duplicate source) |
| A late landed cost on transferred stock went to COGS | Allocation follows the received units (receiving warehouse first, then transfer destinations). Only real consumption goes to COGS. | `fixes.test.ts` |
| Commission once included in a paid payroll could never be paid again | Only an unpaid run reserves a commission. Later releases are paid in the next run. | `fixes.test.ts` |
| Commission paid before a cheque bounced was never recovered | Payroll deducts the overpayment (without taking net pay below zero) and records a `recovery_recorded` movement. Commission payable reconciles. | `fixes.test.ts`; Reports now also reconcile commission payable |
| `import_records` ran nested commands as Owner | Nested commands run with the caller's own role | `fixes.test.ts` |
| Correction: supplier exchange difference | Not a bug. Supplier payments already post exchange variance to account 5400. | — |

**Found during this re-test:** the hosted Design Partner snapshot was stored as a JSON *string*, not an object, because of an earlier seed. The migration converts such snapshots to objects, `commit_workspace` rejects non-object data, and the database test now reproduces this hosted state.

## Hosted data touched by this re-test

- The migration was applied once, after a successful rolled-back dry run. Snapshots were not modified, apart from converting the Design Partner snapshot from a string to an object.
- One live write was made to the demo company to prove the transactional path end to end. It re-imported an existing bank-statement line, which the engine skips as a duplicate. The only effects are revision 44 → 45 and one audit entry. Replaying it was correctly refused as already done.
- Nothing else was submitted, paid, reset or deleted.

## Still open (decisions, not defects)

1. **Service-role reads.** The server still reads the snapshot with the service-role key, after an explicit membership check, and then scopes it per role. CLAUDE.md requirement 4 wants ordinary runtime queries off that key. Doing so means making the normalized tables the source of truth and using a restricted database role. That is the next architectural step and needs the schema/posting review (backlog D10). Writes go through one function that only the service role can execute.
2. **Commission target multiplier.** It applies to the whole line once the target is crossed. Confirm with reviewed partner examples.
3. **Real non-owner accounts.** Role and branch scoping and RLS are tested with unit tests and real migrations (PGlite, `set role authenticated`). Hosted Supabase still has only the owner user, so a live cross-role test needs a second account that you create. Set `memberships.employee_id` for salespeople.
4. **Credential rotation.** As recommended on 29 September, rotate the database and service-role credentials before inviting partners.

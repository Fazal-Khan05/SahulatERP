# Fix protocol for the QA defect register

Applies to every agent fixing defects from `reports/qa-run/DEFECTS.md` (76 root causes, D-01…D-76). Each agent works in its own git worktree, owns a fixed set of files, and fixes its defects **one at a time: fix → test that feature → commit → next**.

## 1. Setup (once, inside your worktree)

```bash
[ -e node_modules ] || ln -s /Users/fazalkhan/Desktop/ERP/node_modules node_modules
cp /Users/fazalkhan/Desktop/ERP/.env.local .env.local
npx tsc --noEmit && npm test          # must be green before you start (77 domain tests)
```

`.env.local` and `node_modules` must never be committed (both are git-ignored; check `git status` before each commit).

## 2. The loop, for each defect you own

1. Read the defect entry in `reports/qa-run/DEFECTS.md` and every failing test for its case IDs: `grep -rn "<CASE-ID>" tests/qa tests/qa-browser`.
2. Fix the **root cause** in product code. Keep the existing style. `src/modules/erp/engine.ts` is written on very long lines: edit precisely with exact string replacement, never reformat or re-wrap it.
3. Update the tests:
   - The `[defect]` test for each case must now pass. Remove ` [defect]` / `[defect: …]` from its title and keep it asserting the expected behaviour.
   - If the case's expected result was itself wrong, correct the assertion and tag the title `[case-corrected: <truth>]`.
   - Case IDs must stay unique, so never add a second test for an existing case ID. Extra regression tests go in your own file `tests/domain/fixes-<agent letter>.test.ts` (e.g. `fixes-a.test.ts`), titled `D-xx …`. Only you write that file.
4. Test the feature you touched, and only move on when all of these pass:
   - the QA file(s) for that area: `npx vitest run --config vitest.qa.config.ts tests/qa/<NN-area>.test.ts` (other agents' still-open `[defect]` tests may fail; yours must not);
   - `npm test` and `npx tsc --noEmit`;
   - for anything visible in the UI, the matching browser tests (section 3), run with `-g "<CASE-ID>"`.
5. Commit just that defect: `git commit -m "Fix D-xx: <title>"` with the trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

Finish with one full run of every QA file and browser spec you touched, then report.

## 3. Browser tests (only agents that own UI)

Each browser agent has its **own port and its own disposable QA company**. Never use anyone else's.

| Agent | Port | QA tenant |
|---|---|---|
| C reports | 3101 | 33333333-3333-4333-8333-333333333334 |
| D security | 3102 | 33333333-3333-4333-8333-333333333335 |
| E printing | 3103 | 33333333-3333-4333-8333-333333333336 |
| F shell | 3104 | 33333333-3333-4333-8333-333333333337 |
| G1 auth | 3105 | 33333333-3333-4333-8333-333333333338 |
| G2 forms | 3106 | 33333333-3333-4333-8333-333333333333 |

```bash
# create/reset your QA company (touches only that tenant)
QA_TENANT_ID=<tenant> npx tsx scripts/create-qa-tenant.ts
# start your server in the background when you need it; stop it when you're done
npx next dev --webpack --hostname 127.0.0.1 -p <port>
# run browser tests
QA_TENANT_ID=<tenant> QA_BASE_URL=http://127.0.0.1:<port> QA_PW_JSON=reports/qa-run/playwright-fix-<agent>.json \
  npx playwright test --config playwright.qa.config.ts --output=test-results/fix-<agent> tests/qa-browser/<NN>-*.spec.ts -g "<CASE-ID>"
```

- **Never run tests that sign the owner out** (AUTH-019, AUTH-049, AUTH-090, ONB-073 and any test whose steps press Sign out). Supabase signs the shared owner out everywhere, which breaks every other agent. Those run in the final integration pass. Skip them with `-g` / `--grep-invert`.
- Rerun any browser failure once in isolation before believing it.
- Stop your dev server at the end (`kill` the process you started).

## 4. Safety rules

- Edit only the files you own (section 5). If a fix needs a change in another agent's file, don't make it: describe the exact change in your report.
- Don't edit `tests/qa/helpers.ts` or `tests/qa-browser/helpers.ts`; define local helpers in your own test files.
- Never apply migrations to the hosted database, never run `company:reset`, `member:create`, `demo:reset`, `db:*`, and never touch any company other than your own QA tenant. No pushes, no deploys, no merges to `main`.
- Never print secrets from `.env.local`.

## 5. File ownership (wave 1)

| Agent | Defects | Files it owns |
|---|---|---|
| **A engine-money** | D-02, D-03, D-04, D-05, D-06, D-23, D-27, D-28, D-36 (invoice editor datalist only) | `engine.ts` regions: value schemas (lines ~15–17), `move()` (~55), `lineInput` (~57), `createDocument` (~59–75), sales/purchase posting in `submit()` (~86–93), `clearReceipt` (~105–106), `create_receipt` (~136), `reverse_journal` (~178), `bulk_stock_increase` (~165–171), `import_records` (~200–216). Also `src/components/document-editor.tsx`, `src/components/document-dialogs.tsx`. |
| **B engine-hardening** | D-08, D-10 (engine command only), D-17, D-19, D-21, D-29, D-54, D-55, D-57 (engine message only) | `engine.ts` regions: command enum (line 9), roles map (lines ~19–22), `execute()` entry (~125–127), payroll commands (~139–143), `save_party`/`save_item` (~180–181), `save_branding`/`set_modules` (~186–187), `follow_up` (~193), audit/operations push (~217), `provisionModules` (~118–121). Also `src/modules/erp/types.ts`, `codec.ts`, `modules.ts`, `access.ts`. |
| **C reports** | D-01, D-12, D-25, D-26, D-43 | `src/modules/erp/reports.ts`, `src/components/reports-view.tsx`, a new `src/app/reports-print.css`. |
| **D security** | D-07, D-18, D-20, D-22, D-30, D-32, D-33 | new files in `supabase/migrations/`, `src/app/api/**`, `src/app/auth/callback/**`, `toCsv` in `src/modules/erp/master-data.ts`, `next.config.*`, a new `middleware.ts`/`proxy.ts` if needed. |
| **E printing** | D-14, D-15, D-16, D-24, D-47 (printed `.doc-title-meta th` colour only), D-69, D-74, D-75, D-76 | `src/modules/erp/documents.ts`, `src/modules/erp/money.ts`, `src/components/document-preview.tsx`, `src/components/document-details.tsx`, `src/components/print-actions.tsx`, `src/app/print/**`. Fix print leakage in `print.css` only (don't edit `globals.css`). |
| **F shell** | D-13, D-34, D-35, D-36 (global search only), D-38, D-39, D-42, D-46, D-47 (tokens, danger badge, setup footer, scroll-region focusability), D-53, D-56, D-58, D-59, D-61, D-62, D-63, D-64, D-71, D-72 | `src/components/workbench.tsx` **lines 1–172 and the `Metrics` function only** (not `View`, `TableCard` or the module views), `src/app/globals.css`, `src/app/tokens.css`, `src/app/layout.tsx`. |
| **G1 auth** | D-31, D-49 (login only), D-50, D-51, D-52 | `src/components/login-screen.tsx`, `src/components/reset-password.tsx`, `src/lib/supabase/*`, `src/app/auth/signout/**`, new sign-in route handlers under `src/app/auth/`. |
| **G2 forms** | D-09, D-37, D-45, D-48, D-49 (branding upload only), D-57 (Settings "Revision" label only), D-65, D-68, D-70, D-73 (empty states in the files it owns) | `src/components/settings-view.tsx`, `setup-wizard.tsx`, `branding-form.tsx`, `csv-import-dialog.tsx`, `cash-bank-view.tsx`, `inventory-view.tsx`, `item-details.tsx`, `record-form.tsx`, `master-data-view.tsx`, `documents-list.tsx`, `company-form.tsx`, `module-picker.tsx`, `src/components/ui/dialog.tsx`. |

Wave 2 (after wave 1 is merged) takes the `View` part of `workbench.tsx`: D-10 (cancel button), D-11, D-36 (collections list), D-40, D-44, D-60, D-66, D-67, D-73 (workbench empty states). D-41 is out of scope (customs lookups are simulated/out of scope in the test plan); the case is withdrawn.

## 6. Contracts between agents

- **D-28 walk-in (A):** `create_document` and `update_document` accept `walkIn: true` together with `partyName` instead of `partyId`. The engine finds or creates the shared "Walk-in customer" / "Walk-in supplier" (party type from the document kind) itself, so it works for any role allowed to create the document. The invoice editor's "No, don't save" sends this instead of calling `save_party`.
- **D-27 tax default (A):** a line without `taxRate` takes the company's `settings.taxRate`, or 0 when it is blank. **D-09 (G2)** adds the Settings → Payroll & tax form over the existing `save_settings` command (do not change its payload).
- **D-10 (B):** add `cancel_payroll` (draft or reviewed runs only; releases held commissions) to the engine with the same roles as `update_payroll`. Its button comes in wave 2.
- **D-14 (E):** `formatMoney(value, currency?)` keeps its current output when `currency` is omitted or `PKR`, so existing callers don't change.
- **D-47:** F darkens the danger colour tokens and the setup footer; E fixes the printed `.doc-title-meta th` colour.
- **D-57:** B fixes the engine's "prototype rules" message; G2 removes the Settings "Revision" label.

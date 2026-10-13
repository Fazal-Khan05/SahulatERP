# Master data screens and CSV import/export — QA record

**Date:** 14 October 2026 · **Scope:** backlog T01, [plan](../../docs/plans/2026-10-14-master-data.md)

## Result

| Check | Result |
| --- | --- |
| `npm run typecheck`, `npm run build` | Pass |
| `npm test` — 58 tests (8 new in `master-data.test.ts`) | Pass |
| `master-data.spec.ts` on the QA tenant | Pass |
| `onboarding.spec.ts`, `owner-workspace.spec.ts`, `qa-regression.spec.ts` | Pass; demo unchanged |

## Verified in the browser

- Customers tab under Sales: create through the form, engine validation shown inline (duplicate name refused), edit, archive (disappears from the active list and from the new-invoice picker), restore from the archived filter.
- Products tab under Inventory: CSV import with headers in FastAccounts/Excel style ("Item Code", "Product Name", "Selling Price", "UOM") mapped automatically; a file with a blank SKU is rejected naming the row and nothing is saved; the corrected file imports with a count message; export writes a CSV with the importer's own headers.
- Warehouses tab: add and rename branches inline, add a warehouse under a branch.
- Commission plans tab under Commissions: edit plan type and category rates as `Category = %` lines.
- Employees tab under Payroll and Salespeople tab under Commissions share one screen; deactivate/reactivate uses the employee's active flag.

## Defects found and fixed during QA

1. **Dev-server compile race.** A command sent while the Next dev server compiled another route (the logo image request) got an HTML 500 from Next itself ("Unexpected end of JSON input" inside Next, not in app code). Fixed by a transparent single retry in the app's command client, safe because every command carries an idempotency key; Playwright now also warms routes in `global-setup.ts`.
2. **Required-field asterisk wrapped to its own line** in generated forms.
3. **Test order dependence:** the master-data spec now completes company setup itself if it runs on a fresh QA tenant.

## Engine behaviour worth knowing

- Imports are all-or-nothing: every row is run through the real `save_*` command on a staging copy; any failure lists row numbers (file row numbers, header = row 1) and nothing is written.
- `upsert` matches products by SKU and people by name; blank cells keep current values.
- Defaults never invent money: imported credit limit is 0 unless given.
- Managers can be referenced by name within the same employee file.

## Deferred

Units of measure, price lists per customer class, custom fields and attachments on records; warehouse archiving.

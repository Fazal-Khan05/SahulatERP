# Plan: Master data screens and CSV import/export (backlog T01)

Status: **built 14 October 2026** (branch `master-data`); QA record in [reports/qa-2026-10-14/MASTER_DATA_QA.md](../../reports/qa-2026-10-14/MASTER_DATA_QA.md). Follows [2026-10-13-onboarding-modules-branding.md](2026-10-13-onboarding-modules-branding.md).

## Why this slice

Every later workflow (documents, receipts, payroll, commissions) needs customers, suppliers, products, employees, warehouses and plans that the owner can create and edit without a seed script. FastAccounts users expect list screens with search, an edit form, Excel/CSV import and export. The engine already has `save_party`, `save_item`, `save_employee`, `save_plan` and a basic `import_records`; none has a screen.

## What the user gets

- **Where:** tabs inside the module each record belongs to, so module toggles apply automatically.
  - Sales → Documents · **Customers**
  - Purchasing → Documents · **Suppliers**
  - Inventory → Stock · **Products** · **Warehouses & branches**
  - Commissions → Entitlements · **Plans** · **Salespeople**
  - Payroll → Runs · **Employees**
- **List screens:** search, status filter (active/archived), record count, **Export CSV**, **Import CSV**, **New**. Row actions: Edit, Archive/Restore.
- **Edit form** in a dialog, generated from one field specification per entity, with the same validation messages the engine returns.
- **Archive, never delete.** Archived customers, suppliers and products disappear from pickers and new documents but keep their history and reports. Employees already have an active flag; warehouses cannot be archived in this slice.
- **CSV import:** choose a file, columns matched by header name (case-insensitive, synonyms like "Customer name" → name), preview the first rows, see every validation error with its row number before anything is saved, choose "Create only" or "Create and update existing" (matched by SKU for products, by name for customers/suppliers/employees). The import is one command, so it is all-or-nothing and audited once.
- **CSV export** of the visible (filtered) rows with the same headers the importer accepts, so a round trip works.
- **Template download** for each entity: a CSV with headers and one example row.

## Engine and data

- `Party` and `Item` gain `archived?: boolean`; `set_archived { kind: "party" | "item", id, archived }`.
- `save_branch { id?, name }`, `save_warehouse { id?, name, branchId }`; ids are generated slugs; renaming allowed; a branch with warehouses cannot be removed (no removal in this slice).
- `createDocument` refuses archived parties and items ("… is archived. Restore it first.").
- `import_records` rewritten: kinds `customers | suppliers | items | employees | attendance`; `mode: "create" | "upsert"`; validates every row first and reports all errors with row numbers; returns counts. Blank optional columns fall back to sensible defaults (terms 30, class "Retailer", unit "pcs"), never to invented money amounts: credit limit defaults to 0 (previously 500,000).
- `moduleOfCommand` maps the new commands to their modules.
- No schema change: parties, items, warehouses and branches are already projected; `archived` lives in the `data` JSON.

## UI pieces

- `master-data-view.tsx` — generic list + dialog driven by an entity spec (`src/modules/erp/master-data.ts`: fields, columns, CSV headers, defaults, row-to-payload).
- `csv-import-dialog.tsx` — papaparse in the browser, header mapping, preview, errors, mode.
- `record-form.tsx` — renders text, number, money, select, checkbox and key=value list fields from the spec.
- Tabs added to the Sales, Purchasing, Inventory, Commissions and Payroll views.
- Pickers (new document, receipt, transfer, item details) exclude archived records.

## Tests

- Engine: branch/warehouse create and rename, archive/restore, archived party or item refused on documents, import create vs upsert, all-or-nothing on a bad row with row-numbered errors, attendance import unchanged.
- Browser (`master-data.spec.ts` on the QA tenant): create a customer and a product through the forms, archive and restore, import a 3-row CSV with one bad row (rejected with the row number) then a clean one, export and check headers.

## Out of scope here

Multiple units of measure, price lists per customer class, custom fields, attachments on records, multi-line document entry (next slice, T02/T04).

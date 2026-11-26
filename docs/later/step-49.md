# Step 49: bringing a company in from another system

Joint step, built by the Finisher (2026-11-26) after Fazal signed in as the demo owner and asked
for importing Excel files ("everything from old erps"). Migration `0047_data_imports` (one table,
the record of each import), after the Builder's `0046_daily_expenses`; the coordinator applies it
to the shared database once merged. Version 1.4. The checklist for a company moving in is
`docs/MIGRATION.md`.

## What is built

- **Settings, Import data** (`/settings/import`, a tab for the owner and an accountant): the seven
  kinds of file in the order a company is best brought in, each with a plain explanation, what has
  to be in place first, what the company has now and the last file imported, a template to
  download (Excel or CSV, our headings), and the way in. Then **Check what came in**, and the list
  of everything imported so far (when, what, which file, how many rows, by whom).
- **The kinds**: customers, suppliers, items (with category, units and prices as far as the item
  screen has them), opening stock (quantity and cost per warehouse), what customers owe (unpaid
  invoices), what is owed to suppliers (unpaid bills), and the trial balance.
- **Any old system's file** (`/settings/import/<kind>`): an Excel workbook (.xlsx; its first sheet
  that is shown and has anything in it) or a CSV file. The row the headings are in is found under
  whatever the old system puts above them (and can be changed); each of our columns is matched to
  one of the file's, guessed from the headings (ours, or ones other systems use: "Customer Name",
  "UOM", "Godown", "Closing Qty", "Dr") and **remembered per kind** for the next file; rows such as
  a total at the bottom are left out by their row number. **Check the file** runs the import in
  its transaction, every check made, and rolls it back: every row that is wrong is listed with
  what is wrong, by its row in the file, and the first rows are shown read as ours. **Import** then
  brings in every row or none. Changing anything after a check asks for a new one.
- **One way in for each kind.** The file, as matched, is written out in our own layout (each row in
  its place, so row numbers stay the file's) and handed to the command that imports that kind from
  its own screen: `importParties`, `importItems`, `importOpeningStock`, `importOpeningLines`. Each
  now takes `ImportOptions` (`src/lib/import-options.ts`): `preview` (roll back at the end) and
  `record` (write the record in the same transaction). Opening figures reach the books only through
  the opening entry and the stock posting, as before.
- **Opening stock from one file for every warehouse**: a Warehouse column (by the warehouse's
  name) makes a draft for each warehouse, all in one transaction. Without it, the warehouse chosen
  on the screen, as before.
- **The record** (`data_imports`): kind, file name, SHA-256 of the file's bytes, rows, and the
  mapping by heading. Never the file's contents. Written by the owner or an accountant as
  themselves; read by them and the auditor; never changed or removed.
- **Check what came in** (`/settings/import/check`): what is still to do (an opening entry not
  started or not posted, opening stock drafts not posted); whether stock (Stock valuation), what
  customers owe (the open invoices the ageing works from) and what is owed to suppliers (Aged
  payables) each agree with their account in the books, with the difference and a link to the
  report; and the trial balance, as at today.

## How the same rows never go in twice

By what each row is, not by the file: a second file with the same rows is refused row by row, and
so is a different file with a row already in.

- Customers and suppliers: a name or code already used (archived ones too) is refused; the
  database's unique indexes hold it if two imports race.
- Items: a code already used is refused, with the same unique index behind it.
- What customers owe and what is owed to suppliers: the same invoice or bill number for the same
  customer or supplier already on the opening entry is refused (unique index too).
- Trial balance: an account that already has a line on the opening entry is refused.
- Opening stock (new): an item that already has opening stock in a warehouse, in a draft or
  posted, is refused there. This also holds on the Stock screen's own import, which used to make a
  second draft from the same file.
- And the very same file (same bytes, same kind) is recognised by its SHA-256: the check says when
  it was imported before.

Since every import is all or nothing, a file with some rows already in is refused whole: leave
those rows out, or import a file of only the new ones.

## Decided for Fazal, to confirm

1. **Old invoices and bills are not imported as documents.** A company comes in by its opening
   balances, as the plan says. The opening entry already carries **each unpaid invoice of each
   customer** (number, date, due date, what is unpaid) and each unpaid bill of each supplier.
   The ageing, recovery, receipts and credit notes work on each unpaid invoice from day one, by
   its own date. Each unpaid bill is aged by its date in Aged payables; a payment to the supplier
   cannot yet be set against one of these bills, so it stands as paid ahead and nets against what
   is owed to that supplier in all (see Later). Bringing whole old invoices in (lines, tax, stock) would mean posting
   documents dated before the opening day, with the old system's numbers, which the numbering and
   period rules forbid, and stock and tax for periods already closed elsewhere. Not recommended.
2. **No Fast Accounts or Tally layout is assumed.** We have no export of either. The generic
   mapper takes any layout; a ready-made mapping per old system is added once real exports are to
   hand (see "What we need from Fazal").
3. **The trial balance is read by this company's account codes** (or, with no code column, by
   the account's exact name), as the opening balances screen already does: the old system's codes
   are not translated, because the same code can mean another account here. Accounts the old
   chart has and this one does not are added under Settings, Accounts first. Matching each old
   account to one of ours on the screen is left for when a real export shows what is needed.
4. **Units and categories are not made by the import.** An item naming one the company does not
   have is a problem on its row ("never guess", as the item import already does).
5. **Opening stock: an item already in a warehouse's opening stock is refused there** (above),
   rather than added a second time.
6. **The headings row** is taken to be the first of the first fifty rows with at least three
   quarters as many cells filled as the fullest of them; the screen shows it and it can be changed.
7. **A file is at most 2 MB and 2,000 rows** (the existing imports' limit); a larger list goes in
   several files.
8. **Who imports: the owner and an accountant** (the people who open the books), and each kind
   only by whoever may manage it on its own screen, with its module switched on. The auditor sees
   the record of imports in the database but has no screen for it.
9. **The check is as at today.** Right after bringing a company in, that is the opening position.

## What we need from Fazal

To add a ready-made mapping for Fast Accounts (the pilot) and Tally, the files exactly as each
program exports them, on one cut-off day. Only their headings and layout go into the code; the
rows stay on Fazal's computer and never enter Git.

- From Fast Accounts: the customer list, the supplier list, the item list (with units, categories
  and sale prices), the stock on hand by godown with average cost, the customers' outstanding
  invoices (bill-wise, not just a total per customer), the suppliers' outstanding bills
  (bill-wise), the chart of accounts, and the trial balance.
- From Tally: the List of Ledgers under Sundry Debtors and under Sundry Creditors, the Stock
  Summary by godown, Bills Receivable and Bills Payable (bill-wise), and the Trial Balance with
  ledger codes if any.
- For each: Excel if the program can save it, otherwise CSV.

## Reading numbers out of PDFs (not built)

Fazal chose "attach now, read numbers out of PDFs later". Attaching is the Builder's. Reading
needs, for a PDF made by a program (it has text in it), a library that reads the text of a PDF
(such as `pdfjs-dist` or `pdf-parse`): a new dependency, which needs his approval. For a scanned
PDF or a photo, a service that reads printed text (Google Document AI, AWS Textract or Azure
Document Intelligence): a paid outside service to which the documents are sent, so his decision on
cost and on where the company's documents may go.

## Tests

- `src/modules/data-import/rules.test.ts`: the headings found under an old system's title rows; a
  blank heading named by its column's letter; the guess (remembered first, then ours, then other
  systems', never one heading twice); a column read twice or a needed one left out refused in
  words; rows to leave out; the file in our layout keeping every row's number, read back by the
  importers' reader; the templates having the importers' very headings.
- `src/modules/data-import/data-import.test.ts`, against the database: a customer list from an
  Excel file with a title, a date and a total; a column matched wrongly named by the file's rows;
  the preview keeping nothing; the import, its record (mapping by heading) and its audit row; the
  same file again known and every row refused; the mapping offered back for the next file; items,
  then opening stock for two warehouses from one file as two drafts, and refused the second time;
  an unknown warehouse; a trial balance onto the opening entry, a wrong row named by its row; who
  may import, a column chosen twice, a needed one missing.
- `e2e/data-import.spec.ts`, in the browser: the owner brings a company in from an old system's
  files (customers matched by hand with a total left out, the same file refused, items, opening
  stock by godown posted, unpaid invoices, the trial balance), posts the opening balances, and the
  check says everything agrees; an accountant has the screen; the auditor and a salesperson do not.

## Later

- A ready-made mapping for Fast Accounts and for Tally, from their real exports.
- Matching the old system's accounts to ours on the screen, for the trial balance.
- Offering to add the units and categories an item file names that the company does not have.
- Setting a supplier payment against one unpaid bill brought in with the opening balances, as a
  receipt already can be against an unpaid invoice.
- The PLAN's acceptance, "the pilot company's Fast Accounts export imports with a matching trial
  balance", waits for that export.

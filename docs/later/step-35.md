# Step 35: bank statements, matching and reconciliation

Track C, built by the Finisher while the founder was away (2026-11-18). Migration
`0033_bank_reconciliation` (four tables and the functions that import, match, unmatch and remove),
built on Step 34 and renumbered at merge. Nothing here posts to the books.

## What is built

- **Reconcile** (`/cash-bank/reconcile`, a tab of Cash and bank, and under Reports): each bank
  account, with the day its statements reach.
- **Importing a statement**: the CSV file the bank's internet banking gives. The heading row is
  found under whatever the bank puts above it; each line needs a day and money in or out (a Debit
  and a Credit column, or one Amount column); a line without money that says it is the opening or
  closing balance gives that balance; a file listed newest first is read oldest first. Days are
  read day first, as Pakistani banks write them (05/11/2026, 05-Nov-2026, 5 November 2026, an
  Excel day number); amounts with their grouping, brackets, a minus, Cr or Dr. When the file
  gives a running balance, every line must follow from the one before, so a file read with its
  money-in and money-out columns the wrong way round is refused, not imported. Nothing is imported
  when anything is wrong; every wrong row is listed. A line imported before, from this file or an
  overlapping one, is not imported again; a file with nothing new is refused.
- **HBL, Meezan and UBL** files are read by the names their exports give their columns; "Read the
  columns by their names" knows all of them; **"Name the columns yourself"** is the generic mapper,
  for any other bank.
- **Matching**: on import, and on "Match what is sure", the app matches what it is sure of: first a
  statement line that names an entry (its cheque number, or its document number in the description,
  as a customer paying by IBFT often writes the invoice's), same amount, within 45 days; then a line
  alone in its amount within a few days of an entry alone in its amount (from three days before the
  entry to ten after: a cheque takes days to clear). Anything else is **matched by hand**: tick
  statement lines and entries in the books whose totals are equal, one to one or several to one (a
  deposit of many cheques, or an entry and its reversal with nothing on the statement).
- **Unmatch** takes a match back; **Remove** takes back an import while none of its lines is
  matched.
- **The reconciliation** on the last statement's last day, or any day asked: balance per bank,
  balance per books, less the entries the bank has not shown yet, plus the lines on the statement
  not in the books yet, the books reconciled, and the difference, which is nil when everything is
  explained.

The acceptance, tested against the database (`reconciliation.test.ts`) with the made-up sample
statement `docs/examples/step-35-statement.csv`: **9 of its 10 lines (90%) match automatically**,
and with the bank charges put in the books and matched, **the books reconciled equal the bank**.
The figures are worked in `docs/examples/step-35.md`. **Checked by Claude, not an accountant.**

## Decided for Fazal, to confirm

1. **Excel files are not read yet.** The library to read them (`exceljs`, which you approved) could
   not be added from this chat: the approval was given in the coordinator's chat, and adding a
   library needs it in the chat that adds it. Until then, an Excel statement is saved as "CSV
   UTF-8" and imported. Once approved here, reading .xlsx is a small addition (the same reading
   rules, fed from the sheet).
2. **The banks' layouts are read by their column names as known on 2026-11-18**, not from a real
   file of each bank. HBL: Transaction Date, Transaction Details, Cheque No., Debit, Credit,
   Balance; Meezan: Date, Description, Cheque No, Debit, Credit, Balance; UBL: Txn Date,
   Particulars, Instrument No, Withdrawal, Deposit, Balance. A real file of each should be tried;
   any other is read with "Name the columns yourself".
3. **Days are read day first** (05/11/2026 is 5 November), as Pakistani banks write them.
4. **Who reconciles: the owner or an accountant who works across the whole company**; the auditor
   reads it; an accountant limited to some branches does not (reconciling reads every entry in the
   account).
5. **A statement line matches entries on the same bank account only, whose totals are equal**,
   exactly; there is no tolerance for a few rupees' difference.
6. **Automatic matching is only what is sure**: a line or an entry with a twin of the same amount
   in the same days is left for a person, rather than guessed.
7. **A bank charge on the statement is put in the books as an expense** (Step 34, Bank charges)
   and then matched; the screen does not post it by itself.
8. **The reconciliation starts with the first statement imported**: entries in the books before
   it are brought forward; when that statement says what the account held before it and the books
   say otherwise, the screen shows by how much they already differed.

## Tests

- `src/modules/bank-reconciliation/rules.test.ts`: days and amounts as banks write them; an HBL
  file with the bank's own lines above its heading; newest-first files and one Amount column;
  columns named by the company; a file with its columns swapped, and lines that cannot be read;
  matching by name, then by amount and days, never across amounts or too early; the
  reconciliation adding up, and a match that crosses the day.
- `src/modules/bank-reconciliation/reconciliation.test.ts`, against the database: **the
  acceptance**; importing the same file again, and an overlapping one; a file it cannot read;
  unmatching, totals that do not agree, removing an import; who keeps, reads and cannot see it,
  and that the app's role writes nothing but through the database's functions.
- `e2e/bank-reconciliation.spec.ts`, in the browser: the owner banks cash and draws some back,
  imports the statement (two of three lines matched, reconciled), unmatches and matches again; the
  auditor reads it and changes nothing.

## Later

- Reading .xlsx statements, once `exceljs` is approved in this chat (decision 1).
- Recording a bank charge straight from its statement line.
- A printed or PDF reconciliation statement for the auditor.
- Matching suggestions for what is not sure (a ranked list of candidates), and a tolerance.

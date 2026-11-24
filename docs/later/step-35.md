# Step 35: bank statements, matching and reconciliation

Track C, built by the Finisher while the founder was away (2026-11-18). Migration
`0041_bank_reconciliation` (four tables and the functions that import, match, unmatch and remove),
built on Step 34, renumbered at merge; the coordinator applies it to the shared database once
merged. Nothing here posts to the books.

## What is built

- **Reconcile** (`/cash-bank/reconcile`, a tab of Cash and bank, and under Reports): each bank
  account, with the day its statements reach.
- **Importing a statement**: the CSV or Excel (.xlsx) file the bank's internet banking gives. The
  heading row is found under whatever the bank puts above it; each line needs a day and money in
  or out (a Debit and a Credit column, or one Amount column); a line without money that says it
  is the opening or closing balance gives that balance; a file listed newest first is read oldest
  first. Days are
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
- **The reconciliation** on the last statement's last day, or any day asked: balance per bank
  (the running balance the bank itself gives on its last line to the day), balance per books, less
  the entries the bank has not shown yet, plus the lines on the statement not in the books yet, the
  books reconciled, and the difference, which is nil when everything is explained. When the bank's
  balance is not what the lines imported add up to, the screen says a statement is missing.

The acceptance, tested against the database (`reconciliation.test.ts`) with the made-up sample
statement `docs/examples/step-35-statement.csv`: **9 of its 10 lines (90%) match automatically**,
and with the bank charges put in the books and matched, **the books reconciled equal the bank**.
The figures are worked in `docs/examples/step-35.md`. **Checked by Claude, not an accountant.**

## Decided for Fazal, to confirm

1. **Excel files are read as .xlsx**, with `exceljs` 4.4.0 (approved by Fazal in the Finisher's
   chat, 2026-11-18; added 2026-11-22). The first sheet that is shown and has anything in it is
   read by the same rules as a CSV file: a day Excel keeps as a day is that day, a number is read
   as Excel shows it (to 15 figures), a formula by its result, and merged cells once. An older
   .xls file, or a workbook with a password, is refused with a note to save it as .xlsx: reading
   those would need another library. A workbook comes from outside, so before the library opens
   it, its parts are unpacked once here with a ceiling of 40 MB (a 5,000-line statement is under
   5 MB), and a ZIP laid out in any unusual way is refused (`statement-file.ts`).
   exceljs brings 94 packages (none already installed changed). `npm audit` then lists two more
   moderate advisories, both one: `uuid` below 11.1.1 does not check a buffer's bounds in its
   v3, v5 and v6 when given one (GHSA-w5hq-g745-h8pq), and exceljs depends on it. exceljs calls
   only `v4`, so they are left (the coordinator agreed, 2026-11-23); `npm audit fix --force`
   would put back exceljs 3.4.0. Six of the packages are marked deprecated by their authors
   (fstream, glob 7, inflight, lodash.isequal, rimraf 2, uuid 8), all from exceljs's own
   dependencies.
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
   it are taken to be in the bank's opening balance, except a cheque written before it and
   presented after it, which is matched like any other entry and counts as on its way.
9. **A statement imported before another that shares days with it is removed only after the later
   one** (SE368): the later one keeps no copy of the shared days.

## Review

An independent review (2026-11-18) found the access rules, the functions and the races right, and
these, all fixed:

- **The difference could never show what was wrong.** The bank's balance was worked out from its
  own imported lines, so a missing statement or a lost line still read "Reconciled", and a cheque
  written before the first statement and presented after it showed a difference for ever. The
  bank's balance is now the running balance the bank gives; such a cheque is matched and counts as
  on its way at the start; and the screen says when a statement is missing.
- Removing an older statement that a later one overlaps took the shared days out of the account;
  it is refused until the later one goes (SE368).
- Total, opening and closing rows are known by their description before their money is read (a
  total row with both columns, or an opening balance in the Credit column, no longer stops or
  pollutes an import).
- An account number read as an amount, a stray character, or a blank file name now refuses the
  file in words (SE361) instead of failing.
- A same-day file listed newest first is read the right way round.
- Automatic matching passes over a pair someone matched meanwhile instead of undoing the import;
  it compares lines of the same amount only; and only entries from sixty days before the first
  statement are offered (a long history no longer crowds out this month's).
- Matching and unmatching take their lines in one order (no deadlock between them), check the
  role before taking any lock, and their audit rows name the lines.

## Tests

- `src/modules/bank-reconciliation/statement-file.test.ts`: the sample statement as an Excel
  workbook (days as days, money as numbers) reads line for line, fingerprints and all, as its CSV
  file; a binary fraction, a formula, rich text, an Excel day number and merged cells; the first
  sheet shown; an .xls file, a file that is not a workbook, too many rows, a ZIP that unpacks past
  the ceiling (also when its directory understates it, and in many small parts), and a ZIP with
  bytes before or after it or cut short, all refused; CSV bytes with and without Excel's mark.
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
  imports the statement as an Excel workbook (two of three lines matched, reconciled), unmatches
  and matches again; the auditor reads it and changes nothing.

## Later

- Reading older .xls statements (decision 1), if a bank gives nothing else.
- Recording a bank charge straight from its statement line.
- A printed or PDF reconciliation statement for the auditor.
- Matching suggestions for what is not sure (a ranked list of candidates), and a tolerance.
- Every match, not only the latest fifty, to unmatch from the screen.

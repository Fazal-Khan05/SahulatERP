# Daily expenses (after Step 50; not a numbered step of the plan)

The founder signed in as the demo owner on 2026-11-26, found expenses only as the accountant's
form under Cash and bank, and asked: "i need you to make a section for daily expenses".

## Decided by the founder (2026-11-26, asked by the coordinator)

- Daily expenses has its own entry in the main menu, with a quick form (date, what for, amount,
  paid from, note) and each day's total.
- The owner and an accountant enter them; the auditor reads. No approval.
- A PDF or a photo of the receipt can be kept with an expense and opened later. Reading the
  numbers out of a PDF is **not** in this piece (see Later).
- A sheet of expenses can be uploaded as an Excel file and entered in one go after a preview.

## What a daily expense is

An ordinary expense of Step 34, of one line. The quick form and the sheet both end in
`recordExpenseIn` (`src/modules/cash-bank/commands.ts`), which asks the database's own
`app.record_expense`: the same journal (debit the expense account, credit the cash or bank
account), the same EX- number from `number_series`, the same audit rows, the same rules about
dates, locked periods, branches and roles. There is no second way of writing an expense. Cash
and bank, Expenses lists the same expenses, and the full form there is unchanged.

- **What for** is one of the company's expense accounts in use, chosen by name. The line's
  description is the note, or the account's name when there is no note.
- **Paid from** is a cash or bank account in use; the form begins with the one this person paid
  from last.
- **Paid to** is optional, in words.
- Nothing is withheld, and the form says so and says where to go when tax must be withheld.

## On screen

- **Daily expenses** (`/daily-expenses`), in the menu of the owner, the accountant and the
  auditor, above Cash and bank. For the owner and an accountant: the card "Add an expense"
  (Date, What for, Amount (Rs), Paid from, Note (optional), Paid to (optional), Branch when the
  company has more than one or the person is limited to some, Receipt (optional); button "Add
  expense"). After each one the amount, note, payee and receipt are cleared, and the day and the
  account stay, for the next. Then "Today" with what was spent today and its expenses, and
  "Earlier days", each day with its own total, with From / To and "Show" (thirty days unless
  asked; a year at most; five hundred rows at most, and it says so when there are more).
  A cancelled expense is listed, struck through, and not counted.
- **Upload a sheet of expenses** (`/daily-expenses/import`): "Download the template" (an Excel
  file with the headings Date, What for, Amount, Paid from, Paid to, Note, and a second sheet
  with the names this company may write), the names listed on the page as well, then "Read the
  sheet", which shows every row and everything wrong with each, in words. Only when no row is
  wrong is there a button "Enter these N expenses": all are entered in one transaction, or none.
  Excel (.xlsx) or CSV, two hundred rows at most.
- **Receipts** on an expense's page (`/cash-bank/expenses/<id>`, reached from either list): the
  files kept with it, each a link good for one minute, and "Add a receipt" / "Keep with this
  expense" for the owner and an accountant. A PDF, PNG, JPEG or WebP of 4 MB or less, checked by
  its contents; a large photo from a phone is made smaller in the browser before it is sent.

## In the database (`drizzle/0046_daily_expenses.sql`, track C, error codes SE376 to SE378)

1. `expense_receipts`: which stored file is the receipt of which expense. Written only by
   `app.attach_expense_receipt` (owner or accountant; the file is their own, stored, and not yet
   a receipt; the expense is one they may see; ten at most), with its audit row
   `expense_receipt.attach`, which only that function can write. Never changed or removed.
   Read by whoever may read the expense.
2. An accountant keeps receipts. The files table and the object store took files from the owner
   only and showed them to the owner and the auditor (`0002`, which says a later step widens
   this). Those policies are untouched; beside them, for the accountant only: store a file of
   their own, mark it stored, and read a file that is their own or is a receipt of an expense
   they may see (`files_insert_receipt`, `files_select_receipt`, `files_update_receipt`;
   `files_bucket_insert_receipt`, `files_bucket_select_receipt` on `storage.objects`, asking
   `app.storage_receipt_writer` and `app.storage_receipt_reader`).
   A receipt follows its expense, and an expense may belong to a branch, while 0002 shows the
   owner and the auditor every file. So two restrictive policies of this migration's own
   (`files_select_receipt_branch`, `files_bucket_select_receipt_branch`) hide the file of a
   receipt from a member limited to branches unless its expense is in one of theirs; they hide
   nothing else from anyone. And the file of a receipt stays stored (`files_receipt_kept`,
   SE378): no one marks it pending again, which would have made the receipt vanish from its
   expense.
3. An expense may name nobody. `app.record_expense` is written out again (the same track) with
   one rule changed: a supplier, a payee in words, **or neither**; never both. With nobody named
   the journal's memo and the money's line say what the first line was for, where they said
   "Paid to ...". The constraint `expenses_paid_to_someone` becomes
   `expenses_paid_to_one_at_most`. Everything else in the function is 0038's text, copied by a
   script and compared line by line (the pull request shows the difference).

No row of any company changes.

## Decided for Fazal, to confirm

1. **Who was paid is optional on a daily expense, and this is a rule change, not a made-up
   name.** Step 34 refused an expense that named nobody. Tea, a rickshaw, photocopies have no
   one worth naming, and typing "cash" forty times teaches people to type rubbish. The
   alternative was to keep the rule and fill in a stand-in name such as "Not named"; that would
   put a made-up payee in the books. The full form under Cash and bank still asks for a
   supplier or a name, as before.
2. **"What for" offers expense accounts only**, not asset accounts. The full form also lets an
   expense be charged to an asset account (a deposit, a fixed asset); that is an accountant's
   entry and stays there.
3. **Nothing is withheld on a daily expense or a sheet, and "Paid to" is always words.** Tax is
   withheld only from a supplier on the list by a company that withholds, on the full form,
   where the lines of the tax tables are chosen. No rate is typed anywhere here. A sheet's
   "Paid to" is never matched to a supplier on the list.
4. **The note is the expense line's description** (200 characters at most). Without a note the
   description is the account's name. The expense's own memo is left empty, so nothing is said
   twice.
5. **A day's total is what was spent**: the total of each posted expense of the day (what was
   charged, tax withheld included, which is nil for a daily expense). Cancelled expenses are
   shown and not counted.
6. **A receipt is never removed**, as a posted document never is; a wrong one stays beside the
   right one. Ten at most for an expense. A receipt may be added to a cancelled expense.
7. **Receipts also appear under Settings, Files** for the owner and the auditor, who see every
   file of the company there. An accountant still has no Files page; they see receipts on the
   expense.
8. **A sheet is entered whole or not at all, two hundred rows at most**, and is for one branch
   (or the whole company) chosen on the upload page, not row by row. Dates are read day first
   (26/11/2026), as in Pakistan, or as Excel keeps a date. An account is matched by its name
   exactly (capitals and spaces aside), or its code; a name two accounts share is refused and
   the code asked for.
9. **Sent twice, entered once**: the quick form carries a key for each expense, and a sheet a
   key for the whole sheet, so a double press or a retry enters nothing twice. Two expenses
   alike in every figure, entered one after the other, are two expenses.
10. **The menu entry sits above Cash and bank** for the owner and the auditor, and above Bank
    and cash for the accountant; it shows while the Cash and bank module is on. The menu is a
    shared list (docs/PARALLEL.md), changed here because the coordinator asked for the entry.
11. **Entered through the browser from a phone, a large photo is redrawn to 2,000 points on its
    longer side as a JPEG** before it is sent, since a file may be 4 MB at most. A PDF and a
    small photo are sent as they are.

## Questions for a tax adviser

- **Cash expenses and section 21(l).** An expense paid in cash above the limits of section 21(l)
  of the Income Tax Ordinance (a single payment, or a year's payments under one head) may not be
  deductible unless paid through a bank. The quick form does not warn or stop. Should it warn
  when a cash account is chosen above an amount, and what are the amounts today?
- **Withholding on payments to someone not on the supplier list.** A company that withholds
  (section 153) may be required to withhold from a payee it names in words here. Today nothing
  is withheld unless the payee is a supplier on the list and the full form is used. Is a
  warning above a threshold wanted on the quick form for a company that withholds?

## Later

- **Reading the numbers out of a receipt** (the amount, the date, the seller from a PDF or a
  photo). Not built: it needs a decision on a dependency or an outside service, which is the
  founder's. The receipt is kept, so this can be added without entering anything again.
- **Changing or removing a receipt.** Not built (decision 6). If wanted: a "withdrawn" mark with
  an audit row, never a delete.
- **A report of expenses by account over a period.** The ledger and the profit and loss account
  already show it; a report with the daily list's columns and a download was not asked for.
- **A sheet with a branch for each row, or with a supplier from the list.** Not built
  (decisions 3 and 8).
- **Receipts on other documents** (supplier bills, payments). The table and the storage rules
  here are for expenses only; another document wants a table of its own and the same pattern.
- **Recurring expenses** (rent on the first of each month). Not asked for.
- **Bytes left in the object store.** If the second step of keeping a receipt fails after the
  bytes were sent (a race for the tenth receipt, a role changed in between), the file row stays
  pending and the bytes stay in the store. Nothing claims a receipt, which is the design
  (intent before, outcome after); nothing sweeps such bytes away either, here or for any other
  file. A sweep of pending rows older than a day belongs to the worker.
- **Who added a receipt, as an accountant sees it.** An accountant reads only their own
  membership row, so a receipt added by someone else shows no name to them. The owner and the
  auditor see every name.
- **Other files limited by branch.** Only receipts are hidden by branch. Settings, Files still
  shows an auditor limited to branches every other file of the company, as 0002 decided.
- **A flaky test that is not this piece's**: `src/modules/supplier-payments/payments.test.ts`
  picks a posted payment with `limit 1` (noted in market-purchase.md too).

## Review

An independent reviewer who had not seen the work compared the rewritten `app.record_expense`
with 0038's text, attacked the new access rules with SQL of their own as the app's role (every
role, a member limited to a branch, a user who is an accountant in two companies, the object
store's role), ran the down file, and ran the whole check on a database of their own.

Found sound: only the intended lines of the function differ; with nobody named the journal
balances and no description is ever empty; the same key answers the same number; tax is still
withheld only from a supplier; no other reader of an expense's payee exists; no role or company
reaches what it should not through the receipts table, its function or the accountant's
policies; the app's role cannot write a receipt or its audit row; every new function has the
safe search path and is taken from PUBLIC.

Found, and put right before the migration was sent:

1. **(medium) An auditor limited to branches could open the receipts of every branch** through
   Settings, Files and the object store, because 0002 goes by role only. The notes had wrongly
   said such an auditor does not exist. Two restrictive policies now hide a receipt's file from
   a member limited to branches unless its expense is in one of theirs.
2. **(medium, the down file)** The old constraint put back as NOT VALID would have refused
   cancelling an expense that names nobody. The down file now refuses to run when such
   expenses exist, and otherwise restores 0038 exactly.
3. **(low to medium) A receipt could be made to vanish** by marking its file pending again
   (SQL as the app's role; no screen does it). A trigger now keeps a receipt's file stored.
4. **(low) The same key sent again with another account or note answered "Recorded"** and
   changed nothing. The app now compares what was recorded and refuses; the quick form makes a
   new key whenever what is typed has changed; and a retry does not keep the same receipt twice.
5. **(low) The sheet's preview showed what was typed, not what was read**, so 11/5/2026 read as
   the eleventh of May went unnoticed. The preview now shows the day and the amount as read.
6. Smaller: a day cut short by the 500-row limit is left out, not shown with a partial total; a
   CSV not saved as UTF-8 is refused, as the bank statement import refuses it; two columns
   under one heading are refused; an error from a sheet is not shown under the next sheet.

Left, and why: the two points under Later (bytes left in the store; who added a receipt as an
accountant sees it); a crafted request with a note of two spaces or a name of one letter is
refused with words meant for the full form (nothing is recorded); and the key of an expense of
another company, which cannot be guessed, fails as a plain failure (0038's primary key).

Not checked by the reviewer: the browser, and the real object store (its rules were tried on
the local stand-in table).

## Tests

- `src/modules/daily-expenses/rules.test.ts`: the quick form's reading, the days the list
  covers, day totals, matching accounts, reading and checking a sheet.
- `src/modules/daily-expenses/daily-expenses.test.ts` (against a database): an expense that
  names nobody and its journal; the full form still asking; the database refusing a supplier
  and a name together; sent twice; refusals; roles and another company; a branch's accountant;
  receipts (kept, opened, by whom; what an accountant can read of the files table; what the
  object store's two functions answer; nothing written past the function; ten at most; the
  store down); a sheet read from Excel and CSV, previewed, refused whole on one bad row in the
  sheet or at the database with no number taken, entered in order, and entered once when sent
  twice.
- `e2e/daily-expenses.spec.ts`: the owner's quick entries and totals; the sheet, wrong then
  right; an accountant's receipt kept and opened through the object store; the auditor; a
  salesperson.

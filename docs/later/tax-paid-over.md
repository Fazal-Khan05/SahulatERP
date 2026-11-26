# Tax paid over: a challan for expenses' and salaries' tax (after the withholding register; not a numbered step of the plan)

Putting the withholding register right (docs/later/withholding-register.md) showed a gap: a
challan (Step 26) could pay only the tax withheld on supplier bills. Tax withheld on an expense
(Step 34) and the income tax a payroll run deducts from pay (Step 41, section 149) are credited
to the same accounts, and nothing could record that they were paid to the government. They
stayed "still to be paid" for good and the account in the books only grew. The founder's
session said yes to a small step of its own with a migration.

## What it does

- **One list, one challan.** Purchases, Withholding tax now lists everything withheld and not
  yet paid over: on supplier bills, on expenses, and from salaries (one line for each approved
  payroll run with tax). Tick what one challan paid, of one kind of tax, and record it as
  before: Which tax, Paid on, Challan (CPR) number, Paid from. Salary tax is ticked with Income
  tax.
- **It is the same challan.** A WC- number from `number_series`, one journal (debit the
  withholding payable account of its kind, credit the cash or bank account), the same audit
  rows, the owner or an accountant who works in every branch. Its amount is the sum of what was
  ticked: nothing is typed.
- **The register and section 165 follow.** Each line a challan paid names its CPR number and
  day; what is still to be paid, as at any day, leaves out what a challan had paid by that day,
  and still equals the accounts in the books of that day.
- **An expense whose withheld tax has been paid over stands.** It is no longer cancelled: the
  tax is with the government in the supplier's name, and a reversal would take it back out of
  the books as if it had never been paid. The screen says so.

## In the database (the migration "tax paid over", track C, error codes SE379 and SE380)

Beside what Step 26 made, changing none of it (`app.record_withholding_challan` is track B's
and is left exactly as it is; it still records a challan that pays bills' entries only, and the
app still uses it for one):

1. `challan_expense_entries` and `challan_payroll_runs`: which expense's tax and which payroll
   run's tax a challan paid, each once and whole, the run with the amount it was. Read by the
   owner, an accountant and the auditor; written only by the function below; never changed or
   removed.
2. `app.record_tax_challan`: records a challan that pays any mix of the three. For bills'
   entries it asks exactly what Step 26's function asks. It holds the rows it pays, and the
   expenses whose tax it pays, so that two challans cannot pay one amount and an expense cannot
   be cancelled while its tax is being paid.
3. `expenses_tax_paid_over`, a trigger on this track's own `expenses` table (SE380).

No row of any company changes.

**The migration's number.** In this working copy it is 0047, the next free number: the
Finisher's 0047 was not on main or on any branch when it was built. The coordinator means it to
be 0048. When the Finisher's is on main, it is renumbered with `npm run db:set-aside` and
`npm run db:put-back` (docs/PARALLEL.md), which changes its file name and its date in the
journal and not one line of its SQL.

## Decided for Fazal, to confirm

1. **A payroll run's tax is paid over whole, by one challan.** A month's salary tax is one
   deposit. Paying part of a run's tax is not offered.
2. **Salary tax and suppliers' income tax may be paid by one challan or by two.** Both are
   income tax in one account; whether the government's payment slip takes them together is the
   payer's business. The list shows each line's source so they can be ticked apart.
3. **An expense stands once its withheld tax is paid over** (see above). A mistake is put
   right with the supplier and a new entry.
4. **One challan for a run, whatever its people.** The run's own payslips already say whose
   tax it was; the year's statement (Payroll, Year's statement) reports it person by person.

## Questions for a tax adviser

- Is income tax deducted from salaries (section 149) deposited on its own payment slip, apart
  from tax withheld from suppliers (section 153)? If always apart, the screen could refuse to
  mix them in one challan; today it allows either.
- The two questions in docs/later/withholding-register.md stand.

## Why there is no rule for a payroll run like the one for an expense

An expense can be cancelled after it is posted, so one whose tax was paid over needed a rule of
its own. A payroll run cannot: a challan takes only an approved or paid run, and Step 41 lets
none go back, in the database itself (`drizzle/0040_payroll_runs.sql`):

- `app.cancel_payroll_run` refuses any run that is not a draft or reviewed (SE354);
- the row guard `payroll_runs_check` lets the app's role change a run only by working a draft
  or reviewed one out again (SE351), and never remove one;
- no function reverses a run's journal, and none can post such a reversal: the shared rule
  that every journal stands with its document asks `app.reversal_backed_<kind>`, and there is
  none for a payroll run.

A test holds the three. **If a later step lets an approved run be cancelled or reversed, it
must first refuse a run that is in `challan_payroll_runs`**, as `expenses_tax_paid_over` does
for an expense; that step's own cancel function is the place for it.

## Later

- **The year's salary statement does not show the CPR numbers** of the challans that paid each
  month's tax. They are in the withholding register.
- **Tax withheld on an expense that is then found to be wrong** after it was paid over has no
  correcting document here: it is settled with the supplier and the tax office.

## Review

An independent reviewer who had not seen the work recorded challans of its own on a scratch
database, two at once and against a cancelling and an approval, ran the register for every day
of a month after each step, and attacked the tables and the function in every role.

Found sound: the journal always equals exactly the rows a challan marks; nothing could be paid
twice (duplicates, two challans at once, Step 26's function racing the new one either way
round); a cancelling and a challan cannot pass each other; no deadlock in the order rows are
held; "still to be paid" equalled the books on every day tried, with challans recorded out of
date order, expenses cancelled later and runs approved out of order; the functions' rights; no
role or company that should not record or read does; the stand-in id used when no bill entry
is ticked cannot reach the database; the migration changes nothing of another track's.

Found, and put right before the migration was sent:

1. **(low to medium) Someone limited to a branch could read each payroll run's salary tax**
   from `challan_payroll_runs`, and other branches' rows of `challan_expense_entries`, though
   payroll and those expenses are hidden from them. The two read policies now go no further
   than the rows they are about.
2. **(low) A run's tax not to the paisa** (which the app never writes) would have been stored
   rounded. Such a run is now refused.
3. **(low) The down file** now holds the two tables before asking whether they are empty.
4. **(low) Wording for a member limited to a branch**, who is shown their branches' bills only,
   and **words for a wait** when another challan holds an amount.
5. **(a product point) The expense's page still offered Cancel** and refused on submit. It now
   says the expense stands, and why, in place of the form.

Known and left: every challan's amount is read by the owner, an accountant and the auditor
whatever their branches (Step 26's policy, track B's), so a challan that pays salary tax alone
shows that figure to an accountant limited to a branch. The register prints a challan's number
on a line even when the challan is dated after the report's last day, as it always did for
bills; what is still to be paid is right for the day regardless. The comment in
`drizzle/0032_supplier_payments.sql` that challans are written only by
`app.record_withholding_challan` is no longer the whole truth: `app.record_tax_challan`
writes them too.

Not checked by the reviewer: the browser, and the hosted database.

## Tests

- `src/modules/tax-paid-over/tax-paid-over.test.ts` (against a database): what is offered; one
  challan paying a bill's entry, an expense's entry and a run's tax, with its journal, its rows
  and its audit row; the register and the books before and after, as at the day before, and
  section 165; each amount paid once; nothing written past the function; roles, a branch's
  accountant and another company; an expense that stands once paid and one cancelled before;
  the province's tax; a challan for bills only still Step 26's; everything paid and the
  accounts at nil.
- `src/modules/purchase-reports` tests: the register with challans on salaries' lines.
- `e2e/tax-paid-over.spec.ts`: an expense with tax withheld, paid over from the screen.
- `scripts/demo`: the demo pays October's salary tax with WC-2627-00002, and its end check
  still requires the register to equal the books.

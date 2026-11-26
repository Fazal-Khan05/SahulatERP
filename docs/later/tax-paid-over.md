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

## Later

- **The year's salary statement does not show the CPR numbers** of the challans that paid each
  month's tax. They are in the withholding register.
- **Tax withheld on an expense that is then found to be wrong** after it was paid over has no
  correcting document here: it is settled with the supplier and the tax office.

## Review

(Filled in when the independent review is back.)

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

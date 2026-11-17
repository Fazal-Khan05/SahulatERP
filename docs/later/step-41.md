# Step 41: payroll runs, commission settled with the salary, and payslips

Track C (payroll), built by the Finisher. Migration `0033_payroll_runs` (three tables, their
guards, the run's four acts, one locked account, two kinds of number, and the commission
statement taught the run's number). Built on Step 40.

## What is built

- **Payroll runs** (`/payroll/runs`): the owner or the payroll administrator works a month out.
  The app makes one payslip for each person employed in the month, from Step 40's pay, attendance
  and statutory tables and the commission approved for them. If anyone's payslip cannot be worked
  out (no pay on record, more unpaid days than days employed, a statutory figure missing), nothing
  is written and each person is named with the reason. The run is then **reviewed** (owner or
  payroll administrator), **approved** (owner or an accountant) and **paid** (owner or an
  accountant, from a cash or bank account). Until approval it can be worked out again (it becomes
  a draft again) or **cancelled** with a reason, and the month worked out anew.
- **Approval** puts the run in the books, numbered `PR-2627-00001`, dated the month's last day or
  the approval day if that comes first:

  | | Account | Amount |
  | --- | --- | --- |
  | Dr | 5210 Salaries and wages | pay, less fixed deductions |
  | Dr | 5215 Employer EOBI and social security (new) | the employer's EOBI and social security |
  | Dr | 2320 Commission payable | the commission carried |
  | Cr | 2300 Salaries payable | what the people take home |
  | Cr | 2210 Income tax withheld payable | the tax deducted (s.149) |
  | Cr | 2310 EOBI and social security payable | employees' EOBI and the employer's share |

  **Commission is never expensed twice.** It was expensed when earned (Step 38: Dr 5220 / Cr 2320);
  approval only moves it from Commission payable to what the people are owed, and records it as
  paid on the commission ledger exactly as Step 38's commission payment does (what was owed back
  taken first, oldest first), with the run as its source. Commission statements show the run's
  number on that line.
- **The acceptance:** approval asks again what each person's commission stands at (each approved
  accrual's released and unpaid amount, and each amount owed back) and refuses the run if anything
  differs from what it was worked out with. Approval also refuses a run when a month of the tax
  year was approved after it was worked out, so the tax always counts every approved month.
- **Payment**: one journal, `SP-2627-00001`, Dr 2300 Salaries payable / Cr the cash or bank
  account, on or after the approval date.
- **Payslips** (`/payroll/payslips`, and from each run): pay, deductions, take home, what the
  employer pays on top, and how the month's income tax was worked out; a **PDF** to download.
- The menu: Payroll runs and Payslips, greyed until now, lead here; the Payroll pages have tabs for
  both; Reports lists them under Payroll for the accountant.

## How a payslip is worked out (`src/modules/payroll-runs/rules.ts`)

- **Pay**: the pay in force on the last day the person was employed in the month. A monthly
  employee is paid each part for the days employed less unpaid days, over the days in the month;
  a daily employee the daily wage for each day worked.
- **Commission**: what is approved and released, less what they owe back, as far as it goes.
- **Income tax, s.149**: the year's taxable salary is what was paid earlier in the tax year, this
  month's, and this month's regular pay for each month left (none if they leave this month); the
  year's tax on that, less the tax already deducted, is spread over the months left, this one
  included. Commission counts once, in the month it is paid.
- **EOBI**: 1% (employee) and 5% (employer) of the EOBI wage, for a registered person.
  **Social security**: 6% of the province's minimum wage, for a registered person (Step 40).
- Nothing taken from pay takes it below nil: tax first, then EOBI, then the fixed deduction.

The worked example is `docs/examples/step-41.md`, agreed by a blind second working. **Checked by
Claude, not an accountant.**

## Decided for Fazal, to confirm

1. **Two people for a run**: the owner or the payroll administrator works it out, reviews it and
   can cancel it; the owner or an accountant approves and pays it. A payroll administrator cannot
   approve their own run. A member limited to some branches does not run payroll.
2. **One run a month for the whole company**, not one per branch.
3. **The pay in force on the last day of the month** (or the last day employed) is used for the
   whole month; a raise in the middle of a month is not split by days. Joiners and leavers are paid
   for the calendar days they were employed.
4. **Months of the tax year before payroll was run here** (a company that starts mid-year, as the
   design partner will): for each month the person was employed and no run was approved here, the
   tax is worked out as if they were paid their present regular pay and taxed evenly on it. If
   their real earlier pay or tax was different (a raise, a bonus, another employer), this month's
   tax will be off by that much. The other way is to type, once, each person's taxable pay and tax
   deducted so far in the year before the first run; that is a small addition if you want it.
5. **Tax over-deducted earlier is not paid back through payroll** (it is claimed in the person's
   return); tax a month could not deduct (pay too small) is spread over the months after.
6. **EOBI is charged for the whole of any month** a registered person was employed, even part of
   it.
7. **Fixed deductions reduce Salaries and wages**: there is no account for advances to staff yet.
   Loans and advances to staff (Step 42) will post to an advances account instead.
8. **Salary tax goes to 2210 Income tax withheld payable**, the same account as tax withheld from
   suppliers. Depositing it with a challan (Step 26's challans cover suppliers' withholding) is not
   in this step.
9. **The run's salaries are paid in one payment** from one account. A bank transfer file for each
   person is Step 42.
10. **An approved run stands**: it is not cancelled or reversed in this step; a mistake is put
    right in the next month's run, or by a journal.
11. **Commission for someone with no employee record** is still paid with Step 38's commission
    payment; only commission of people on the payroll (an employee linked to their login) goes
    through the run. Commission paid through the run is taxed as salary.
12. **The payroll administrator sees, on payslips, the commission due to each person on the
    payroll**, which they need to pay it, though they read no commission otherwise.
13. **CNICs are not printed on payslips.**

## Review

An independent review of the migration and the money rules is recorded below once done.

## Tests

- `src/modules/payroll-runs/rules.test.ts`: the worked example figure for figure (three people,
  the run's totals, the journal balancing), the tax year and months left, commission net of what
  is owed back, proration, a raise spread over the months left, months before payroll was run here,
  the order deductions are taken in, and every refusal.
- `src/modules/payroll-runs/runs.test.ts`, against the database through the app's own path:
  October worked out with commission (the payroll administrator, who reads no commission, gets only
  that of people on the payroll), a draft is the app's to write and nothing after it, approval into
  the books with commission settled and its expense untouched, the statement showing the run's
  number, payment from cash, **the acceptance** (a commission approved after November was worked
  out stops its approval until it is worked out again), cancelling, and who reads and who acts.
- `e2e/payroll-runs.spec.ts`, in the browser: the payroll administrator works the month out
  (refused first, with who and why) and reviews it; the accountant approves and pays it; the owner
  opens a payslip and downloads its PDF.

## Later

- **Emailing payslips** waits for the email service (the step's "email").
- Each person's own payslips for a member who signs in; today only payroll's readers see them.
- Opening figures for each person's tax year (decision 4), if wanted.
- Depositing salary tax with a challan, and the yearly salary statement (Step 42).
- Reversing an approved run.

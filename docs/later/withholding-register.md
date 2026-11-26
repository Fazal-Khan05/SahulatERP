# The withholding register and the books (after the fuller demo; not a numbered step of the plan)

Step 29's acceptance is "Withholding register totals equal withholding payable". Seeding the
fuller demo company on 2026-11-26 showed it no longer held: the register read tax withheld on
supplier bills only, while two later steps credit the same accounts.

- **Step 34**: an expense paid to a supplier on the list may have income tax and the province's
  tax withheld (`expense_withholdings`). docs/later/step-34.md said the register reads these;
  it did not.
- **Step 41**: an approved payroll run credits the income tax deducted from pay (section 149)
  to 2210 Income tax withheld payable, the account of income tax withheld from suppliers.
  docs/later/step-41.md listed it as still to do.

## What changed

- **The withholding register** (`src/modules/purchase-reports`):
  - tax withheld on an expense is listed with the supplier's other entries, under its kind of
    tax, with the expense's number where a bill's would be. An expense cancelled by the end of
    the period has given its tax back and is not listed; as at a day before its cancelling it
    still is, as the books of that day still hold it;
  - income tax deducted from salaries has a section of its own, "Income tax deducted from
    salaries (section 149)": one line for each payroll run approved in the period, on the
    run's journal date, with the run's number, how many people were taxed, their taxable pay
    and the tax, all read from the run's own rows. Nothing is typed;
  - "Still to be paid to the government" counts both, so "Withheld and not yet paid over"
    equals "Withholding payable accounts in the books" again and the difference reads nil;
  - for one branch or one supplier, salaries are left out, as the comparison with the books
    already was: payroll and challans are the whole company's.
- **The statement for section 165** gains the income tax withheld on expenses (it is tax
  withheld from a supplier under section 153, like a bill's). Salaries are **not** in it, and
  a note on the report says where they are: Payroll, Year's statement.
- **The challan screen** (Purchases, Withholding tax) says what it covers: tax withheld on
  supplier bills.
- **Aged receivables** ends with "Trade receivables, in the books" and "Difference", on the
  screen, the download and the print, for someone who reads the books (owner, accountant,
  auditor) and works in every branch. The recovery officer and the sales manager do not read
  the books, and someone limited to a branch sees only its invoices, so for them the report
  ends at its total, as before.

No migration: every figure is read from rows that are already there.

## Decided for Fazal, to confirm

1. **Salary tax is shown in the register and kept out of the section 165 statement.** The
   register is the company's own record of everything withheld and owed to the government, so
   it must hold all of it to equal the books. The section 165 report here is the suppliers'
   statement; tax deducted from salaries is reported by the employer in its yearly statement,
   which Step 42 gives under Payroll, Year's statement.
2. **Tax withheld on an expense goes into the section 165 statement.** It was missing there
   too. It is withheld from a supplier under the same section as a bill's.
3. **The comparison on aged receivables is with Trade receivables alone.** Money a customer
   paid ahead, and credit notes not yet set against an invoice, are held in Advances from
   customers and are not taken off what the invoices still owe; the report's note says so.

## Found here, and built since (docs/later/tax-paid-over.md)

- **Paying over salary tax and tax withheld on an expense.** A challan (Step 26) covers tax
  withheld on supplier bills: its rows point at a bill's withholding entry. There is no way to
  record that the tax deducted from salaries, or withheld on an expense, was paid to the
  government, so both stay under "still to be paid" for good, and the account in the books
  keeps growing. The register and the challan screen say so. Putting it right means a challan
  that can cover an expense's entry and a payroll run's tax: new columns or a table, so a
  migration.

## Questions for a tax adviser

- Is it right that tax deducted from salaries under section 149 is left out of the quarterly
  statement under section 165 and reported only in the employer's yearly statement? The code
  and the notes of Steps 41 and 42 assume so; nobody qualified has confirmed it.
- Are the columns of the section 165 report right for tax withheld on an expense (the expense's
  number where a bill's is, the reference where the supplier's invoice number is)?

## Tests

- `src/modules/purchase-reports/rules.test.ts`: the salaries' section, what is still to be
  paid with both counted, the note, and the register unchanged when there is neither.
- `src/modules/purchase-reports/reports.test.ts` (against a database): an expense with both
  taxes withheld, then an approved payroll run with tax; the register equals the books after
  each, as at the day before the run's journal, and after the expense is cancelled; section 165
  holds the expense and not the salaries.
- `src/modules/recovery/rules.test.ts`, `recovery.test.ts`: the two lines on aged receivables,
  the note when they differ, and who gets the comparison.
- `scripts/demo/parts/checks.ts`: the demo seed now refuses to finish unless the register
  agrees with the books.

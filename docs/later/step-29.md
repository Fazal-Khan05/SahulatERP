# Step 29: buying reports

Built in track B (stock and buying) by the Builder, on Step 28. **No migration**: the reports
only read. Built while the founder was away (2026-11-17); nothing here was asked of him. It
reads the tables of Steps 27 and 28, so it goes in after them.

## What was built

Under Reports, Purchases (`/purchase-reports/...`), each with a date or a period, a branch and
a supplier to narrow it by, a download as Excel or CSV, and a page for the printer:

- **Aged payables.** What is owed on each supplier's bills on a day, by how long it has been
  due (not yet due, 1 to 30 days, 31 to 60, 61 to 90, over 90), with what the supplier holds of
  the company's (money paid ahead, credit for goods sent back) and the net. As at any day: it
  counts only what had been billed, paid and sent back by then. With a supplier chosen, each
  bill is listed. Bills that were unpaid when the books were opened are included. The total is
  set beside Trade payables less Advances to suppliers in the books, and must agree.
- **Supplier statement.** For one supplier and a period: what was owed before, every bill,
  payment and return in the books, the running amount owed, and what is owed after.
- **Withholding register.** Every amount of tax withheld in a period, by kind of tax: the
  supplier and its NTN or CNIC, the bill, the line of the tax tables, whether the supplier was
  on the Active Taxpayers List, the amount the tax was on, the rate, the tax, and the challan
  it was paid under. Then what is still to be paid to the government at the end of the period,
  set beside the withholding payable accounts in the books.
- **Statement of tax withheld (section 165).** The income tax withheld in a period, payee by
  payee, with the section, NTN, CNIC, name, status, amount, rate, tax and CPR number and date:
  the facts FBR's quarterly statement asks for, to download and copy into it.
- **Goods received, not yet billed** (built in Step 24) now has the same downloads and print.

**The acceptance test**, "Withholding register totals equal withholding payable": in
`src/modules/purchase-reports/reports.test.ts` and on screen in `e2e/purchase-reports.spec.ts`.
Rs 10,000 and Rs 1,000 are withheld on two bills; the first is paid under a challan. The
register shows Rs 1,000 still to be paid, the withholding payable account holds Rs 1,000, and
the difference is nil; the day before the challan both were Rs 11,000.

## Decided for Fazal, to confirm

Nobody was asked these. Each is the option I would recommend; say if any should change.

1. **Who reads them.** The owner, an accountant and the auditor; nobody else.
2. **A bill is aged from the day it is due**; one with no due date, from its own date. Five
   bands, the last "over 90 days".
3. **Money paid ahead and credit for goods sent back are shown in a column of their own**,
   taken off what is owed to give the net. They are not aged.
4. **A payment that was cancelled later still counts on days before it was cancelled**, so a
   report for an earlier day agrees with the books of that day.
5. **The supplier statement is the company's own record**, in the company's words ("Billed",
   "Paid or sent back"). It is not laid out as a letter to send to the supplier.
6. **The section 165 statement is a table to copy from**, not a file in FBR's own format. FBR's
   form changes, and nobody has checked the columns against it (below).
7. **The date in the withholding reports is the day of the bill**, because that is when the
   product records tax as withheld (the open question of Steps 25 and 26).
8. **What is still to be paid over is shown for the whole company only**: challans belong to
   the whole company, so for one branch or one supplier the comparison is left out.

## The independent review

No migration, so there was nothing for the usual attack on the database. The reports read
through the same access rules as the screens (tested: other roles, another branch, another
company see nothing).

## For a tax adviser

No accountant or tax adviser has checked any of this.

- **The section 165 statement's layout.** The columns are the facts the statement needs, from
  memory of it. They must be checked against the current form in IRIS before anything is
  filed, and the "section" shown is the tax tables' legal reference for the line, which must
  match the payment sections FBR lists.
- **Payees without an NTN or CNIC** are listed with both empty. FBR's statement does not
  accept that; the supplier's card must be completed first.
- **The date of deduction.** FBR's statement wants the day tax was deducted, which the law
  ties to payment. Here it is the bill's date (see Steps 25 and 26).
- **Sales tax and provincial tax withheld** have their own statements (in the sales tax return
  and with the provinces). The register lists them; no statement is set out for them yet.

## Later

- **FBR's own file format** for the section 165 statement, once an adviser has confirmed it.
- **A statement to send to a supplier**, on the letterhead, in words meant for them.
- **Settling bills that were unpaid when the books were opened**: they are in aged payables,
  but a payment cannot yet be set against one (it becomes an advance instead).
- **Ageing by the bill's date** as a choice, and bands you set yourself.
- **Paging and search** inside a long report.

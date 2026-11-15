# Step 40: employees, pay, attendance, and the statutory tables

Track C (payroll), built by the Finisher. Migration `0030_payroll_employees` (five tables, a
guard, the statutory tables every company starts with). Nothing posts to the books: payroll runs,
payslips and their journals are Step 41's.

## Decided by the founder (2026-11-15)

- **Monthly staff and daily-wage staff.** A monthly employee has basic pay, allowances and fixed
  deductions; a daily employee has a daily wage.
- **Employees are their own records**, linked to a login only if they sign in.
- **Unpaid days off come off a monthly salary** at the month's pay divided by the days in the
  month, from an attendance file; a daily employee is paid for the days worked.
- **EOBI and social security per employee, by their province.**
- **Salaries are seen by the owner, the payroll administrator, the accountant and the auditor.**
- The batch's additive migrations may be applied to the shared database after an independent
  review.

## What is built

- **Employees** (`/payroll/employees`): code, name, designation, CNIC, the province they work in,
  branch, monthly or daily, the day they joined and left, registered with EOBI and with social
  security, and the login they sign in with. Nobody is deleted; someone who leaves gets the day
  they left. How someone is paid does not change once they have pay on record (SE320).
- **Pay** as dated rows, one part at a time: basic pay, house rent, medical, conveyance,
  utilities, other allowance, fixed deduction, or a daily wage. A raise is a new row from its day;
  nil ends a part; saving the same part on the same day corrects it. The employee's page shows pay
  today, the history, and the **income tax a month on that pay** from the table in force.
- **Attendance** (`/payroll/attendance`): a month at a time; a CSV file with the columns Code,
  Days worked and Unpaid days, all or nothing (every bad row listed, nothing kept), whole or half
  days, never more than the days the person was employed that month; a daily employee's days
  worked are always given. A month imported again replaces what was there for the employees in
  the file, and the audit log keeps what it replaced.
- **Statutory rates** (`/payroll/rates`): the salary tax tables of Tax Years 2026 and 2027 and the
  dated figures below, each with where it comes from. The owner, an accountant or the payroll
  administrator adds a figure from a date (a change in the law is a new row, never an edit).
- The menu: the owner's, accountant's and auditor's **Payroll** entry and the payroll
  administrator's **Employees** entry now lead here. Payroll runs and Payslips stay greyed until
  Step 41.

## The statutory tables every company starts with

Only what was read in a primary source on 15 November 2026 (FBR's Income Tax Ordinance compilation
to 30 June 2026 and its Withholding Tax Rates Card 2027; the gazette notifications named in each
row; the Acts). **Checked by Claude, not an accountant**; the figures are worked in
`docs/examples/step-40.md` and agreed by a blind second working.

| What | Figure | From | Source |
| --- | --- | --- | --- |
| Salary tax, Tax Year 2026 | six slabs, 0% to 35% | 1 Jul 2025 | ITO First Schedule Part I Div I cl.(2), Finance Act 2025 |
| Salary tax, Tax Year 2027 | eight slabs, 0% to 35% (20%, 25%, 29%, 32% new) | 1 Jul 2026 | the same, Finance Act 2026 |
| Surcharge on salary tax | 9% above Rs 10m; then nil | 1 Jul 2025; 1 Jul 2026 | ITO s.4AB proviso (FA 2025; FA 2026) |
| Medical allowance exempt | up to 10% of basic | 1 Jul 2003 | ITO Second Schedule Part I cl.(139) |
| EOBI, employer / employee | 5% / 1% | 2008 / 2001 | EOBI Act 1976 s.9(1), s.9B |
| EOBI wage | Rs 37,000; Rs 40,700 | 1 Jul 2024; 1 Jul 2026 | s.2(p), on the Islamabad minimum wage notifications |
| Minimum wage, Islamabad | Rs 37,000; Rs 40,700 | 1 Jul 2024; 1 Jul 2026 | ADLW-8(20)-ICT/2024-225; ADLW 8(20)-ICT/2024-934 of 19 Aug 2026 |
| Minimum wage, Punjab | Rs 40,000 | 1 Jul 2025 | SO(L&P) MW/2024 of 8 Sep 2025 |
| Minimum wage, Sindh | Rs 43,000 | 1 Jul 2026 | SO(L-II)/13-3/2016-II of 17 Aug 2026 |
| Minimum wage, KP | Rs 40,000 | 1 Jul 2025 | SOL/LD/8-4/2025/MWB/6927-7031 of 10 Sep 2025 |
| Social security, employer | 6% in Punjab, Sindh, KP, Balochistan | 1 Jul 2025 | each province's Act, s.20 |

**Not given to companies, because no primary source was found** (a company adds them under
Statutory rates once it has the notification): Balochistan's minimum wage; Punjab's 2026-27
minimum wage (Rs 40,000 is the last notified); KP's 2026-27 minimum wage (Rs 45,000 announced in
the budget, not notified by 15 November 2026); Islamabad's social security; the social security
wage ceilings.

## Decided for Fazal, to confirm

1. **Who keeps payroll: the owner and the payroll administrator.** The accountant and the auditor
   read it. The statutory rates are kept by the owner, an accountant or the payroll administrator,
   as tax rates are, and read by every member (they are the law).
2. **A payroll administrator limited to some branches sees only those branches' employees**, and
   an employee with no branch belongs to the whole company.
3. **The EOBI wage is the Islamabad minimum wage**, as EOBI's own circular of 2024 used, rather
   than each province's (the plan said "by province"). The 2026-27 figure (Rs 40,700) follows the
   Islamabad notification of 19 August 2026; EOBI's own circular for 2026-27 was not seen. Confirm
   with your tax adviser; it is one dated row to change.
4. **Who is covered by EOBI and by social security is a tick on each employee**, set by the
   company, rather than worked out from the number of staff (EOBI covers a company of five or
   more) or from wage ceilings that were not found in a primary source.
5. **The CNIC is kept, but never written into the audit log**; the log says only whether one was
   given. **Salaries are written into the audit log** (each pay change, before and after), because
   every command records what it changed; only the owner and the auditor read the log, but an
   auditor limited to some branches reads every branch's pay changes there. The other way is to
   keep amounts out of the log and record only that pay changed. Your call.
6. **Social security is 6% of the province's minimum wage** for every province with a statute
   read; Step 41 works it out per registered employee.
7. **A month's tax shown on the employee's page is the year's tax divided by twelve**, as if pay
   were the same all year. Step 41's payroll run adjusts for months that differ (s.149).
8. **The "Signs in as" choice lists the company's members only to the owner** (the members list
   is the owner's and the auditor's to read); a payroll administrator sees only themselves there.

## Review

An independent review (2026-11-15) found no salary leak to another role or another company, and
these, fixed before the migration reached any shared database: a payroll administrator saving an
employee could silently remove the link to their login (only the owner can list the company's
logins); audit rows missed the designation, branch and login, and an attendance import did not
record the days it replaced; an attendance file without a "Days worked" column, or with a daily
employee's days left blank, read as nil days; days were not checked against the days someone was
employed that month; the setting a new company's statutory tables are written under could open
the guard on employees and pay; and the employee page named the 10% medical share in its words
instead of reading it from the table. The trigger that gives a new company its tables sits on the
shared `tenants` table (a trigger of track C's own, as the commission trigger sits on track A's
tables); the coordinator may prefer it as a joint change.

## For a tax adviser

- The EOBI wage for 2026-27, and whether EOBI bills on the Islamabad or the provincial minimum
  wage (decision 3); some high courts have held 6% of Rs 3,000 (Dawn, 25 July 2025, secondary).
- The Punjab social security ceiling (Rs 40,000 reported, notification not found) and the 2026
  amendment bill's assent; the Sindh and Balochistan upper wage limits.
- The withholding card still shows a 10% surcharge on pensions above Rs 10 million although the
  s.4AB proviso as amended exempts salary; pensions are not in payroll yet.

## Tests

- `src/modules/payroll/rules.test.ts`: the tables, the acceptance (Rs 150,000 a month: 72,000 a
  year, 6,000 a month), every slab edge, the 2026 surcharge, the medical exemption, unpaid days and
  daily wages, the statutory lookups.
- `src/modules/payroll/payroll.test.ts`, against the database: every company (and a new one,
  made through the app) starts with the tables, whole; the acceptance from an employee's own pay;
  pay as dated rows; daily employees; plain refusals; the attendance file, all or nothing; who
  reads and who keeps; a branch's payroll administrator; adding a statutory figure.
- `e2e/payroll.spec.ts`, in the browser: an owner adds an employee and their pay and sees the
  tax; the payroll administrator imports a month's attendance; a salesperson has no way in.

## Later

- Payroll runs, payslips, journals, EOBI and social security amounts, commission settlement:
  Step 41. The bank file, the yearly statement, loans and final settlement: Step 42.
- **Correcting a salary tax slab** has no screen; a new table arrives with a migration each tax
  year, as the tax tables do.
- **An import of employees** from a file (the customers' import pattern), when a pilot has many.
- Provident fund and gratuity, overtime, and leave balances.

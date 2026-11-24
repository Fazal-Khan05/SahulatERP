# Step 41 worked example: a month's payroll, its tax, its commission and its journal

**Checked by Claude, not by an accountant** (the founder has none; decided 2026-11-13). The rates
are Step 40's (`docs/examples/step-40.md`, `docs/later/step-40.md`). Every figure below was worked
out by hand here, then a second time by an independent worker who was given only the rules and the
three people, not these answers or the software. Both agree on every figure (see the second
working at the end), and so do the tests: `src/modules/payroll-runs/rules.test.ts` for the rules
on their own, and `src/modules/payroll-runs/runs.test.ts` against the database.

## The rules

- November 2026 has 30 days; the tax year runs July to June, so November has **8 months left**,
  itself included.
- A monthly employee is paid each part of their pay × (days employed − unpaid days) ÷ days in the
  month; a daily employee the daily wage × days worked. The fixed deduction is taken whole.
- Commission paid = what is approved and released, less what they owe back (as far as it goes).
- Taxable this month = pay (less the medical allowance, exempt up to 10% of the basic paid) +
  commission. Regular monthly taxable = the same on the full month's pay, without commission.
- **s.149**: projected year = taxable before + this month + regular × months after (none if they
  leave this month). Tax this month = (the year's tax − tax deducted before) ÷ (months after + 1).
- EOBI: employee 1%, employer 5% of Rs 40,700. Social security: employer 6% of the province's
  minimum wage (Punjab Rs 40,000, Sindh Rs 43,000).
- Taxes and deductions never take pay below nil: tax first, then EOBI, then the fixed deduction.

The tax table for Tax Year 2027 is in `docs/examples/step-40.md`; the slab used here is
"over 1,200,000 to 2,200,000: 6,000 + 11% of the amount over 1,200,000".

## The three people

**A. Ayesha Khan, E-001**: monthly, Punjab, EOBI and social security. Basic 150,000, medical
15,000, fixed deduction 5,000. Three unpaid days. Commission approved and released 20,000 and
5,000; she owes back 3,000. Approved payslips July to October: taxable 600,000, tax 24,000.

- Days paid 27. Basic 150,000 × 27/30 = **135,000.00**; medical 15,000 × 27/30 = **13,500.00**;
  pay **148,500.00**.
- Commission 25,000 − 3,000 owed back = **22,000.00**.
- Medical exempt: the lesser of 13,500 and 10% × 135,000 = 13,500, so all of it.
  Taxable this month 135,000 + 22,000 = **157,000.00**. Regular 150,000 + 15,000 − 15,000 = 150,000.
- Year: 600,000 + 157,000 + 150,000 × 7 = **1,807,000.00**; tax 6,000 + 11% × 607,000 =
  **72,770.00**; this month (72,770 − 24,000) ÷ 8 = **6,096.25**.
- EOBI **407.00** (employer **2,035.00**); social security **2,400.00**.
- Take home 148,500 + 22,000 − 6,096.25 − 407 − 5,000 = **158,996.75**.

**B. Bilal Ahmed, E-002**: daily wage 2,000, Sindh, joined 10 November, worked 15 days, social
security only.

- Employed 21 days, worked 15: pay **30,000.00**. Year 30,000 + 30,000 × 7 = 240,000, under
  600,000: tax **0.00**. Social security 6% × 43,000 = **2,580.00**. Take home **30,000.00**.

**C. Kamran Ali, E-003**: monthly, Punjab, basic 300,000, left on 20 November. Approved payslips
July to October: taxable 1,200,000, tax 138,666.68 (four months of 416,000 ÷ 12 on 300,000 a
month).

- Employed 20 days: pay 300,000 × 20/30 = **200,000.00**. He leaves this month, so the year ends
  here: 1,200,000 + 200,000 = **1,400,000.00**; tax 6,000 + 11% × 200,000 = **28,000.00**; already
  deducted 138,666.68, so this month **0.00**. (He was over-deducted 110,666.68; payroll does not
  pay it back: he claims it in his return. Decision 5 in `docs/later/step-41.md`.)
- Take home **200,000.00**.

## The run and its journal

| | Pay | Commission | Tax | EOBI | Deductions | Take home | Employer EOBI | Social security |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| A | 148,500.00 | 22,000.00 | 6,096.25 | 407.00 | 5,000.00 | 158,996.75 | 2,035.00 | 2,400.00 |
| B | 30,000.00 | | | | | 30,000.00 | | 2,580.00 |
| C | 200,000.00 | | | | | 200,000.00 | | |
| **Run** | **378,500.00** | **22,000.00** | **6,096.25** | **407.00** | **5,000.00** | **388,996.75** | **2,035.00** | **4,980.00** |

Approval:

| | Account | Debit | Credit |
| --- | --- | ---: | ---: |
| Dr | 5210 Salaries and wages (378,500 − 5,000) | 373,500.00 | |
| Dr | 5215 Employer EOBI and social security (2,035 + 4,980) | 7,015.00 | |
| Dr | 2320 Commission payable | 22,000.00 | |
| Cr | 2300 Salaries payable | | 388,996.75 |
| Cr | 2210 Income tax withheld payable | | 6,096.25 |
| Cr | 2310 EOBI and social security payable (407 + 2,035 + 4,980) | | 7,422.00 |
| | **Total** | **402,515.00** | **402,515.00** |

The commission was expensed when it was earned (Dr 5220 / Cr 2320, Step 38). Here it only leaves
Commission payable for Salaries payable: 5220 does not move. Of Ayesha's 25,000, the 3,000 she
owed back is set against it, as Step 38's commission payment does: the commission ledger records
25,000 paid on the two sales and 3,000 recovered on the earlier one, and the books move only the
22,000 that changes hands. Commission payable always stands at what was earned less what was
paid: on the ledger, paid goes up by 25,000 on the two sales and down by 3,000 on the earlier one,
22,000 in all, which is exactly the debit to 2320. The recovery needs no entry of its own.

Payment from the bank: Dr 2300 Salaries payable 388,996.75 / Cr Bank 388,996.75.

## Months before payroll was run here

A company that starts its payroll here in November (as the design partner will) has no approved
payslips for July to October. For a person employed since July on 150,000 with nothing before,
those four months are taken as 150,000 a month taxed evenly: 6,000 each (72,000 on 1,800,000 a
year ÷ 12, Step 40's case A). So: assumed taxable 600,000 and tax 24,000; the year 600,000 +
150,000 + 150,000 × 7 = 1,800,000, tax 72,000; this month (72,000 − 24,000) ÷ 8 = **6,000.00**,
the same as had the year been run here. (Decision 4 in `docs/later/step-41.md`.)

## The second working

The independent worker, given the rules and the three people alone, agreed with every figure for
Bilal and Kamran, and for Ayesha with every figure but one, which came from how the rules were put
to them: they read the fixed deduction as one of the "parts of pay", prorated it to 4,500, and so
had take home 159,496.75, the run's deductions 4,500, take home 389,496.75 and the journal
balancing at 403,015.00. Their own alternative, the deduction taken whole, is word for word the
figures above: 158,996.75, 388,996.75, Salaries and wages 373,500 and the journal at 402,515.00.
The rule is that a fixed deduction (a loan instalment, an advance) is taken whole; the rules above
now say so. They also confirmed that commission is left out of the regular pay projected for later
months (counting it would put Ayesha's tax at 8,213.75), and asked that the 3,000 recovery be shown
to need no entry of its own, which the paragraph under the journal now does.

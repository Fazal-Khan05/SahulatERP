# Step 40 worked example: income tax on salary, unpaid days, EOBI and social security

**Checked by Claude, not by an accountant** (the founder has none; decided 2026-11-13). The
tables were read on 15 November 2026 in FBR's Income Tax Ordinance 2001 "amended upto 30th June,
2026" and its Withholding Tax Rates Card 2027, and in the notifications listed in
`docs/later/step-40.md`. Every figure below was worked out by hand here, then a second time by an
independent reviewer who was given only the rules and the cases, not these answers or the
software. Both agree on every figure, and so do the tests: `src/modules/payroll/rules.test.ts`
for the rules on their own, and `src/modules/payroll/payroll.test.ts` against the database.

## The rules

**Income tax on salary** (Income Tax Ordinance 2001, First Schedule, Part I, Division I, clause (2):
salary is more than 75% of taxable income). Tax Year 2027 runs from 1 July 2026 (Finance Act 2026):

| Taxable income a year over | Up to | Tax |
| ---: | ---: | --- |
| 0 | 600,000 | 0 |
| 600,000 | 1,200,000 | 1% of the amount over 600,000 |
| 1,200,000 | 2,200,000 | 6,000 + 11% of the amount over 1,200,000 |
| 2,200,000 | 3,200,000 | 116,000 + 20% of the amount over 2,200,000 |
| 3,200,000 | 4,100,000 | 316,000 + 25% of the amount over 3,200,000 |
| 4,100,000 | 5,600,000 | 541,000 + 29% of the amount over 4,100,000 |
| 5,600,000 | 7,000,000 | 976,000 + 32% of the amount over 5,600,000 |
| 7,000,000 | no limit | 1,424,000 + 35% of the amount over 7,000,000 |

Tax Year 2026 (from 1 July 2025, Finance Act 2025) had 23% from 2.2m (fixed 116,000), 30% from
3.2m (fixed 346,000) and 35% above 4.1m (fixed 616,000); the first three slabs were the same. Its
surcharge on salaried individuals was 9% of the tax above Rs 10 million of taxable income
(s.4AB proviso); Finance Act 2026 removed it for salary.

Each fixed amount is what the slabs below it come to (1% of 600,000 = 6,000; 6,000 + 11% of
1,000,000 = 116,000; and so on); the software refuses a table where that is not so.

**A month's tax** is the year's tax on twelve times the month's taxable pay, divided by twelve,
while pay is the same all year. Section 149 deducts at the average rate on the estimated year,
adjusted for months that differ; that adjustment is Step 41's, with the payroll run.

**What is taxed**: everything paid, less a medical allowance up to 10% of basic pay where the
employer gives no free medical treatment (Second Schedule, Part I, clause (139)). House rent,
utilities and conveyance allowances are taxed in full (s.12(2)(c)). A fixed deduction from pay is
taken from pay, not from what is taxed.

**Unpaid days** (the founder's decision, 2026-11-15): a monthly salary loses the month's pay
divided by the days in the calendar month for each unpaid day. A daily wage is paid for each day
worked.

**EOBI**: the employer pays 5% and the employee 1% of the notified minimum wage, not of the
salary (EOBI Act 1976 s.9, s.9B, s.2(p)). **Sindh social security**: the employer pays 6% of the
Sindh minimum wage (Sindh Employees' Social Security Act 2016 s.20(1)).

## The cases

**A. Basic Rs 150,000 a month (the step's acceptance).** 150,000 × 12 = 1,800,000 a year, in the
slab over 1,200,000: 6,000 + 11% × 600,000 = 6,000 + 66,000 = **72,000 a year, 6,000 a month**.

**B. Basic 165,000, medical 165,000 × 10% allows 16,500, so all of a 15,000 medical allowance is
exempt; a fixed deduction of 2,000.** Taxable 165,000 a month, 1,980,000 a year: 6,000 + 11% ×
780,000 = 6,000 + 85,800 = **91,800 a year, 7,650 a month**. The 2,000 comes off the pay, not off
what is taxed.

**C. Basic 100,000, house rent 45,000, medical 15,000, conveyance 5,000.** Paid 165,000; medical
exempt up to 10,000; taxable **155,000 a month**, 1,860,000 a year: 6,000 + 11% × 660,000 = 6,000
+ 72,600 = **78,600 a year, 6,550 a month**.

**D. Basic 1,000,000 a month, Tax Year 2026.** 12,000,000 a year: 616,000 + 35% × 7,900,000 =
616,000 + 2,765,000 = 3,381,000; surcharge 9% = 304,290; **3,685,290 a year, 307,107.50 a month**.

**E. The same in Tax Year 2027.** 1,424,000 + 35% × 5,000,000 = 1,424,000 + 1,750,000 =
**3,174,000 a year, 264,500 a month**; no surcharge.

**F. Taxable income of Rs 600,001.** 1% of the 1 over 600,000 = **0.01**: a slab starts just over
its lower bound.

**G. Unpaid days and days worked.**
- 60,000 in November 2026 (30 days), 3 unpaid days: 60,000 − 60,000 ÷ 30 × 3 = 60,000 − 6,000 = **54,000**.
- 62,000 in December 2026 (31 days), 1.5 unpaid days: 62,000 − 2,000 × 1.5 = **59,000**.
- A daily wage of 1,600 for 24.5 days: **39,200**.

**H. EOBI and social security.**
- On a minimum wage of 40,700: the employer **2,035**, the employee **407** a month.
- Sindh social security on 43,000: the employer **2,580** a month.

## The second working

The reviewer's figures, worked from the rules and the cases alone, agree with every bold figure
above: A 1,800,000 / 72,000 / 6,000; B 165,000 / 91,800 / 7,650; C 155,000 / 78,600 / 6,550;
D 3,381,000 / 304,290 / 3,685,290 / 307,107.50; E 3,174,000 / 264,500; F 0.01; G 54,000 /
59,000 / 39,200; H 2,035 / 407 / 2,580.

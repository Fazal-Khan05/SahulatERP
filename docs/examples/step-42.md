# Step 42 worked example: loans to staff, final settlement, the bank file and the year's statement

**Checked by Claude, not by an accountant** (the founder has none; decided 2026-11-13). The tax
rules are Step 41's (`docs/examples/step-41.md`). Every figure below was worked out by hand here,
then a second time by an independent worker who was given only the rules and the events, not
these answers or the software (see the second working at the end). The database test
`src/modules/staff-loans/loans.test.ts` holds the same figures.

## The rules

- A loan is paid out of cash: **Dr 1240 Loans and advances to staff, Cr the cash account**.
- When a month is worked out, each loan still owed gives a deduction of its instalment, or what
  is still owed if less. In the month a person leaves it is **everything still owed**. Loans are
  taken oldest first, after tax, EOBI and the fixed deduction, and only as far as the pay goes; a
  payslip never goes below nil.
- Approval: **Dr 5210 Salaries and wages** the whole pay (the instalments are not taken off the
  cost), **Cr 1240** the instalments, **Cr 2300 Salaries payable** what the people take home,
  **Cr 2210 Income tax withheld payable** the tax.
- A repayment in cash: **Dr the cash account, Cr 1240**; never more than is owed.
- Tax is Step 41's s.149 rule. Months employed in the tax year before payroll was first run here
  are taken as paid at the person's regular pay with the regular month's tax. On Rs 1,00,000 a
  month the year is 12,00,000 and its tax 1% × (12,00,000 − 6,00,000) = 6,000, **500 a month**; on
  Rs 60,000 the year is 7,20,000 and its tax 1% × 1,20,000 = 1,200, **100 a month**. In the month
  someone leaves, nothing is projected after it, and tax already deducted is never given back
  through payroll (tax this month is never below nil).
- A monthly salary in a month someone leaves is paid for the days employed: salary × days ÷ days
  in the month, to the paisa.

## The events

The company's tax year began 1 July 2026; nothing was run here before September.

- **Ali Raza, E-001**: monthly, Rs 1,00,000, joined 1 July 2026.
- **Sara Khan, E-002**: monthly, Rs 60,000, joined 1 July 2026, **left 20 October 2026**.

1. 5 August: Ali is lent **30,000**, 10,000 a month (SL-1).
2. 1 September: Sara is lent **50,000**, 5,000 a month (SL-2).
3. September's payroll is worked out and approved.
4. October's payroll is worked out and approved.
5. 1 November: Sara repays the rest of her loan in cash.

## The loans

| | Dr 1240 | Cr 1111 Cash |
| --- | ---: | ---: |
| SL-1, Ali, 5 August | 30,000.00 | 30,000.00 |
| SL-2, Sara, 1 September | 50,000.00 | 50,000.00 |

## September

Ali: tax: July and August taken as paid (taxable 2,00,000, tax 1,000); the year 2,00,000 +
1,00,000 + 1,00,000 × 9 = 12,00,000, tax 6,000; this month (6,000 − 1,000) ÷ 10 = **500.00**.
Loan SL-1: **10,000.00**. Takes home 1,00,000 − 500 − 10,000 = **89,500.00**.

Sara: July and August taken as paid (1,20,000, tax 200); the year 7,20,000, tax 1,200; this month
(1,200 − 200) ÷ 10 = **100.00**. Loan SL-2: **5,000.00**. Takes home 60,000 − 100 − 5,000 =
**54,900.00**.

| | Account | Dr | Cr |
| --- | --- | ---: | ---: |
| | 5210 Salaries and wages | 1,60,000.00 | |
| | 1240 Loans and advances to staff | | 15,000.00 |
| | 2300 Salaries payable | | 1,44,400.00 |
| | 2210 Income tax withheld payable | | 600.00 |
| | **Total** | **1,60,000.00** | **1,60,000.00** |

Owed after September: Ali 20,000.00, Sara 45,000.00.

**The bank file** for September (each person to the IBAN on their page):

```
Sr No,Beneficiary IBAN,Beneficiary Name,Amount,Payment Reference
1,PK36SCBL0000001123456702,ALI RAZA,89500.00,SALARY SEP 2026 E-001
2,PK72HABB0012345678901234,SARA KHAN,54900.00,SALARY SEP 2026 E-002
```

Its total, 1,44,400.00, is what 2300 Salaries payable holds for the month.

Ali's IBAN, checked: its first four characters moved to the end, SCBL0000001123456702PK36, letters
as numbers (A = 10 … Z = 35: S 28, C 12, B 11, L 21, P 25, K 20) give
281211210000001123456702252036, which leaves **1** on division by 97: a valid IBAN. With its last
digit typed as 3 instead of 2 it leaves 28, and is refused.

## October

Ali: before, September's payslip (1,00,000, tax 500) and July and August taken as paid (2,00,000,
tax 1,000); the year 1,00,000 + 2,00,000 + 1,00,000 + 1,00,000 × 8 = 12,00,000, tax 6,000; this
month (6,000 − 500 − 1,000) ÷ 9 = **500.00**. Loan **10,000.00**; takes home **89,500.00**.

Sara leaves on the 20th: pay 60,000 × 20 ÷ 31 = 38,709.677… = **38,709.68**. Tax: the year is
60,000 (September) + 1,20,000 (July and August) + 38,709.68 = 2,18,709.68, nothing projected after
October; under 6,00,000, so the year's tax is nil, and nil − 100 − 200 is below nil: tax this month
**0.00**. Final settlement: all she owes, 45,000.00, as far as the pay goes: **38,709.68**. Takes
home **0.00**; still owed **6,290.32**.

| | Account | Dr | Cr |
| --- | --- | ---: | ---: |
| | 5210 Salaries and wages | 1,38,709.68 | |
| | 1240 Loans and advances to staff | | 48,709.68 |
| | 2300 Salaries payable | | 89,500.00 |
| | 2210 Income tax withheld payable | | 500.00 |
| | **Total** | **1,38,709.68** | **1,38,709.68** |

The bank file for October has Ali alone (89,500.00): Sara has nothing to take home.

## Final settlement in cash

1 November, Sara repays **6,290.32** (LR-1): Dr 1111 Cash 6,290.32, Cr 1240 6,290.32. A repayment
of 6,290.33 is refused: more than is owed.

**1240 Loans and advances to staff** now holds 30,000 + 50,000 − 15,000 − 48,709.68 − 6,290.32 =
**10,000.00**: Ali's 30,000 less his two instalments. Sara owes nothing.

## The year's statement, Tax Year 2027 (1 July 2026 to 30 June 2027), so far

From the approved payslips (September and October):

| Code | Name | Months paid | Pay and commission | Taxable salary | Income tax deducted |
| --- | --- | ---: | ---: | ---: | ---: |
| E-001 | Ali Raza | 2 | 2,00,000.00 | 2,00,000.00 | 1,000.00 |
| E-002 | Sara Khan | 2 | 98,709.68 | 98,709.68 | 100.00 |
| | **Total** | | **2,98,709.68** | **2,98,709.68** | **1,100.00** |

July and August, before payroll was run here, are not in it: the statement holds what this
company's payroll paid and deducted.

## The second working

(To be filled in from the independent worker's answers.)

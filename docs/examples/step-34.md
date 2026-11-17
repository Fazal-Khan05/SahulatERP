# Step 34 worked example: transfers, and an expense with tax withheld

**Checked by Claude, not by an accountant** (the founder has none; decided 2026-11-13). The
withholding follows Step 25's rules (`docs/examples/step-25.md`, section 6) for money paid at once
instead of owed. Every figure below was worked out here, then a second time by an independent
reviewer given only the rules and the cases, not these answers or the software. Both agree on
every figure and every entry, and so do the tests: `src/modules/cash-bank/rules.test.ts` and
`src/modules/cash-bank/cash-bank.test.ts`.

## The rules

An expense is paid at once out of a cash or bank account, by a company that withholds tax from
its suppliers (Purchases, settings):

- The province's sales tax on services is charged on the lines at the province's rate (Punjab 16%,
  Sindh 15%; the withholding tables' line of that province on the expense's date), **added to the
  cost and withheld whole**, as Step 25 does for a service bill. Each line takes its share in
  proportion, rounded to paisa, the last line taking what is left.
- Income tax under s.153(1)(b), "any other service", is withheld on the gross (the lines and the
  province's tax) at 14% for a supplier on the Active Taxpayers List, 28% for one not on it, as
  recorded for the supplier on the day.
- What leaves the account is the gross less everything withheld.

| Account | Debit | Credit |
| --- | ---: | ---: |
| each expense line's account | amount + share | |
| 2230 Provincial sales tax withheld payable | | province's tax |
| 2210 Income tax withheld payable | | income tax |
| the cash or bank account | | what was paid |

A transfer debits the account the money went to and credits the one it left. A transfer or an
expense entered by mistake is cancelled: its journal is posted again the other way round.

## The cases

**A. The acceptance.** Lahore Parts, not on the list, repairs the shop front for 30,000.00 and
paints it for 20,000.00, both Repairs and maintenance, paid from HBL. Punjab's 16% on 50,000.00 is
**8,000.00**, shared **4,800.00** and **3,200.00**; the gross is **58,000.00**; income tax at 28% of
it is **16,240.00**; **24,240.00** is withheld; **33,760.00** leaves the bank.

| Account | Debit | Credit |
| --- | ---: | ---: |
| 5270 Repairs and maintenance (shop front) | 34,800.00 | |
| 5270 Repairs and maintenance (painting) | 23,200.00 | |
| 2230 Provincial sales tax withheld payable | | 8,000.00 |
| 2210 Income tax withheld payable | | 16,240.00 |
| 1121 HBL current account | | 33,760.00 |

**B.** The same 50,000.00 as one line, from a supplier **on** the list: income tax at 14% of
58,000.00 is **8,120.00**; **41,880.00** is paid.

**C.** Three lines of 100.00, Sindh, no income tax: the province's tax is **45.00**, shared
**15.00** each; **45.00** is withheld and **300.00** paid.

**D.** Lines of 33.33, 33.33 and 33.34, Punjab: the tax is **16.00**; the shares are **5.33**,
**5.33** and **5.34** (the last takes what is left).

**E.** 15,000.00 moved from HBL to Petty cash: debit 1112 Petty cash 15,000.00, credit 1121 HBL
15,000.00.

**F.** HBL, starting from nothing: after E **-15,000.00**; after A **-48,760.00**; after a bank
charge of 300.00 (debit 5810 Bank charges) **-49,060.00**; after A is cancelled **-15,300.00**.
The cancellation posts A again the other way round: credit 5270 34,800.00 and 23,200.00, debit
2230 8,000.00, debit 2210 16,240.00, debit 1121 33,760.00. A bank account may go below nil (an
overdraft); see the decisions in `docs/later/step-34.md`.

## The second working

The reviewer's figures, worked from the rules and the cases alone, agree with every bold figure
and every entry above.

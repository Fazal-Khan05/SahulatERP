# Step 13 worked example: the posting engine

Checked by Claude, not by an accountant (the founder has none; decided 2026-11-13). The expected
journals were worked out from standard double-entry practice, worked out a second time by an
independent reviewer who did not see the first answer, and both were compared with what the
software posts. All three agree. The test "posts the worked example exactly as written" in
`src/modules/ledger/posting.test.ts` posts these entries through the engine and fails if the
software ever posts anything else.

## The company

A sole proprietor's trading business that keeps its books in rupees. From its chart of accounts:

| Code | Account | Type |
| --- | --- | --- |
| 1111 | Cash in hand | Asset |
| 1121 | HBL current account | Asset (a bank account) |
| 3100 | Owner's capital | Equity |
| 5230 | Rent | Expense |

## What happened

1. **2 November 2026.** The owner pays the shop's rent for November, Rs 40,000, in cash.
2. **5 November 2026.** The owner puts Rs 500,000 of their own money into the business:
   Rs 450,000 into the HBL current account and Rs 50,000 into the cash box.
3. **10 November 2026.** The rent entry of 2 November turns out to have been entered twice. A
   posted journal is never changed or deleted, so it is reversed, dated 10 November.

## The journals

### 1. Rent paid in cash, 2 November 2026

| Line | Account | Debit | Credit |
| --- | --- | ---: | ---: |
| 1 | 5230 Rent | 40,000.00 | |
| 2 | 1111 Cash in hand | | 40,000.00 |
| | | 40,000.00 | 40,000.00 |

An expense goes up with a debit; cash goes down with a credit.

### 2. Owner's money put in, 5 November 2026

| Line | Account | Debit | Credit |
| --- | --- | ---: | ---: |
| 1 | 1121 HBL current account | 450,000.00 | |
| 2 | 1111 Cash in hand | 50,000.00 | |
| 3 | 3100 Owner's capital | | 500,000.00 |
| | | 500,000.00 | 500,000.00 |

Bank and cash go up with debits; what the business owes its owner goes up with a credit.

### 3. Reversal of journal 1, 10 November 2026

| Line | Account | Debit | Credit |
| --- | --- | ---: | ---: |
| 1 | 5230 Rent | | 40,000.00 |
| 2 | 1111 Cash in hand | 40,000.00 | |
| | | 40,000.00 | 40,000.00 |

The same lines as journal 1, in the same order, with every debit and credit swapped. Journal 1
stays in the books untouched; the reversal names it, and it cannot be reversed a second time.

## What is left on each account

| Account | Debits | Credits | Balance |
| --- | ---: | ---: | ---: |
| 1111 Cash in hand | 90,000.00 | 40,000.00 | 50,000.00 debit |
| 1121 HBL current account | 450,000.00 | | 450,000.00 debit |
| 3100 Owner's capital | | 500,000.00 | 500,000.00 credit |
| 5230 Rent | 40,000.00 | 40,000.00 | nil |
| Total | 580,000.00 | 580,000.00 | |

Debit balances (500,000.00) equal credit balances (500,000.00).

## What the engine guarantees for every journal

- Debits equal credits, to the fourth decimal, or nothing is kept. The database checks this
  itself when the transaction ends, whoever wrote the rows.
- A journal has at least two lines; each line is a debit or a credit above zero, never both.
- Nothing is rounded: an amount with more than four decimals is refused.
- One source document posts one journal. Posting the same document twice is refused.
- The date must fall in a fiscal period that is open and not locked.
- A posted journal is never changed or deleted, by anyone. A correction is a reversal.

## Assumptions

- The rent is for the current month, so it is an expense on the day it is paid: no prepayment.
- No income tax is withheld from the rent. Withholding on payments arrives with supplier bills
  (Step 25).
- The owner's money is new capital, not a loan and not an opening balance.

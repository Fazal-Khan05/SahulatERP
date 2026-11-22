# Step 26 worked example: supplier payments, advances and challans

Checked by Claude, not by an accountant (the founder has none; decided 2026-11-13). The expected
journals were worked out from standard double-entry practice, worked out a second time by an
independent reviewer who was given only the events below and the company's policies, not the
first answer or the software, and both were compared with what the software posts. All three
agree line for line on every entry. The tests in
`src/modules/supplier-payments/payments.test.ts` enter these payments and fail if the software
ever posts anything else.

The second working also questioned some of the policies as tax practice. Those doubts are
listed in `docs/later/step-26.md` under "For a tax adviser"; none has been settled.

## The company

Lahore Bike Parts keeps its books in rupees, to the paisa, and withholds tax from its
suppliers. How it treats paying them (the founder's decision of 2026-11-15, and the choices made
for him in `docs/later/step-26.md`):

- A bill is already in the books when it is paid: when it was posted, Trade payables was
  credited with what is owed to the supplier **after** the tax withheld, and the tax went to the
  withholding payable account (Step 25).
- A payment settles named bills (debit Trade payables); whatever is left over is an advance
  (debit Advances to suppliers); the cash or bank account is credited with the rupees paid.
- An advance is later set against a bill: debit Trade payables, credit Advances to suppliers.
- A payment abroad is recorded at the rupees that left the account. The foreign amount is kept
  for the record. An advance is never revalued.
- A payment entered by mistake is cancelled: the opposite of every entry it caused is posted
  on the day it is cancelled.
- Tax withheld is paid to the government under a challan: debit the withholding payable
  account, credit the cash or bank account.

## 1. Money sent ahead

1 November: Rs 50,000.00 goes from the bank to Karachi Motors (Pvt) Ltd before any bill. The
bank turned it into USD 178.57 (280.0022 rupees each), which is noted on the payment.

| Account | Debit | Credit |
| --- | ---: | ---: |
| 1210 Advances to suppliers (Karachi Motors) | 50,000.00 | |
| HBL current account | | 50,000.00 |

## 2. Paying bills

4 November: two bills from Lahore Parts are posted, 2,400.00 and 3,900.00, nothing withheld.
6 November: a cheque for 3,400.00 pays the first in full and 1,000.00 of the second.

| Account | Debit | Credit |
| --- | ---: | ---: |
| 2110 Trade payables (Lahore Parts) | 3,400.00 | |
| HBL current account | | 3,400.00 |

2,900.00 is still owed on the second bill. More than is owed on a bill is refused.

## 3. The plan's test: a bill paid with an advance and the rest in money

4 November: Karachi Motors' bill is posted: 100,000.00, of which 10,000.00 income tax is
withheld, so 90,000.00 is owed. 6 November: the 50,000.00 advance is set against it.

| Account | Debit | Credit |
| --- | ---: | ---: |
| 2110 Trade payables (Karachi Motors) | 50,000.00 | |
| 1210 Advances to suppliers (Karachi Motors) | | 50,000.00 |

The same day the remaining 40,000.00 is paid from the bank.

| Account | Debit | Credit |
| --- | ---: | ---: |
| 2110 Trade payables (Karachi Motors) | 40,000.00 | |
| HBL current account | | 40,000.00 |

It nets: nothing is owed on the bill, nothing is left of the advance, the supplier received
90,000.00 in all (the bill less the tax), and the 10,000.00 withheld is owed to the government.

## 4. Money with no bill to set it against

6 November: 700.00 is paid to Karachi Motors in cash, with no bill named.

| Account | Debit | Credit |
| --- | ---: | ---: |
| 1210 Advances to suppliers (Karachi Motors) | 700.00 | |
| 1111 Cash in hand | | 700.00 |

## 5. A payment taken back

A bill from Lahore Parts for 1,000.00 is posted on 4 November. 6 November: 1,500.00 is paid from
the bank, 600.00 against the bill; 900.00 is left over.

| Account | Debit | Credit |
| --- | ---: | ---: |
| 2110 Trade payables (Lahore Parts) | 600.00 | |
| 1210 Advances to suppliers (Lahore Parts) | 900.00 | |
| HBL current account | | 1,500.00 |

8 November: 400.00 of what was left over is set against the same bill, which is then paid.

| Account | Debit | Credit |
| --- | ---: | ---: |
| 2110 Trade payables (Lahore Parts) | 400.00 | |
| 1210 Advances to suppliers (Lahore Parts) | | 400.00 |

9 November: the payment turns out to have been entered twice and is cancelled. The opposite of
both entries is posted that day:

| Account | Debit | Credit |
| --- | ---: | ---: |
| HBL current account | 1,500.00 | |
| 2110 Trade payables (Lahore Parts) | | 600.00 |
| 1210 Advances to suppliers (Lahore Parts) | | 900.00 |

| Account | Debit | Credit |
| --- | ---: | ---: |
| 1210 Advances to suppliers (Lahore Parts) | 400.00 | |
| 2110 Trade payables (Lahore Parts) | | 400.00 |

The bill is owed in full again, 1,000.00; the bank has its 1,500.00 back; nothing is left in
Advances to suppliers for Lahore Parts.

## 6. The challan

A second bill from Karachi Motors (10,000.00, 1,000.00 withheld, 9,000.00 owed) is posted on
4 November. 10 November: the 10,000.00 withheld on the first bill is paid from the bank under
challan IT-20261110-0001.

| Account | Debit | Credit |
| --- | ---: | ---: |
| 2210 Income tax withheld payable | 10,000.00 | |
| HBL current account | | 10,000.00 |

## Where it ends

| Account | Balance |
| --- | ---: |
| HBL current account | 103,400.00 paid out in all |
| 1111 Cash in hand | 700.00 paid out |
| 1210 Advances to suppliers | 700.00 debit: Karachi Motors 700.00, Lahore Parts nil |
| 2110 Trade payables | 12,900.00 credit: Karachi Motors 9,000.00 (its second bill); Lahore Parts 3,900.00 (2,900.00 and 1,000.00) |
| 2210 Income tax withheld payable | 1,000.00 credit: withheld on the second bill, not yet paid over |

After every run the tests check that Trade payables is what posted bills are owed less what
posted payments settled, that Advances to suppliers is what is left of posted payments, and
that the withholding account is what has been withheld and not yet paid under a challan.

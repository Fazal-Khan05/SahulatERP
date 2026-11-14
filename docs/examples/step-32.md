# Step 32 worked example: receipts and cheques

Checked by Claude, not by an accountant (the founder has none; decided 2026-11-13). The expected
journals were worked out from standard double-entry practice, worked out a second time by an
independent reviewer who was given only the events below and the company's policies, not the
first answer or the software, and both were compared with what the software posts. They agree
line for line, with one deliberate difference in event 7, explained there. The tests in
`src/modules/receipts/receipts.test.ts` enter these receipts and fail if the software ever
posts anything else.

## The company

Karachi Bike Parts is not registered for sales tax, so no figure here carries tax. Its books
opened on 1 October 2026.

How it treats money received (the founder's decisions, 2026-11-14):

- A cheque brings the customer's balance down on the day it is **received**. Until the bank
  clears it, it is held in Cheques in hand. Depositing it is not an entry in the books.
- Money received beyond the invoices it is set against is the customer's **advance**, until it
  is set against an invoice.
- What a bank keeps out of money coming in is an expense, Bank charges.
- A cheque that bounces, and a receipt entered by mistake and cancelled, are taken back on the
  day of the bounce or the cancellation, and the invoices they paid are unpaid again.

Where it starts, and what it sells in October (the cost of the goods is left out here; Step 20's
example covers it):

| Date | Document | Customer | Amount |
| --- | --- | --- | ---: |
| before 1 Oct | OLD-77, unpaid at opening | Karachi Dealer | 1,200.00 |
| 10 Oct | SI-2627-00001 | Karachi Dealer | 5,000.00 |
| 12 Oct | SI-2627-00002 | Karachi Dealer | 3,000.00 |
| 12 Oct | SI-2627-00003 | Walk-in Rider | 2,000.00 |

Cash in hand at opening: 10,000.00.

## 1. A bank receipt with a bank charge, then cancelled

14 October: Walk-in Rider's 2,000 for SI-2627-00003 arrives in the HBL account. The bank kept
50, so 1,950 reached the account. The customer has paid the whole 2,000.

| Account | Debit | Credit |
| --- | ---: | ---: |
| 1121 HBL current account | 1,950.00 | |
| 5810 Bank charges | 50.00 | |
| 1200 Trade receivables (Walk-in Rider) | | 2,000.00 |

15 October: it was entered against the wrong customer and is cancelled. The same three lines,
the other way round, dated 15 October. SI-2627-00003 is unpaid again: 2,000.00.

## 2. Cash, part of it an advance

15 October: Karachi Dealer pays 6,000 in cash. 5,000 is set against SI-2627-00001, 500 against
SI-2627-00002, and 500 is left on account.

| Account | Debit | Credit |
| --- | ---: | ---: |
| 1111 Cash in hand | 6,000.00 | |
| 1200 Trade receivables (Karachi Dealer) | | 5,500.00 |
| 2130 Advances from customers (Karachi Dealer) | | 500.00 |

16 October: the 500 is set against SI-2627-00002, 300 and then 200. Each is an entry of its
own that moves the amount from advances to the customer's account:

| Account | Debit | Credit |
| --- | ---: | ---: |
| 2130 Advances from customers (Karachi Dealer) | 300.00 | |
| 1200 Trade receivables (Karachi Dealer) | | 300.00 |

and the same for 200.00. SI-2627-00002 now has 3,000 - 500 - 300 - 200 = 2,000.00 unpaid.

## 3. A cheque: received, deposited, cleared, and then bounced

16 October: Karachi Dealer hands over cheque 00451872 for 2,000, dated 20 October, for
SI-2627-00002. The invoice is paid from today; the cheque is an asset in hand.

| Account | Debit | Credit |
| --- | ---: | ---: |
| 1130 Cheques in hand | 2,000.00 | |
| 1200 Trade receivables (Karachi Dealer) | | 2,000.00 |

20 October: deposited in the HBL account. Nothing is posted: it is still a cheque.

22 October: it clears. The bank kept 25.

| Account | Debit | Credit |
| --- | ---: | ---: |
| 1121 HBL current account | 1,975.00 | |
| 5810 Bank charges | 25.00 | |
| 1130 Cheques in hand | | 2,000.00 |

25 October: the bank takes it back after all. Two entries, both dated 25 October. First the
bank takes the whole cheque out of the account again, so the cheque is back in hand; the 25 the
bank kept for collecting it is not given back and stays an expense:

| Account | Debit | Credit |
| --- | ---: | ---: |
| 1130 Cheques in hand | 2,000.00 | |
| 1121 HBL current account | | 2,000.00 |

Then the receipt itself is taken back, and SI-2627-00002 has 2,000.00 unpaid again:

| Account | Debit | Credit |
| --- | ---: | ---: |
| 1200 Trade receivables (Karachi Dealer) | 2,000.00 | |
| 1130 Cheques in hand | | 2,000.00 |

**The one difference from the independent derivation.** The reviewer, following the policy as it
was put to them ("everything is reversed"), reversed the 25 as well, and in the same breath said
that this was wrong: a bank that returns a cheque takes back the whole 2,000 and keeps its
charge, so the books would end 25 away from the bank statement. The software does what the
bank does: the HBL account ends 25 overdrawn in the books, as on the statement, and Bank
charges keeps the 25. A cheque that bounces before it has cleared has no such charge to keep,
and is simply reversed (events 5 and 6).

## 4. Cash against an opening invoice

17 October: Karachi Dealer pays 700 in cash against OLD-77.

| Account | Debit | Credit |
| --- | ---: | ---: |
| 1111 Cash in hand | 700.00 | |
| 1200 Trade receivables (Karachi Dealer) | | 700.00 |

OLD-77 has 500.00 unpaid. The opening balances cannot now be reversed while this receipt stands.

## 5. A cheque that bounces while still in hand

26 October: cheque 00451873 for 1,500: 1,000 against SI-2627-00002, 500 on account.

| Account | Debit | Credit |
| --- | ---: | ---: |
| 1130 Cheques in hand | 1,500.00 | |
| 1200 Trade receivables (Karachi Dealer) | | 1,000.00 |
| 2130 Advances from customers (Karachi Dealer) | | 500.00 |

27 October: it bounces before it was deposited. The same three lines the other way round. The
invoice is back to 2,000.00 unpaid and the advance is gone.

## 6. A cheque entered by mistake

26 October: a cheque for 700 against SI-2627-00002 is recorded by mistake and cancelled the
same day while still in hand: Cheques in hand 700 against Trade receivables 700, and the same
the other way round.

## 7. The last of the invoice, in cash

28 October: Karachi Dealer pays 2,000 in cash against SI-2627-00002.

| Account | Debit | Credit |
| --- | ---: | ---: |
| 1111 Cash in hand | 2,000.00 | |
| 1200 Trade receivables (Karachi Dealer) | | 2,000.00 |

## Where the books stand on 30 October

| Account | Balance |
| --- | ---: |
| 1111 Cash in hand | 10,000 + 6,000 + 700 + 2,000 = 18,700.00 debit |
| 1121 HBL current account | 1,950 - 1,950 + 1,975 - 2,000 = 25.00 credit (overdrawn by the bank's charge) |
| 1130 Cheques in hand | nil |
| 1200 Trade receivables | Karachi Dealer 500.00, Walk-in Rider 2,000.00: 2,500.00 debit |
| 2130 Advances from customers | nil |
| 5810 Bank charges | 50 - 50 + 25 = 25.00 debit |

| Invoice | Still unpaid |
| --- | ---: |
| OLD-77 | 500.00 |
| SI-2627-00001 | nil |
| SI-2627-00002 | nil |
| SI-2627-00003 | 2,000.00 |

What each customer's account stands at in the books is exactly what their unpaid invoices come
to. The tests check this after every scenario.

## Judgements, and why

1. **A cheque counts as payment when it is received, post-dated or not.** This is the founder's
   decision. The independent reviewer's caution is fair and is recorded here: a cheque dated
   next month cannot be presented yet, so from the day it is received the customer shows as
   owing less than they really do, in the ageing and against the credit limit. The cheques
   register shows every cheque still to clear, with its date, so the figure is not hidden. If
   this bites in practice, the change is to count a post-dated cheque only from its own date.
2. **An advance backed only by a cheque that has not cleared can be set against invoices.** If
   the cheque then bounces, everything it paid, the advance included, is taken back in the same
   act.
3. **Cancelling a real receipt leaves the money unrecorded until it is entered again.** In event
   1 the 1,950 is still in the bank account while the books show nothing. The person who
   cancels a receipt because it was the wrong customer's enters it again for the right one.
4. **A cancellation or a bounce is dated when it happens, not back-dated to the receipt.** A
   mistake found after a month has been closed stays in that month's figures and is put right in
   the month it is found.
5. **A bank's fee for returning a cheque is not recorded by the bounce.** It is a bank charge of
   its own, entered with bank and cash expenses (Step 34).

## Questions this raised

None about tax. Customers that withhold income tax when they pay (which would put part of a
receipt into Advance income tax) are not handled; noted in `docs/later/step-32.md`.

# Step 38 worked example: commission earned, released, taken back and paid

Checked by Claude, not by an accountant (the founder has none; decided 2026-11-13). The expected
entries and figures were worked out from the founder's decisions and standard double-entry
practice, worked out a second time by an independent reviewer who was given only the events below
and the company's policies, not the first answer or the software, and both were compared with what
the software does. All three agree on every entry, every payment and every closing balance. The
tests in `src/modules/commission-ledger/ledger.test.ts` enter each of these events (among others)
and fail if the software ever does anything else.

## The company

Karachi Lamp House is not registered for sales tax, so no figure here carries tax. A lamp sells
for 100. Stock and the cost of what is sold are left out; Steps 20 and 21's examples cover them.

How it pays commission (the founder's decisions of 2026-11-14 and 2026-11-15, and the choices
made for him in `docs/later/step-38.md`):

- Commission is **earned** when an invoice is posted, on the value of the sale after discount
  and before tax: debit Sales commission, credit Commission payable, on the invoice's date.
- It is **released**, that is, it may be paid, only as the customer's money comes in, in the
  proportion of the invoice that has been collected. Cash and bank money count at once; a cheque
  only when it **clears**. Releasing is not an entry: the amount is already owed in the books.
- A cheque that **bounces** after clearing takes its release back. Goods that are **returned**
  bring what is earned down in their proportion (debit Commission payable, credit Sales
  commission, on the credit note's date); what is released is then what is earned, in the
  proportion of what is left of the invoice that has been collected.
- The owner or an accountant **approves** what is released and unpaid, and it is **paid** from
  cash or a bank account: debit Commission payable, credit the account.
- Commission that was paid on a sale that is later undone is **owed back**: it comes out of the
  person's next commission payment, and what is left is carried to the one after.

The plans: Hamza and Sara earn 2% of their sales. Mina earns 2%, and the sales manager she
reports to earns 1% of what she sells. Tara earns 2%, doubled from the sale that takes her
month's sales to 15,000 or more. Una earns 10 for every lamp.

## 1. Earned on the invoice; released as the money comes in

| Date | What happened | Entry | Hamza's commission on invoice A: earned / released / paid |
| --- | --- | --- | --- |
| 1 Oct | Invoice A, Hamza's sale, 100 lamps: 10,000 | Dr Sales commission 200, Cr Commission payable 200 | 200 / 0 / 0 |
| 2 Oct | 5,000 in cash | none | 200 / 100 / 0 |
| 3 Oct | A cheque for the other 5,000 is received | none | 200 / 100 / 0 |
| 4 Oct | It is deposited | none | 200 / 100 / 0 |
| 5 Oct | It clears | none | 200 / 200 / 0 |
| 6 Oct | The bank returns it | none | 200 / 100 / 0 |
| 7 Oct | 5,000 in cash instead | none | 200 / 200 / 0 |

## 2. A sale shared between two people, and a manager's share

9 October, invoice B, 10,000, shared 60% Hamza and 40% Sara: Hamza earns 2% of 6,000 = 120, Sara
2% of 4,000 = 80. One entry: Dr Sales commission 200, Cr Commission payable 200.

10 October, invoice C, Mina's sale, 10,000: Mina earns 200 and the sales manager 100. One
entry: Dr Sales commission 300, Cr Commission payable 300. Paid in full on the 11th: both are
released, 200 and 100.

## 3. Goods come back

12 October: 50 of invoice C's 100 lamps come back. Half of each commission is no longer earned:

| Account | Debit | Credit |
| --- | ---: | ---: |
| 2320 Commission payable | 150.00 | |
| 5220 Sales commission | | 150.00 |

Mina: 100 earned; the invoice now comes to 5,000 and 10,000 was collected, so all 100 is
released. The sales manager: 50 earned, 50 released.

13 October, invoice D, Sara's sale, 10,000; 4,000 is paid on the 14th (80 of her 200 released);
on the 15th 50 lamps come back. Dr Commission payable 100, Cr Sales commission 100. She has 100
earned; the invoice now comes to 5,000, of which 4,000 has been collected: 100 x 4,000 / 5,000
= 80 released.

## 4. Paid, then the cheque bounces: owed back, and taken from the next payment

| Date | What happened | Entry | Tara, invoice E | Tara, invoice F |
| --- | --- | --- | --- | --- |
| 18 Oct | Invoice E, Tara's first sale of the month, 10,000, paid by cheque | Dr Sales commission 200, Cr Commission payable 200 | 200 / 0 / 0 | |
| 19 Oct | The cheque clears; approved | none | 200 / 200 / 0 | |
| 20 Oct | Paid | Dr Commission payable 200, Cr Cash 200 | 200 / 200 / 200 | |
| 21 Oct | The cheque bounces | none | 200 / 0 / 200: she owes 200 back | |
| 22 Oct | Invoice F, 10,000, paid in cash: her month reaches 20,000, so 2% is doubled | Dr Sales commission 400, Cr Commission payable 400 | | 400 / 400 / 0 |
| 23 Oct | Approved and paid: 400 less the 200 she owes | Dr Commission payable 200, Cr Cash 200 | 200 / 0 / 0 | 400 / 400 / 400 |
| 24 Oct | The customer pays invoice E in cash | none | 200 / 200 / 0, to approve and pay again | |

A bounced cheque does not undo the sale: invoice E still counts towards her month, which is why
invoice F is doubled.

## 5. Paid, then goods come back: more owed back than the next commission

| Date | What happened | Entry | Paid to Una | She owes back |
| --- | --- | --- | ---: | ---: |
| 25 Oct | Invoice G, 100 lamps, paid in cash, approved and paid | Dr Sales commission 1,000, Cr Commission payable 1,000; then Dr Commission payable 1,000, Cr Cash 1,000 | 1,000 | 0 |
| 26 Oct | 50 lamps come back | Dr Commission payable 500, Cr Sales commission 500 | | 500 |
| 27 Oct | Invoice H, 30 lamps, paid, approved; her commission is paid: 300 approved, 300 taken back | Dr Sales commission 300, Cr Commission payable 300; no money leaves | 0 | 200 |
| 28 Oct | Invoice I, 40 lamps, paid, approved; paid: 400 approved, 200 taken back | Dr Sales commission 400, Cr Commission payable 400; then Dr Commission payable 200, Cr Cash 200 | 200 | 0 |

## Where it stands

| Person | Earned | Released | Paid | Released, still to pay | Earned, waiting for customers | Owed back |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Hamza | 320 | 200 | 0 | 200 | 120 | 0 |
| Sara | 180 | 80 | 0 | 80 | 100 | 0 |
| Mina | 100 | 100 | 0 | 100 | 0 | 0 |
| The sales manager | 50 | 50 | 0 | 50 | 0 | 0 |
| Tara | 600 | 600 | 400 | 200 | 0 | 0 |
| Una | 1,200 | 1,200 | 1,200 | 0 | 0 | 0 |
| | 2,450 | 2,230 | 1,600 | 630 | 220 | 0 |

| Account | Balance |
| --- | ---: |
| 5220 Sales commission | 2,450.00 debit: what is earned |
| 2320 Commission payable | 850.00 credit: what is earned and not yet paid (630 + 220) |
| Cash paid out in commission | 1,600.00 |

The tests check after every scenario that Sales commission is exactly what is earned, that
Commission payable is exactly what is earned less what is paid, and that every accrual is the
sum of its movements.

## Judgements, and why

1. **What a person owes back sits in Commission payable**, as a debit against their name,
   until it comes out of a later payment. The independent reviewer would rather see it in an
   asset account of its own ("Commission recoverable from staff"): after 26 October, Una's 500
   is money owed *to* the company, shown inside what the company owes its sales team, and one
   person's debit is not something to set against another's credit. It is right about the
   presentation. It stays here for now because the amount is always visible by person on the
   Commission earned page ("Owed back"), and the account's total is still what the company
   owes in all. A balance sheet prepared for outsiders should show the owed-back total apart.
2. **A payment that is all taken back posts nothing** (27 October): no money moved, and both
   sides are within Commission payable.
3. **Commission is an expense when the sale is made**, not when it is paid, so that it falls
   in the same month as the sale it was earned on.
4. **A return in a later month does not undo a doubled rate** that another sale earned in the
   month the goods were sold; the return comes off the month it happens in. The reviewer notes
   that this can be played (sell to reach the target, take the goods back next month). It
   lowers the next month's sales instead, and the returned sale's own commission is taken back
   at the rate it earned.
5. **A cheque that bounces leaves the sale in the month's sales** (invoice E above).

## Questions this raised (for a tax adviser or for later steps; not decided here)

From the independent reviewer's knowledge of the law, which it could not check against the text.

- **Income tax on commission paid to an employee.** Commission is understood to be part of
  salary (Income Tax Ordinance 2001, sections 12 and 149), to be taxed with it at the employee's
  rate, not at a flat rate. Nothing is withheld by a commission payment here; payroll (Steps 40
  to 42) is where it belongs. Commission paid to someone who is not an employee (an agent) is
  understood to fall under section 233 instead.
- **Paying in cash.** Salary above a monthly limit paid other than through a bank is understood
  not to count as an expense for income tax (section 21). The software pays from cash or bank
  as chosen and does not warn.
- **Taking money back from pay.** The law on deductions from wages is understood to allow an
  overpayment to be adjusted; the reviewer was not sure it covers every kind of employee. The
  rule should be written into the commission plan the salespeople agree to.
- **A customer who never pays.** Commission that was earned and never released stays in
  Commission payable. There is no writing-off of a customer's debt in the product yet; when
  there is, it should take the unreleased commission back.

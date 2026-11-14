# Step 38: commission earned, released, taken back and paid

Built in track C (commissions) by the Builder, on Step 37's plans (the Finisher's). Migration
`0027_commission_ledger`.

## Decided by the founder (2026-11-15, through the coordinator, before he went to sleep)

- **Commission on a cheque is released when the cheque clears.** Cash and bank money release
  at once. So a cheque that bounces before it has cleared has nothing to take back.
- **A return comes off the salesperson's sales for the month**, and its commission is
  reversed.
- **The owner and the accountant approve commission for payment.**
- **Commission already paid on a sale that is later undone** (goods returned, or a cheque that
  bounces after it cleared) **is carried forward and taken from later commission.**
- **Who reads it**: each salesperson their own; a manager also their team's, at any depth
  below them in the sales hierarchy (whoever has people under them there, whatever their
  role); the owner and the accountant everyone's, and the auditor too.

## What was built

- **Earned when the invoice is posted.** Every salesperson with a share of a line earns what
  their plan gives on that share (Step 37 works it out), and every manager above them earns
  their own plan's team rate on it. One accrual each. One journal for the invoice: debit Sales
  commission, credit Commission payable. No plan on the day, or nobody credited with the sale:
  nothing is earned and nothing is posted.
- **Released as the customer pays**, in the proportion of the invoice that has been collected.
  No journal: the amount is already owed in the books; releasing says it may now be paid.
- **Taken back.** A cheque that bounces after clearing, or a receipt that is cancelled, takes
  its release back. Goods that come back bring what is earned down in their proportion, with a
  journal the other way (debit Commission payable, credit Sales commission), and what is
  released follows.
- **Approved, then paid.** The owner or an accountant approves what is released and unpaid
  (any later change to it clears the approval), and pays a person everything approved from a
  cash or bank account: debit Commission payable, credit the account. What the person owes
  back comes out of the payment first; what is left of it is carried to the next.
- **Movements that are never changed.** Every one of these is a row that is written once. An
  accrual's figures are always exactly the sum of its movements; the database refuses anything
  else when the transaction ends.
- **Screens.** "Commission earned" (`/commissions/earned`): each person's totals, the invoices
  behind them, approve and pay, and the payments made. The owner, an accountant and the auditor
  see everyone (the accountant's way in is Reports, "Commission earned"); a salesperson's "My
  commission" shows their own.

**The acceptance test**, "Port the old workflow tests; every movement sums to the accrual": the
old prototype's workflow cases are ported by hand in `src/modules/commission-ledger/ledger.test.ts`
(COM-016 to COM-024, COM-029 to COM-032, COM-035 to COM-039, COM-064 to COM-069, COM-073, COM-075,
COM-077, COM-078, COM-091, COM-099, COM-100, COL-100). Changed on purpose, each by the founder's
decision or because the old prototype paid commission through payroll, which does not exist yet:

- what is owed back comes out of the person's **later commission**, not their salary (COM-021,
  COM-037, COM-100: the "next payroll run" is the next commission payment);
- the **sales manager cannot approve** (COM-025, COM-097): the owner and an accountant do;
- a **return comes off the month's sales** (the old prototype left the month's total alone);
- a **second sale after 600,000 in a month** follows Step 37's slabs on the month, not the line.

## Decided for Fazal, to confirm

These came up while building. Each is the option I would recommend; say if any should change.

1. **A return comes off the month it happens in**, not the month of the original sale. Goods
   sold in October and returned in November lower November's sales for the target and the
   slabs. Past months' figures never change after the fact, and selling to reach a target and
   taking the goods back the next month does not pay.
2. **What a line earned is worked out once, when its invoice is posted, and never again.** A
   later return lowers only the returned line's own commission, in proportion; it does not go
   back and take away a doubled rate that another sale earned at the time.
3. **A cheque that bounces does not take the sale out of the month's sales.** The sale was
   made; only its commission waits for the money.
4. **Commission is paid by a payment of its own**, to one person, in one step, from a cash or
   bank account, numbered CP-2627-00001. Payroll does not exist yet; when it does (Step 41)
   it can pay commission with the salary instead.
5. **The owner and an accountant can each approve and pay** (either one; not both in turn).
   Paying is for someone who works across the whole company: a person's commission comes from
   every branch.
6. **A payment pays everything approved for the person**, not a chosen part of it.
7. **What a person owes back is taken from their next payment in full**, as far as that
   payment goes; there is no limit such as "at most half of each payment".
8. **Credit from a return, set against another invoice, counts as that invoice being paid.**
   The money came in earlier, for the goods that have since come back.
9. **A manager's share follows the seller's line**: earned, released, taken back and owed back
   on the same events.
10. **A manager's team is the hierarchy as it stands today.** Someone moved under a new
    manager is read by the new manager from then on, past commission included.
11. **Commission is earned whether or not the Commissions module is switched on** (as in the
    old prototype), as long as a plan applies: switching the module off hides the screens, it
    does not stop people earning.
12. **Nothing is withheld from a commission payment.** Income tax on commission paid to an
    employee belongs with payroll (Step 41); a payment here is the gross amount.
13. **What a person owes back stays inside Commission payable**, against their name, until it
    comes out of a later payment; it is not moved to an account of its own. The Commission
    earned page shows it by person. (The independent accounting check would rather see an
    asset account for it; see the first judgement in `docs/examples/step-38.md`.)

## For the other steps

**Step 39 (statements, approval screen, manager override), the Finisher's.**

- Tables, all read-only to the app's role: `commission_accruals` (one row for each earner on
  each seller's share of an invoice line: `user_id` earns, `kind` own or team, `level`,
  `seller_user_id`, `plan_id`, `base`, `accrued` as first worked out, and where it stands:
  `earned`, `released`, `paid`, `approved_at`), `commission_movements` (`type` accrued,
  entitlement_adjusted (negative), released, release_reversed, paid, recovery_recorded;
  `amount`; `movement_date`; `source_type` and `source_id`: sales_invoice, receipt,
  credit_note or commission_payment; `seq` is the order they were written in) and
  `commission_payments` (`number`, `user_id`, `payment_date`, `gross`, `recovered`, `amount`).
- "Statement equals movements for the period": a person's statement for a period is their
  movements with `movement_date` in it. `earned = sum(accrued + entitlement_adjusted)`,
  `released = sum(released) - sum(release_reversed)`, `paid = sum(paid) - sum(recovery_recorded)`,
  always, for every accrual.
- Row-level security already gives everyone their own rows, a manager also the rows of
  everyone below them in `sales_hierarchy` (`app.commission_team()` is the signed-in member
  and everyone below, as it stands now), and the owner, an accountant and the auditor
  everyone's.
- To approve: `select app.approve_commission(array[...accrual ids])`. To pay:
  `select * from app.pay_commission(user, date, account, note)`. In the app:
  `approveCommission` and `payCommission` in `src/modules/commission-ledger/commands.ts`, and
  the read models in `queries.ts` (`getEarned`, `getInvoiceCommission`, `listMovements`,
  `listPayments`). The page `/commissions/earned` is a working approval screen; Step 39 may
  replace or restyle it.
- A manager's override percentage is the `team_rate` of the manager's plan (Step 37); it is
  kept on each team accrual as `team_rate`.

**Payroll (Steps 40 to 42).** Commission can be paid with the salary by calling
`app.pay_commission` from the payroll run, or by a function beside it that pays into Salaries
payable instead of cash. Income tax on commission is not withheld here.

**Step 34 (bank and cash).** A commission payment credits a cash or bank account; its journal
has source type `commission_payment` and carries the CP number.

## Later

- Taking a commission payment back (one made to the wrong person or from the wrong account).
- Paying part of what is approved, or several people in one run.
- A limit on how much of a payment can go to what is owed back.
- A person who has left and still owes commission back: it stays on their account; there is
  no way yet to write it off or to collect it another way.
- An account of its own for commission owed back by staff, and its ageing.
- Taking unreleased commission back when a customer's debt is written off (nothing writes a
  debt off yet).
- A warning when commission is paid in cash above the limit the income tax law is understood
  to set for salary paid outside a bank; withholding income tax (with payroll).
- A statement for each person (Step 39).

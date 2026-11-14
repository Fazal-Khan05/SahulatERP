# Step 39: commission statements, the approval screen, manager override percentage

Track C (commissions), the Finisher's. Built on Step 38's ledger (the Builder's, migration
`0027_commission_ledger`) and Step 23's print parts. Migration `0028_commission_statements`
(hand-written: three read functions, no tables).

Prepared while Step 38 was still on its branch: the rules and their tests, the screens, the
print page, the PDF, the read functions (drafted in `docs/later/step-39.draft.sql`) and the
database tests (`src/modules/commission-statements/statements.test.ts`). The database tests pass
against Step 38's migration as it stood on the Builder's branch (commit 483f859), on a local
database of their own.

**When Step 38 is on main:** turn the draft into `drizzle/0028_commission_statements.sql` (with
`drizzle-kit generate --custom`) and its down file, and delete the draft; pay through Step 38's
`approveCommission` and `payCommission` in the tests; link the statements from Commission earned
and from Reports; write the browser test; run everything.

## Decided by the founder (2026-11-15, through the coordinator)

- **Each salesperson sees their own statement, a manager also sees their team's, and the owner
  and the accountant see everyone's.**
- **The owner and the accountant approve commission for payment** (Step 38 built it).

## What the statement is

One person, one period (this month so far unless another is chosen; "Last month" is a click).

- **Brought forward**: what was owed to the person when the period began (released less paid).
- **One line for each event** in the period, oldest first, with the invoice's number (the
  payment's for a payment), the customer, and for a manager's share the team member who sold:
  - earned on the sale (a manager's: "earned at the 0.5% team rate", the manager override
    percentage from the manager's plan, Step 37);
  - goods returned (the credit note's number);
  - released: the customer paid (the receipt's number), or a credit note was set against the
    invoice;
  - release taken back: the customer's payment was undone (a cheque returned or a receipt
    cancelled), or goods returned;
  - commission paid (the CP number), "less what was owed back" when the payment took some back.

  An invoice of several lines is one line; each event on one invoice is its own line.
- **Columns**: Earned, Released, Paid, and **Owed** after each line.
- **For the period**: each column added up.
- **On the last day**: earned in all, waiting for customers to pay, released, paid, and owed to
  be paid (or owed back, from the next payment).

**The acceptance test, "Statement equals movements for the period"**: the statement is built
from nothing but the movements (Step 38's `commission_movements`, never changed): what they came
to before the period, and each one in it. The rules' tests check that the lines add up to the
movements and the end to the beginning plus the period; the database tests (to build) check it
against Step 38's accruals and the Commission payable account.

## Where it is

- `/commissions/statements`: the people the reader may see, each with the period in short;
  a salesperson with no team goes straight to their own.
- `/commissions/statements/[person]`: the statement, with Print, Download PDF and, for the owner
  and an accountant, Approve and pay (Step 38's screen for that person).
- `/print/commission-statement/[person]` and its `/pdf`: on the letterhead (Step 23's
  `PrintHeader`, and react-pdf as the customer statement does).

**The approval screen** is Step 38's `/commissions/earned` (tick what is released, approve,
pay); Step 39 links each statement to it. **The manager override percentage** is the team rate
on the manager's plan (Step 37) and shows on every team line of the statement.

## Decided for Fazal, to confirm

These came up while building. Each is the option I would recommend; say if any should change.

1. **"A manager's team" is everyone below them in the sales hierarchy, at any depth, as it
   stands today.** Move Ali to another manager and his old manager no longer sees his
   statements, past months included; the new manager sees all of them.
2. **A statement covers every branch.** A manager who works in one branch still sees the whole
   of a team member's statement. An accountant or auditor who works in some branches only sees
   their own and their team's (as for paying commission, Step 38).
3. **The Commission earned page is unchanged**: there a manager still sees only their own (Step
   38's decision 10). Only statements open the team.
4. **The statement names the receipt and the credit note behind each line** even to a
   salesperson, who cannot otherwise read receipts: it is their own commission, and they need
   to see what released it.
5. **A period is any two dates**, this month so far by default; statements are not "closed" or
   numbered. The PDF says when it was printed.
6. **A balance below nothing** (commission paid and since taken back) is shown with a minus sign
   and "Owed back, from the next payment".

## Tests

- `src/modules/commission-statements/rules.test.ts`: the statement from movements, on its own.
- `src/modules/commission-statements/statements.test.ts`, against the database: a month with a
  cheque that clears and then bounces after Ali was paid, a return, a payment that takes back
  what he owed; the statement is exactly the movements dated in the period, its end is where
  the accruals stand, October's end is November's beginning, everyone's statements add up to
  Sales commission and Commission payable in the books; and who reads whose (a salesperson, a
  manager at any depth and after a move, the owner, an accountant, the auditor, an accountant
  of one branch, another company's owner).
- To write: `e2e/commission-statements.spec.ts`: the owner opens the list, a salesperson's
  statement, prints it and downloads the PDF; the salesperson is sent straight to their own and
  cannot open another's (not found); a manager sees their team in the list.

## Later

- Emailing a statement to the person (when email is set up, Step 23's sender).
- Statements for everyone at once (one PDF of the whole team for a month).

# Step 36: the cash-flow statement and the owner's figures

A joint step (docs/PARALLEL.md), built by the Finisher on 2026-11-18 at the coordinator's word. No
migration: it reads posted journals. It touches only the shared reports (`src/modules/reports`,
`src/app/(app)/reports/_parts/load.ts`) and the Home page, none of them a track's own.

## What is built

- **Cash flow** (Reports, `/reports/cash-flow`), for a period and a branch, printed and
  downloaded like the other reports: money received from customers, paid to suppliers, paid to
  staff, taxes, other operating money; fixed assets bought and sold; loans, and owners' capital and
  drawings; opening balances entered; money moved between branches; the net change, and what cash
  and bank held at the start and end. **The net change is what the cash and bank accounts moved**,
  by the way it is made, and the statement says so under it (the step's acceptance).
- **The owner's figures** on Home, for a period (this month so far unless asked) and a branch:
  cash and bank at the end and how much that moved, sales, profit or loss, what customers owe and
  what is owed to suppliers. Each opens the report it comes from, for the same period.

## How the statement is made

The direct method: every journal that moved money in or out of a cash or bank account in the
period is read, and the money it moved (in the branch asked for) is put down to the other accounts
of the same journal, on the same side: money in to what was credited, money out to what was
debited. So an expense paid less tax withheld is all of it money out on the expense (the tax is
money out when it is paid to the government), and a cash sale's sales tax is money from the
customer. Several kinds in one journal share the money in proportion, to the books' four places,
the shares adding up exactly. Which kind an account is: by what it is for when it is a locked
account (receivables, advances from customers and cheques in hand are customers'; payables, goods
received not invoiced, advances to suppliers and stock are suppliers'; salaries and commission
are staff's; the tax and EOBI accounts are taxes); otherwise fixed assets under heading 1500,
loans under 2500, the owners' under Equity, and anything else other operating money.

The worked example is `docs/examples/step-36.md`, agreed by a blind second working. **Checked by
Claude, not an accountant.**

## Decided for Fazal, to confirm

1. **The figures on Home are the owner's only.** The accountant and the auditor read the same in
   the reports; their Home stays as it was.
2. **This month so far** is the period the figures open on.
3. **The direct method**, as above, rather than the indirect method (profit adjusted for what did
   not move cash). The indirect one can be added beside it if your accountant wants it.
4. **Stock bought is money paid to suppliers** (operating), and **a loan's interest** is other
   operating money unless it is kept in its own account under Long-term liabilities.

## Tests

- `src/modules/reports/cash-flow.test.ts`: where each kind of money goes; the acceptance on a
  dozen journals; one branch's money moved to another, and a journal split across branches;
  sharing out to the paisa and beyond; a statement that does not agree saying so; the owner's
  figures.
- `src/modules/reports/cash-flow-books.test.ts`, against the database: the acceptance against
  the trial balance; one branch, and a member who works in it; a later period starting where this
  one ended; the owner's figures for the company and a branch; who may read them.
- `e2e/dashboard.spec.ts`, in the browser: the owner's figures, another period, opening the cash
  flow from them; an accountant's Home without them and the cash flow among their reports.

## Later

- The indirect method beside the direct one (decision 3).
- More on the owner's Home as the modules it reads arrive: approvals waiting, cheques due, stock
  value (PLAN line 87).

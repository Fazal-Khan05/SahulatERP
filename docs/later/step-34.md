# Step 34: cash and bank accounts, transfers, expenses, petty cash

Track C, built by the Finisher while the founder was away (2026-11-17); nothing here was asked of
him. Migration `0032_cash_bank` (five tables, the functions that record and cancel, a guard on
archiving), renumbered at merge. Not applied to the shared database: his yes does not cover it.

## What is built

- **Cash and bank** (`/cash-bank`, the menu entry the owner, accountant and auditor already had):
  every cash and bank account with what it holds (everything ever posted to it), a bank
  account's bank and account number or IBAN, adding an account, and archiving one.
- **Transfers** (`/cash-bank/transfers`, TR-2627-00001): money moved between two of them, such as
  cash banked, cash drawn or petty cash topped up; cancelled by a reversal.
- **Expenses** (`/cash-bank/expenses`, EX-2627-00001): money spent out of one of them on up to 50
  lines, paid to a supplier on the list or to someone named; the province's tax on services and
  income tax withheld as Step 25 withholds them; cancelled by a reversal.
- An account is **archived only when it holds nothing**, whatever the dates of what was posted to
  it, and when no cheque deposited in it is waiting to clear (a guard of track C's own on the
  chart, SE340).

## Decided for Fazal, to confirm

1. **Petty cash is one more cash account**, topped up by a transfer, rather than a float with its
   own rules (an imprest kept at a fixed sum).
2. **The owner and an accountant keep cash and bank; the auditor reads it.** An accountant limited
   to some branches records expenses for those branches only and moves no money between the
   company's accounts (the accounts belong to the whole company).
3. **Tax is withheld from an expense as from a supplier's bill (Step 25):** only by a company that
   withholds, only from a supplier on the list (so its Active Taxpayers List status and type are
   known), the province's tax added to the cost and withheld whole, income tax at the rate for the
   supplier's list status as recorded on the day. A payee named in words has nothing withheld.
4. **An expense line is charged to an expense or asset account** that no control owns, or to Bank
   charges. Sales tax a registered supplier charges on an expense goes into its cost here; to claim
   it as input tax, the expense is entered as a supplier bill instead (Step 25).
5. **A cash or bank account may go below nil** (an overdraft, or a cash book written in the wrong
   order); the screens show it as it is, with no warning. A warning on cash going below nil is
   easy to add.
6. **A transfer or an expense entered by mistake is cancelled**, on a day chosen, by posting it
   again the other way round; it is never changed. The tax withheld goes back with it.
7. **Transfers take their own number, TR-.** Expenses use the EX- series the product already had.
8. **Refunds are not in this step.** Earlier notes left three to "Step 34": refunding a customer's
   advance (Step 32), a credit note's credit (Step 21) and a walk-in buyer's return (Step 22). The
   plan's line for this step does not name them, and each is a payment out against a customer's
   balance, which belongs with the receipts. They are listed below for a step of their own.

## For other steps

- **Step 29 (the withholding register, track B):** tax withheld from expenses is kept in
  `expense_withholdings` (same columns as Step 25's `withholding_entries`, with `expense_id` for
  `bill_id`), so the register and its total against the withholding payable accounts read both
  tables. A cancelled expense keeps its rows; its reversal takes the amounts back out of the
  payable accounts.
- **Islamabad** has no line in the provincial sales tax table (the Islamabad Capital Territory
  taxes services under its own ordinance), so an expense there withholds none until a company
  adds the line under Settings, Tax.

## Tests

- `src/modules/cash-bank/rules.test.ts`: what an expense comes to (the acceptance; a supplier on
  the list; the last line's share; no tax), and what is typed.
- `src/modules/cash-bank/cash-bank.test.ts`, against the database: accounts and bank details;
  transfers and cancelling one; the acceptance and its journal; a payee named in words, petty cash
  and bank charges; plain refusals; cancelling an expense and the withholding going back; archiving
  only at nil; who keeps, reads and sees; the withholding lines offered.
- `e2e/cash-bank.spec.ts`, in the browser: a bank account and petty cash added, a transfer, the
  acceptance entered on screen, the auditor reading, a salesperson with no way in.

## Later

- **Refunds:** a customer's advance, a credit note's credit, and a walk-in buyer's return paid back
  in cash or from the bank (see decision 8).
- **Bank reconciliation** is Step 35 (the founder dropped statement import from the design
  partner's scope on 2026-10-13; confirm before building it).
- **Paying suppliers** from the bank, with cheques written, is Step 26's.
- **A short slip** for an expense or a transfer, printed or as a PDF.

# Step 42: the salary bank file, the year's statement, loans to staff and final settlement

Track C (payroll), built by the Finisher while the founder was away (2026-11-18). Migration
`0042_payroll_extras` (three tables, a guard, two functions, one locked account, two kinds of
number, and the run's approval taught to recover loans). Built on Step 41, renumbered at merge;
the coordinator applies it to the shared database once merged.

## What is built

- **A person's bank account** (on their page, kept by the owner or the payroll administrator):
  the bank's name, the account's title and its IBAN. The IBAN is checked as Pakistan's are made
  (PK, two check digits, the bank's four letters, sixteen digits) and by its check digits, so a
  digit typed wrong is refused. The audit log keeps the IBAN's last four characters only.
- **Loans and advances** (`/payroll/loans`, a tab of Payroll, and under Reports): the owner or an
  accountant lends someone on the payroll an amount, out of a cash or bank account, with the
  instalment to be taken from each month's pay. It is numbered `SL-2627-00001` and put in the
  books:

  | | Account | Amount |
  | --- | --- | --- |
  | Dr | 1240 Loans and advances to staff (new, locked) | the loan |
  | Cr | the cash or bank account | the loan |

- **Instalments from pay**: when a month is worked out, each loan still owed, oldest first, gives
  a payslip line "Loan SL-…" of its instalment, or what is still owed if less, as far as the pay
  left after tax and fixed deductions goes. Approval credits the loans back:

  | | Account | Amount |
  | --- | --- | --- |
  | Dr | 5210 Salaries and wages | the whole pay (the loan is not taken off the cost) |
  | Cr | 1240 Loans and advances to staff | the instalments |
  | Cr | 2300 Salaries payable | what the people take home, less the instalments |

  If a loan has been repaid meanwhile so that an instalment is more than is owed, approval is
  refused and the month is worked out again.
- **Final settlement**: in the month a person leaves, their pay takes everything they still owe
  on loans, as far as it goes. Their page then shows "Final settlement" with what is still owed,
  and the owner or an accountant takes the rest **repaid in cash** into a cash or bank account,
  numbered `LR-2627-00001` (Dr the account, Cr 1240). A repayment can be taken from anyone at any
  time, not only a leaver.
- **The salary bank file** (on an approved or paid run, for the owner, the payroll administrator
  or an accountant across the whole company): a CSV with one line for each person with pay to take
  home, to the IBAN on their page. If anyone paid has no bank account on record, the run's page
  names them instead and links to their page. The file is checked before it is given, and is not
  given while anything fails, each problem named by person: each IBAN is valid, no IBAN is paid
  twice, names are capitals and spaces of at most 35, amounts are to the paisa without commas,
  references are 1 to 30 characters. When anyone's bank details were changed after the run was
  approved, the card lists them, when, and (for the owner) by whom, to check before uploading.
- **The year's salary statement** (`/payroll/annual`, "Year's statement"): each person's pay and
  commission, taxable salary and income tax deducted over a tax year (1 July to 30 June), from the
  approved and paid runs, with the CNIC, downloadable as CSV. This is what s.149 asks an employer
  to give each employee and what the annual statement of deductions is filled in from.

## Decided for Fazal, to confirm

1. **The bank file's layout is assumed, not a bank's own.** The plan's acceptance is "validates
   against the bank's sample", and no bank's sample was to hand. The file is the simple layout
   most Pakistani banks' bulk-payment uploads accept: `Sr No, Beneficiary IBAN, Beneficiary Name,
   Amount, Payment Reference`, with the name in capitals, at most 35 characters, and the reference
   `SALARY NOV 2026 E-001`. It validates against its own checks (listed above), not against a
   bank's. **Send me your bank's sample file or its upload guide** and I will make the file match
   it exactly, as a second layout beside this one.
2. **Loans are made and repaid by the owner or an accountant**, who keep the books; the payroll
   administrator reads them and sees the instalments on the payslips, but does not lend.
3. **A loan has no interest and no end date**: it is recovered by its instalment until nothing is
   owed. Two loans to one person are recovered oldest first.
4. **The instalment is taken only as far as the pay goes**, after tax and fixed deductions. A
   month with too little pay takes less, and the loan simply runs a month longer; the payslip
   never goes below nil.
5. **Final settlement is loans only.** Leave encashment, gratuity, notice pay and the like are not
   in this step: the last month's pay is worked out as in Step 41 (to the day they left), and
   whatever the company owes beyond that is paid as an expense (Step 34) until a later step adds
   it.
6. **The bank file is for the whole company only**: a member kept to some branches would get a
   file paying only their branches' people, so they are not given one.
7. **The year's statement is a CSV**, not the FBR's own annexure layout; the figures are the ones
   that annexure asks for, per person.
8. **The year's statement holds only what this company's payroll paid**: the months of the tax
   year before payroll was first run here, which the tax works out as paid at the regular pay
   (Step 41), are not in it. For the first year, those months come from the old system's records.

## Review

An independent review (2026-11-18) found the approval's journal balancing in every case, no path
by which a loan is recovered beyond its amount, the locks in one order, the access rules and the
function rules right, and the rewritten approval keeping all of Step 41's. These it found, all
fixed:

- **A loan could be repaid in cash only once**: the second repayment's journal stood on the loan,
  as the first did, and the ledger takes one journal for each source. Each repayment is now its own
  movement and its journal stands on that.
- **The bank file was not checked before it was given**, so an IBAN typed on two people's pages, or
  an account title with no letters a bank takes, reached the bank. It is checked, and refused with
  each problem named.
- **An IBAN changed after approval went unseen**: the payroll administrator keeps bank details and
  the accountant uploads the file. The bank-file card now lists every person whose details changed
  after approval (and the change's time is kept: it was not, before).
- The repayment form no longer fills in the whole balance (one click would have recorded money
  never received).
- A loan's take is to the paisa, rounded down (what is left of pay can carry part of a paisa from
  commission, which would have left a loan that could never be closed).
- Approval refuses a loan on two lines, on two people's payslips, or not as a deduction.
- The run's totals show loan instalments apart from fixed deductions; a run out of date because a
  loan was repaid says so; two saves of one person's bank details at once are told to reload.

Not changed, for Fazal:

- **A loan or a repayment entered wrongly cannot be cancelled in this step.** A loan with nothing
  recovered yet should be cancellable with a reversal, and a repayment reversed; until then a
  mistake is put right with a repayment (a loan entered too large) or a new loan (a repayment
  entered wrongly). A manual journal to 1240 moves the account but not the loan register:
  keeping manual journals off 1240 is a change to the shared list of protected accounts.
- **An IBAN's account part is sixteen digits.** The IBAN registry allows letters there; no
  Pakistani bank is known to use them. A real one with a letter would be refused.
- The payment reference is cut at 30 characters, so two people whose codes share their first
  fourteen characters get the same reference.

## Questions for a tax adviser

- s.13(7): a loan to an employee above a threshold (believed Rs 10,00,000) at less than the
  benchmark rate is a taxable benefit. Loans here have no interest; such a benefit is not added to
  taxable salary.
- The Payment of Wages Acts limit deductions from wages. Final settlement takes all that is owed
  from the last month's pay, as far as it goes: is that within the limit for a leaver?

## Tests

- `src/modules/staff-loans/rules.test.ts`: IBANs (shape, check digits, tidying); the bank file
  written in the bank's characters and passing its own checks; every refusal the checks make;
  reading a loan; the year's statement with its totals, a code never read as a formula.
- `src/modules/staff-loans/loans.test.ts`, against the database: a loan paid out of cash into
  1240, and who may make one (an accountant kept to one branch may not); instalments taken from pay and credited to the loans, not off the
  salaries' cost; final settlement, a leaver's last pay taking all that is owed and the rest
  repaid in cash, no more than is owed; approval refused when a repayment made the instalment too
  much; **the acceptance**: the bank file validating once everyone paid has an IBAN, and the audit
  log keeping the IBAN's last four only, an IBAN on two pages refused, and details changed after
  approval listed; the year's statement; a loan repaid in two parts; and, in two sessions, a cash
  repayment waiting for an approval taking the same loan, then refused. Its figures are the worked
  example's, `docs/examples/step-42.md`, agreed by a blind second working. **Checked by Claude,
  not an accountant.**
- `src/modules/payroll-runs/rules.test.ts`: the loan lines on a payslip, oldest first, as far as
  pay goes, all of it in the leaving month.
- `e2e/payroll-extras.spec.ts`, in the browser: the accountant lends two people money (an
  instalment more than the loan refused); the payroll administrator, who cannot lend, records a
  bank account (a wrong IBAN refused) and works the month out with one person having left; the
  accountant approves it, downloads the bank file and takes the rest of the leaver's loan in cash;
  the owner reads and downloads the year's statement.

## Later

- The bank's own layout once its sample is to hand (decision 1); a second and third bank.
- Leave encashment, gratuity and notice pay in final settlement (decision 5).
- The FBR's annexure layout for the annual statement (decision 7), and a printed certificate of
  salary and tax for each employee.
- Interest on loans, a loan's end date, and stopping an instalment for a month.
- Step 41's tax projection runs to June even when a leaving date is already on record, so a
  leaver may have tax deducted in earlier months that the year does not owe (found by the worked
  example's second working). Stopping the projection at a known leaving date is a change to Step
  41's rule, for Fazal to decide.

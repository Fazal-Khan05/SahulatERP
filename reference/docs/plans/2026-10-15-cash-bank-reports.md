# Plan: Cash & bank and reports (backlog T06 part, R01)

Status: **built 15 October 2026** (branch `cash-bank-reports`); QA record in [reports/qa-2026-10-15/CASH_BANK_REPORTS_QA.md](../../reports/qa-2026-10-15/CASH_BANK_REPORTS_QA.md). Follows [2026-10-15-document-cycles.md](2026-10-15-document-cycles.md).

## Why

A small owner-run business lives in two screens: "how much money do I have and where" and "who owes me / whom do I owe, and how old is it". FastAccounts gives them a cash book, bank accounts, aged receivables, statements and ~200 reports with Excel export. SahulatERP has one ledger account for all money, no cheque lifecycle buttons, and a Reports page with four tiles. Bank statement reconciliation stays out of scope (decision of 13 Oct).

## What the user gets

### Cash & bank (new toggleable module)
- **Accounts:** any number of bank and cash accounts (name, type, bank/branch/account details). Each gets its own ledger code (1001, 1002, …) under the Bank & cash control; the old single account 1000 remains as "Legacy / unassigned" until it is empty.
- **Balances** per account from posted journals, with a running list of recent movements per account (receipts, payments, transfers, expenses, payroll).
- **Receipts and payments choose an account.** Cash and bank receipts post to the chosen account; a cheque chooses the account when it is **deposited** and posts there when it **clears**.
- **PDC register:** every cheque in hand with Deposit → Clear → Bounce buttons (the engine already enforces the transitions and reversals). Also shown in Collections rows.
- **Transfers** between accounts (bank to cash, cash to bank, bank to bank) and **petty expenses** (cash or bank paid out to an expense account with a memo), both posted as balanced journals.
- Provisioning when the module is turned on: "Main bank account" and "Cash in hand" if the company has no accounts.

### Reports (replaces the current Reports page)
A report picker with parameters (dates, party, product, account), a table, **Export CSV** and **Print**:
- Aged receivables and aged payables (current, 1–30, 31–60, 61–90, 90+ days by due date), by customer/supplier, as of a date.
- Customer and supplier **statement** for a period: opening balance, every invoice, credit note, receipt/payment in date order with running balance.
- Stock valuation by product and warehouse; stock movement register for a period.
- Sales analysis for a period by customer, product or salesperson (net of returns).
- Profit & loss for a period; balance sheet as at a date (with current-period earnings); trial balance; general ledger for one account with running balance.
- Reconciliation card stays (AR, inventory, commission payable, and now bank control vs. account sub-ledger).
- Role scoping: ledger roles see everything; Sales Manager/Recovery Officer get aged receivables, statements and sales analysis for their scope; Warehouse Manager gets stock reports.

## Engine and data
- `Workspace.bankAccounts: { id, code, name, type: "bank" | "cash", details, archived? }[]`; `Receipt.accountId?`.
- Commands: `save_bank_account`, `bank_transfer`, `record_expense`; `create_receipt` and `update_cheque` (on deposit) accept `accountId`.
- `postJournal` accepts bank-account codes in addition to the fixed chart.
- Pure report functions in `src/modules/erp/reports.ts`, unit-tested against the demo data and the ledger (aged totals equal the receivable control; P&L + balance sheet balance; statements end at the party's outstanding balance).
- No schema change: bank accounts live in the snapshot/company settings JSON; receipts keep `accountId` in their JSON.

## Tests
- Engine: account creation codes, receipt to a specific account, cheque deposit chooses account and clears there, bounce reverses on the same account, transfer and expense journals, archived account refused.
- Reports: aged buckets sum to the AR/AP control; statement running balance ends at outstanding; P&L net equals change in equity on the balance sheet; stock valuation equals inventory control; general ledger running balance equals account balance.
- Browser (`cash-bank-reports.spec.ts`): add a cash account, record a cash receipt to it, deposit and clear a cheque into the bank account, transfer bank→cash, post an expense, see balances move; run aged receivables, a statement and P&L; export a CSV; print view renders.

## Out of scope
Bank statement import/reconciliation, cheque printing, multi-currency bank accounts, budgets.

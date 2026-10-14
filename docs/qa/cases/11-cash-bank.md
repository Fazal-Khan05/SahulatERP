# 11 — Cash and bank (CSH)

Accounts of type bank or cash, each with its own ledger code; transfers; petty expenses; cheque register; activity with running balance. Bank reconciliation UI is intentionally not in scope.

| ID | P | T | Case | Expected |
|---|---|---|---|---|
| CSH-001 | P1 | F | Open Cash & bank | Cards per account with balance; total |
| CSH-002 | P1 | F | Fresh company | "Main bank account" and "Cash in hand" provisioned with 0 |
| CSH-003 | P1 | F | Add bank account "HBL Current" with details | Created; new ledger code |
| CSH-004 | P1 | N | Duplicate name (case-insensitive) | "An account named HBL Current already exists." |
| CSH-005 | P1 | N | Name 1 char | Refused (min 2) |
| CSH-006 | P2 | E | Name 80 chars; 81 refused | Yes |
| CSH-007 | P2 | E | Details 200 chars; 201 refused | Yes |
| CSH-008 | P2 | N | Type `wallet` via API | Validation |
| CSH-009 | P2 | E | Add accounts until limit | "Too many bank accounts." at the cap (assert number) |
| CSH-010 | P1 | F | Transfer 10,000 bank → cash | Bank −10,000, cash +10,000; journal memo "Transfer A → B" |
| CSH-011 | P1 | N | Transfer same account | "Choose two different accounts." |
| CSH-012 | P1 | N | Transfer 0 | Refused |
| CSH-013 | P2 | F | Transfer more than balance | Allowed (overdraft) — assert design; balance negative shown |
| CSH-014 | P2 | N | Transfer in locked period | Refused |
| CSH-015 | P2 | F | Transfer memo 200 chars; 201 refused | Yes |
| CSH-016 | P2 | F | Transfer to archived account | "{name} is archived." |
| CSH-017 | P1 | F | Record expense "Fuel" 2,000 from cash | Cash −2,000; expense account 5300 default |
| CSH-018 | P2 | F | Expense account choice 5100/5200/5300 | Posted to chosen |
| CSH-019 | P1 | N | Expense memo 1 char | Refused (min 2) |
| CSH-020 | P1 | N | Expense amount 0 | Refused |
| CSH-021 | P2 | N | Expense account `9999` via API | Validation |
| CSH-022 | P2 | N | Expense in locked period | Refused |
| CSH-023 | P1 | F | Account activity view | Lines with date, memo, in/out, running balance |
| CSH-024 | P2 | F | Running balance correct after mixed receipts, payments, transfers, expenses | Verified |
| CSH-025 | P2 | F | Activity filter by date | Works |
| CSH-026 | P1 | F | Archive an empty account | Archived; hidden from selects |
| CSH-027 | P1 | N | Archive account with balance | "{name} still has a balance. Transfer it out before archiving." |
| CSH-028 | P2 | F | Restore archived account | Back |
| CSH-029 | P2 | F | Rename account | Journals show new name? (memo frozen) — balances unchanged |
| CSH-030 | P2 | F | Change account type bank→cash | Allowed; code unchanged |
| CSH-031 | P2 | F | Cheque register tab | Cheques with states and actions |
| CSH-032 | P2 | F | Deposit from register | Same as Collections |
| CSH-033 | P2 | D | Balance = journal balance of the account's code | Equal |
| CSH-034 | P2 | D | Cash/bank control reconciliation | Reconciled |
| CSH-035 | P2 | D | Transfer journal balanced two lines | Yes |
| CSH-036 | P2 | D | Expense journal: Dr expense / Cr cash | Yes |
| CSH-037 | P2 | D | Idempotent transfer retry | One journal |
| CSH-038 | P2 | S | Salesperson opens Cash & bank | Hidden; API refused for transfer/expense |
| CSH-039 | P2 | S | Recovery Officer records expense | Refused (Accountant/Owner) |
| CSH-040 | P2 | S | Accountant archives account | Allowed |
| CSH-041 | P2 | S | Auditor | Read-only |
| CSH-042 | P2 | F | Cash & bank hidden | Receipts still choose accounts (bankAccounts always sent) |
| CSH-043 | P2 | F | Receipts dialog account list uses these accounts | Yes |
| CSH-044 | P2 | F | Supplier payment from new HBL account | Posted to its code |
| CSH-045 | P2 | E | Amount 0.0001 | Accepted |
| CSH-046 | P2 | E | Amount 999,999,999,999 | Refused |
| CSH-047 | P2 | E | Memo with emoji | Saved |
| CSH-048 | P2 | E | Memo with newline | Trimmed/one line |
| CSH-049 | P2 | U | Cards show type icon (bank/cash) | Yes |
| CSH-050 | P2 | U | Negative balance styled red | Yes |
| CSH-051 | P2 | U | Dialogs on phone | Bottom sheets |
| CSH-052 | P2 | F | Transfer dialog closes on success | Yes |
| CSH-053 | P2 | F | Expense dialog closes on success | Yes |
| CSH-054 | P2 | F | Notice on success shows amount with 2 dp | "Transferred 10000.00 from …" |
| CSH-055 | P2 | F | Date defaults today (Asia/Karachi) | Yes |
| CSH-056 | P2 | E | Date 2026-02-29 (not leap) | Validation |
| CSH-057 | P2 | F | Transfer between two bank accounts | Works |
| CSH-058 | P2 | F | Transfer between two cash accounts | Works |
| CSH-059 | P2 | F | Three transfers then balances | Sum zero across accounts |
| CSH-060 | P2 | F | Expense with 4-decimal amount | Stored 4 dp |
| CSH-061 | P2 | F | Overview attention: negative cash? | Not required; no crash |
| CSH-062 | P2 | F | Total balance card = sum | Yes |
| CSH-063 | P2 | F | Account with 10,000 lines | Activity paginates or scrolls smoothly |
| CSH-064 | P2 | F | Export activity CSV (if present) | Correct |
| CSH-065 | P2 | F | Search finds account by name | Yes |
| CSH-066 | P2 | F | Account details text shows on card | Yes |
| CSH-067 | P2 | S | `save_bank_account` with archived=true and balance via API | Refused |
| CSH-068 | P2 | S | `bank_transfer` with other tenant's account id | Not found |
| CSH-069 | P2 | F | Deleting accounts not possible | Correct |
| CSH-070 | P2 | D | Ledger code uniqueness across accounts | Each distinct |
| CSH-071 | P2 | D | Code survives rename | Yes |
| CSH-072 | P2 | D | Provisioning twice (module off/on) | No duplicate accounts |
| CSH-073 | P2 | F | Receipt into cash then expense same amount | Cash back to 0 |
| CSH-074 | P2 | F | Receipt, then transfer, then payment chain | Balances correct |
| CSH-075 | P2 | F | Cheque cleared into HBL | HBL activity line |
| CSH-076 | P2 | F | Bounce after clear | Reversal line in activity |
| CSH-077 | P2 | U | Activity shows in/out columns with running balance | Yes |
| CSH-078 | P2 | U | Memo truncation with tooltip | Readable |
| CSH-079 | P2 | F | Period lock then view activity | Viewing allowed |
| CSH-080 | P2 | F | Owner reopens period, then expense | Allowed |
| CSH-081 | P2 | F | Expense memo "Fuel" twice same day | Two journals (no dedupe) |
| CSH-082 | P2 | F | Transfer 10,000.5 | Stored |
| CSH-083 | P2 | F | Keyboard: Enter submits transfer form | Yes |
| CSH-084 | P2 | F | Escape closes dialogs | Yes |
| CSH-085 | P2 | F | Account select order | Bank first then cash or alphabetical; consistent |
| CSH-086 | P2 | F | Balance after company reset | 0 |
| CSH-087 | P2 | F | Account names with Urdu | Saved |
| CSH-088 | P2 | F | Record expense with date in previous open month | Posted there; P&L month correct |
| CSH-089 | P2 | D | P&L shows expense | Yes |
| CSH-090 | P2 | D | Balance sheet cash = sum of accounts | Yes |
| CSH-091 | P2 | D | Trial balance includes each account code | Yes |
| CSH-092 | P2 | X | 50 accounts | Cards grid OK |
| CSH-093 | P2 | F | Hidden module then receipt → account still selectable | Yes |
| CSH-094 | P2 | F | Mobile card tap opens activity | Yes |
| CSH-095 | P2 | U | Card hover lift only with mouse | Yes |
| CSH-096 | P2 | F | Transfer confirmation copy | Names both accounts |
| CSH-097 | P2 | F | Activity for archived account | Viewable |
| CSH-098 | P2 | F | Attempt payment from archived account | Refused |
| CSH-099 | P2 | D | Reconciliation after 100 random operations (fuzz) | Still reconciled |
| CSH-100 | P1 | F | End to end: add account → receipts → transfer → expense → archive empty account; balances and reports agree | All pass |

Covered by automation: `cash-bank-reports.spec.ts`, unit `fixes.test.ts`.

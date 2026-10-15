# 13 — Payroll (PAY)

Monthly run per month; statuses draft → reviewed → approved → paid. Needs EOBI (employer/employee %, base) and income-tax settings. Commission approved and released is paid in the run; recoveries deducted without pushing net pay below zero.

| ID | P | T | Case | Expected |
|---|---|---|---|---|
| PAY-001 | P1 | N | Create payroll with no statutory settings | "Enter EOBI and income-tax settings in Settings → Payroll & tax before running payroll." |
| PAY-002 | P1 | F | Save settings: employer EOBI 5, employee EOBI 1, base 32,000, tax 5 | Saved |
| PAY-003 | P1 | N | Create payroll with no active employees | "Add active employees before creating payroll." |
| PAY-004 | P1 | F | Create payroll 2026-10 | Draft run with a line per active employee; gross, EOBI, tax, commission, net |
| PAY-005 | P1 | N | Create again for 2026-10 | "A payroll run already exists for this month." |
| PAY-006 | P2 | N | Month `2026-13` | Validation |
| PAY-007 | P2 | N | Month `10-2026` | Validation |
| PAY-008 | P2 | F | Default date = month-28 | Yes |
| PAY-009 | P2 | N | Date in locked period | Refused |
| PAY-010 | P1 | F | Gross = salary + allowance (attendance-prorated per rule) | Assert formula with attendance 30 vs 15 |
| PAY-011 | P2 | E | Attendance 0 | Gross 0 or base? assert rule; no negative |
| PAY-012 | P1 | F | Employee EOBI = base × 1% | 320 |
| PAY-013 | P1 | F | Employer EOBI = base × 5% | 1,600 (expense, not deducted) |
| PAY-014 | P1 | F | Income tax = 5% of earnings | Computed on gross + commission |
| PAY-015 | P1 | N | Deductions exceed earnings | "Deductions exceed earnings for {name}." |
| PAY-016 | P1 | F | Approved released commission included | Commission column; commissionIds recorded |
| PAY-017 | P1 | F | Unapproved commission excluded | Yes |
| PAY-018 | P1 | F | Released but unapproved → not paid; approve later → next run | Yes |
| PAY-019 | P1 | F | Commission held by an unpaid run is not in another run | Yes |
| PAY-020 | P1 | F | Review → Approve → Pay transitions | Each allowed in order |
| PAY-021 | P1 | N | Draft → Approved (skip) | "Invalid payroll transition." |
| PAY-022 | P1 | N | Paid → anything | Invalid |
| PAY-023 | P1 | N | Commission changed between calculate and approve (bounce) | "Commission changed since this payroll was calculated. Reconcile the run before approval." |
| PAY-024 | P1 | N | Recovery changed | "Commission recovery changed since this payroll was calculated. Reconcile the run before approval." |
| PAY-025 | P2 | F | Reconcile = recreate run (cancel draft and create) | Documented path works |
| PAY-026 | P1 | D | Pay posts: Dr salary expense / Dr employer EOBI / Cr payroll payable / Cr statutory payable / commission payable cleared | Balanced; commission not expensed twice |
| PAY-027 | P1 | D | Commission paid updates entitlement paid; movement paid | Yes |
| PAY-028 | P1 | F | Bounce recovery: paid 200, bounce → recovery 200 in next run | Net reduced by 200, floor 0 |
| PAY-029 | P2 | F | Recovery larger than net | Partial recovery; remainder stays recoverable |
| PAY-030 | P2 | F | Attendance import CSV | Updates employees' attendance |
| PAY-031 | P2 | N | Attendance import unknown employee | "employee X not found" |
| PAY-032 | P2 | N | Attendance 31 in file | Row error |
| PAY-033 | P2 | F | Payroll print/payslip (if present) | Per employee |
| PAY-034 | P2 | F | Payroll list shows runs with status and total | Yes |
| PAY-035 | P2 | S | Payroll Administrator creates run | Allowed |
| PAY-036 | P2 | S | Sales Manager opens Payroll | Hidden; salaries zeroed in projection |
| PAY-037 | P2 | S | Salesperson API create_payroll | Refused |
| PAY-038 | P2 | S | Auditor views payroll | Read-only full |
| PAY-039 | P2 | S | Branch-limited Accountant | Payrolls not sent |
| PAY-040 | P2 | F | Payroll off in Features | Sidebar absent; API module-off message |
| PAY-041 | P2 | F | Turn Payroll on later | Accounts provisioned; settings still required |
| PAY-042 | P2 | E | Salary 0 employee | Line with 0 gross; commission still paid |
| PAY-043 | P2 | E | Employee with only commission | Net = commission − tax |
| PAY-044 | P2 | E | 500 employees | Run computes < 5 s |
| PAY-045 | P2 | E | Settings: EOBI 100% | Allowed (pct ≤ 100) |
| PAY-046 | P2 | N | Settings tax 101 | Refused |
| PAY-047 | P2 | E | Settings blank strings | Allowed to save but payroll refuses |
| PAY-048 | P2 | F | Numbering per year | PAY-2026-0001 |
| PAY-049 | P2 | F | Run for a past month | Allowed if open |
| PAY-050 | P2 | F | Run for a future month | Allowed? assert |
| PAY-051 | P2 | D | Two runs different months with same commission | Second excludes paid ones |
| PAY-052 | P2 | D | Payroll totals = sum of lines | Yes |
| PAY-053 | P2 | D | Reconciliation: payroll payable | Reconciled |
| PAY-054 | P2 | F | Cancel/delete draft run | If offered; else document |
| PAY-055 | P2 | F | Employee deactivated after run created | Line stays |
| PAY-056 | P2 | F | Employee deactivated before run | Excluded |
| PAY-057 | P2 | F | Deduction field on employee | Deducted |
| PAY-058 | P2 | E | Deduction equal to earnings | Net 0 allowed |
| PAY-059 | P2 | E | Deduction > earnings | Refused message |
| PAY-060 | P2 | F | Review as Accountant, approve as Owner, pay as Accountant | Any permitted role per step |
| PAY-061 | P2 | S | Pay as Payroll Administrator | Allowed |
| PAY-062 | P2 | F | Settings → Payroll visible only with Payroll on | Yes |
| PAY-063 | P2 | U | Lines table columns readable on phone | Scroll |
| PAY-064 | P2 | U | Status badges | Colours |
| PAY-065 | P2 | F | Audit entries for each transition | Yes |
| PAY-066 | P2 | D | Idempotent pay retry | One journal |
| PAY-067 | P2 | F | Pay in locked period | Refused |
| PAY-068 | P2 | F | Lock period after pay | Allowed; run unchanged |
| PAY-069 | P2 | F | Commission from walk-in customer invoices | Included |
| PAY-070 | P2 | D | Entitlement paid ≤ released after pay | Yes |
| PAY-071 | P2 | D | Movement paid amount per entitlement | Yes |
| PAY-072 | P2 | F | Employee salary change after draft run | Run keeps calculated values |
| PAY-073 | P2 | F | Settings change after draft | Run keeps values |
| PAY-074 | P2 | E | Base 0 | EOBI 0 |
| PAY-075 | P2 | E | Tax 0 | No tax |
| PAY-076 | P2 | F | Export payroll CSV (if present) | Correct |
| PAY-077 | P2 | F | Search finds payroll run | Yes |
| PAY-078 | P2 | F | Overview no payroll numbers for non-pay roles | Correct |
| PAY-079 | P2 | D | Trial balance after pay | Balanced |
| PAY-080 | P2 | D | P&L shows salary and employer EOBI | Yes |
| PAY-081 | P2 | D | Balance sheet shows payables until settled | Yes |
| PAY-082 | P2 | F | Settle payroll payable via Cash & bank expense/transfer | Documented path |
| PAY-083 | P2 | F | Attendance 30 default | Yes |
| PAY-084 | P2 | E | Attendance 29.5 | Allowed? number min 0 max 30 → allowed |
| PAY-085 | P2 | F | Reports: payroll summary (if present) | Correct |
| PAY-086 | P2 | S | `update_payroll` for other tenant id | Not found |
| PAY-087 | P2 | F | Hidden Payroll with existing runs | Kept; hidden |
| PAY-088 | P2 | F | Review button disabled while busy | Yes |
| PAY-089 | P2 | U | Line commission tooltip lists invoices | If present |
| PAY-090 | P2 | F | Multiple recoveries across employees | Each independent |
| PAY-091 | P2 | D | Recovery never exceeds paid − released | Yes |
| PAY-092 | P2 | D | After recovery, entitlement paid reduced | Yes |
| PAY-093 | P2 | F | Run with 0 total | Allowed; posting of zero lines skipped |
| PAY-094 | P2 | F | Error wording for prototype rules | No "prototype" banner in UI (removed); message text "Payroll calculated using prototype rules." still returned → flag for copy change |
| PAY-095 | P2 | X | 12 runs in a year | List OK |
| PAY-096 | P2 | F | Keyboard flow through transitions | Buttons focusable |
| PAY-097 | P2 | F | Payroll Administrator sees sales invoices only (projection) | Yes |
| PAY-098 | P2 | F | Payroll for month with no invoices | Commission 0 |
| PAY-099 | P2 | D | Sum of net pay + deductions + tax + employee EOBI = gross + commission − recovery | Exact |
| PAY-100 | P1 | F | End to end: settings → employees → invoices/receipts → approve → run → review → approve → pay → bounce → next run recovers | All pass |

Covered by automation: unit `workflows.test.ts` (payroll/commission), `owner-workspace.spec.ts` (view).

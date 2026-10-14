# 12 — Commissions (COM)

Plans: flat, category, customer_class, per_unit, tiered; effective-dated; no overlaps. Entitlements are earned on invoice submit, released as customer cash clears, approved for payroll, paid by payroll, reversed/recovered on bounce.

| ID | P | T | Case | Expected |
|---|---|---|---|---|
| COM-001 | P1 | F | Commissions → Salespeople → New employee "Hamza, Order Booker" | Saved; appears in invoice salesperson select |
| COM-002 | P1 | F | Plans: edit provisioned "Standard plan" to flat 2% | Saved |
| COM-003 | P1 | N | Plan effectiveTo before effectiveFrom | "Plan dates are invalid." |
| COM-004 | P1 | N | Second plan overlapping dates | "Commission plan dates overlap." |
| COM-005 | P2 | F | Adjacent plans (to = 2026-12-31, next from = 2027-01-01) | Allowed |
| COM-006 | P2 | N | Plan name 1 char | Refused |
| COM-007 | P2 | N | Rate −1 | Refused |
| COM-008 | P2 | N | Rate 101 on category rates (pct) | Refused |
| COM-009 | P2 | N | Tiers empty | Validation min 1 |
| COM-010 | P2 | N | Multiplier 0 | Refused (pos) |
| COM-011 | P2 | F | Category plan: Lighting = 2.5 | Lines in Lighting earn 2.5%, others 0 or base rate (assert) |
| COM-012 | P2 | F | Customer class plan: Wholesaler = 1 | By customer class snapshot |
| COM-013 | P2 | F | Per-unit plan rate 10 | Earned = qty × 10 |
| COM-014 | P2 | F | Tiered plan 0 = 2, 500000 = 3 | Rate by cumulative base (assert definition) |
| COM-015 | P2 | F | Target and multiplier | Applied when target met (assert definition) |
| COM-016 | P1 | F | Invoice 10,000 net with Hamza, flat 2% | Entitlement earned 200, released 0 |
| COM-017 | P1 | F | Cash receipt 5,000 | Released 100 |
| COM-018 | P1 | F | Cheque cleared 5,000 | Released 200 (full) |
| COM-019 | P1 | F | Cheque only deposited | No release |
| COM-020 | P1 | F | Cheque bounced after clear | Release reversed; movement release_reversed |
| COM-021 | P1 | F | Bounce after paid | Recovery recorded; paid > released; next payroll deducts |
| COM-022 | P1 | F | Approve released entitlement | approved=true; "Commission approved for payroll." |
| COM-023 | P1 | N | Approve with nothing released | "There is no released unpaid commission to approve." |
| COM-024 | P2 | N | Approve already fully paid | Same refusal |
| COM-025 | P2 | F | Approve several ids | All approved |
| COM-026 | P2 | N | Approve empty ids | Validation min 1 |
| COM-027 | P2 | S | Branch-limited approver, invoice in other branch | Refused |
| COM-028 | P1 | D | Invariant earned ≥ released ≥ paid | Holds through all cases |
| COM-029 | P1 | D | Plan snapshot stored on entitlement | Changing the plan later does not alter earned |
| COM-030 | P2 | D | Movements immutable, one per event | accrued, released, release_reversed, paid, recovery_recorded |
| COM-031 | P2 | F | Invoice with no salesperson | No entitlement |
| COM-032 | P2 | F | Invoice line split 60/40 between two salespeople | Two entitlements by share |
| COM-033 | P2 | N | Splits total 90 | "Commission splits must total 100%." |
| COM-034 | P2 | N | Split with unknown employee | "Employee not found." |
| COM-035 | P2 | F | Credit note (return) on commissioned invoice | Entitlement adjusted (entitlement_adjusted) proportionally |
| COM-036 | P2 | F | Return after release | Released capped at new earned; movement |
| COM-037 | P2 | F | Return after paid | Recovery |
| COM-038 | P2 | F | Discounted line base | Base = net after discount, before tax |
| COM-039 | P2 | F | Tax excluded from base | Yes |
| COM-040 | P2 | F | Entitlements list: columns earned/released/paid/approved | Correct |
| COM-041 | P2 | F | Filter by salesperson | Works |
| COM-042 | P2 | F | Entitlement links to invoice | Opens details |
| COM-043 | P1 | S | Salesperson sees only own entitlements | Yes |
| COM-044 | P2 | S | Sales Manager sees all; cannot see salaries | Employees shown with salary 0 |
| COM-045 | P2 | S | Payroll Administrator sees entitlements | Yes |
| COM-046 | P2 | S | Recovery Officer sees Commissions | Hidden |
| COM-047 | P2 | S | Salesperson approves | Refused (Sales Manager, Accountant, Owner) |
| COM-048 | P2 | F | Employee hierarchy: Reports to | Saved; manager chain |
| COM-049 | P2 | N | Hierarchy cycle A→B→A | "The sales hierarchy cannot contain a cycle." |
| COM-050 | P2 | N | Employee as own manager | Cycle refused |
| COM-051 | P2 | F | Deactivate employee | Hidden from invoice select; history kept |
| COM-052 | P2 | F | Invoice with inactive employee via API | Allowed? assert; else refused |
| COM-053 | P2 | F | Employee import CSV | Created; manager by name |
| COM-054 | P2 | N | Import manager name not found | "manager X not found" |
| COM-055 | P2 | N | Import duplicate employee | "employee X appears more than once in the file" |
| COM-056 | P2 | N | Import existing employee create mode | "employee X already exists" |
| COM-057 | P2 | F | Export employees | Salary columns only for pay roles (assert projection) |
| COM-058 | P2 | E | Employee name 100 chars; 101 refused | Yes |
| COM-059 | P2 | E | Attendance 31 | Refused (max 30) |
| COM-060 | P2 | E | Salary negative | Refused |
| COM-061 | P2 | F | Commission with Collections hidden | Cash still releases (engine) — assert |
| COM-062 | P2 | F | Commissions hidden then invoice submitted | No entitlement? assert gating of accrual |
| COM-063 | P2 | F | Turn Commissions on later | Past invoices do not accrue retroactively |
| COM-064 | P2 | D | Reconciliation: commission expense (accrued) = sum earned; payable = earned − paid | Reconciled |
| COM-065 | P2 | D | Journal on accrual: Dr commission expense / Cr commission payable | At submit |
| COM-066 | P2 | D | Journal on payroll pay | Payable cleared; no double expense |
| COM-067 | P2 | F | Plan effective dates vs invoice date | Invoice dated outside any plan → no entitlement |
| COM-068 | P2 | F | Two plans in different years, invoice in each | Correct plan each |
| COM-069 | P2 | E | Rate 0 | Entitlement 0 (or none) |
| COM-070 | P2 | E | Rate 100 | Earned = base |
| COM-071 | P2 | E | Per-unit on 0.5 qty | 5 |
| COM-072 | P2 | E | Tier threshold equal to base | Boundary inclusive? assert |
| COM-073 | P2 | F | Per-unit plan with quantity returned | Adjusted |
| COM-074 | P2 | F | Entitlement when invoice cancelled (draft) | Never created |
| COM-075 | P2 | F | Multiple receipts across many invoices | Each release attributed to its invoice |
| COM-076 | P2 | F | Overpayment prevented so release never > earned | Yes |
| COM-077 | P2 | D | Rounding: 2% of 33.33 | 0.6666 stored 4 dp; movements sum exactly |
| COM-078 | P2 | D | Sum of released across partial receipts = total when fully paid | Exact |
| COM-079 | P2 | F | Attention: released unapproved commissions | Listed |
| COM-080 | P2 | F | Sales analysis by salesperson includes commission | Yes |
| COM-081 | P2 | U | Entitlement badges earned/released/approved | Colours |
| COM-082 | P2 | U | Plans form pairs textarea "Lighting = 2.5" | Parsed; invalid lines ignored |
| COM-083 | P2 | E | Pairs with `=` in key | Split at first `=` |
| COM-084 | P2 | F | Plan form shows only fields for its type | Yes or all; consistent |
| COM-085 | P2 | F | Salesperson "View as" preview from Owner | Entitlements filtered |
| COM-086 | P2 | F | Employee territory field | Saved; filter |
| COM-087 | P2 | F | Search finds employee | Yes |
| COM-088 | P2 | X | 10,000 entitlements | List < 2 s |
| COM-089 | P2 | F | LIVE label in sidebar | Present on Commissions |
| COM-090 | P2 | D | Idempotent approve retry | No change second time |
| COM-091 | P2 | F | Approve then invoice bounce | approved stays; released drops; payroll refuses "Commission changed…" |
| COM-092 | P2 | F | Walk-in customer invoice with salesperson | Commission accrues normally |
| COM-093 | P2 | F | Credit note on walk-in | Adjusts |
| COM-094 | P2 | F | Employee deactivated with unpaid commission | Still payable; shown |
| COM-095 | P2 | F | Payroll off: approvals still possible | Yes; "ready for payroll" |
| COM-096 | P2 | F | Hide Commissions with password | Counts show plans/entitlements |
| COM-097 | P2 | D | Audit log for approvals | Yes |
| COM-098 | P2 | S | `save_plan` as Salesperson | Refused |
| COM-099 | P2 | S | `approve_commission` for other tenant's id | Not found |
| COM-100 | P1 | F | End to end: plan → invoice with split → partial cash → cheque clear → approve → payroll pay → bounce → recovery in next payroll | All invariants hold |

Covered by automation: unit `workflows.test.ts`, `fixes.test.ts`, `reports.test.ts`; `owner-workspace.spec.ts` (views).

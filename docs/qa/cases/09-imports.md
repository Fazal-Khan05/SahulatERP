# 09 — Imports and landed cost (IMP)

A shipment is created from a submitted GRN or supplier bill. Costs are classified inventory / recoverable_tax / deposit / expense and allocated by value, quantity, weight or volume. Customs lookup is simulated.

| ID | P | T | Case | Expected |
|---|---|---|---|---|
| IMP-001 | P1 | F | Create shipment from a submitted GRN | SHP-2026-001; supplier, origin default Shenzhen, port Karachi; status received |
| IMP-002 | P1 | N | Create from a draft GRN | "Choose a submitted receipt or supplier bill." |
| IMP-003 | P1 | N | Create from a PO | Same refusal |
| IMP-004 | P2 | F | Create from a submitted bill | Allowed |
| IMP-005 | P2 | F | Container, GD number, ETA fields | Saved; shown in list |
| IMP-006 | P2 | E | ETA invalid date | Validation |
| IMP-007 | P2 | E | GD number 100 chars | Saved |
| IMP-008 | P1 | F | Add cost: Freight 50,000, inventory, by value | Listed unallocated |
| IMP-009 | P1 | F | Add cost: Customs duty 80,000, inventory, by quantity | Listed |
| IMP-010 | P1 | F | Add cost: Sales tax at import 30,000, recoverable_tax | Listed |
| IMP-011 | P1 | F | Add cost: Container deposit 20,000, deposit | Listed |
| IMP-012 | P1 | F | Add cost: Clearing agent fee 5,000, expense | Listed |
| IMP-013 | P1 | N | Cost amount 0 | Refused |
| IMP-014 | P2 | N | Cost label empty | Refused |
| IMP-015 | P2 | N | Classification `other` via API | Validation |
| IMP-016 | P2 | N | Basis `price` via API | Validation |
| IMP-017 | P1 | F | Allocate | Inventory costs added to each line's stock value by basis; tax → 1500-type recoverable; deposit → asset; expense → 5xxx |
| IMP-018 | P1 | D | By value: lines 70%/30% of value get 70/30 of freight | Exact split; remainder paisa on last line |
| IMP-019 | P1 | D | By quantity | Split by units |
| IMP-020 | P1 | D | By weight using product weight | Split by qty×weight |
| IMP-021 | P1 | D | By volume | Split by qty×volume |
| IMP-022 | P2 | D | Weight 0 on one product, basis weight | That line gets 0; others share; no NaN |
| IMP-023 | P2 | D | All weights 0, basis weight | Allocation refused or falls back to quantity; no division by zero |
| IMP-024 | P1 | D | Average cost after allocation | (stock value + allocated) / qty |
| IMP-025 | P1 | D | Allocation when part of the stock already sold | Remaining inventory gets its share; sold share hits COGS (reconcile) |
| IMP-026 | P1 | D | Allocation when all stock sold | Entire inventory cost to COGS; stock value stays 0 |
| IMP-027 | P1 | N | Allocate twice | "All shipment costs are already allocated." |
| IMP-028 | P2 | F | Add another cost after allocation, allocate again | Only the new cost allocated; status costed |
| IMP-029 | P2 | N | Allocate in locked period | Refused |
| IMP-030 | P2 | S | Warehouse Manager allocates | Allowed? access: allocate_shipment Accountant only → refused |
| IMP-031 | P2 | S | Warehouse Manager creates shipment | Allowed |
| IMP-032 | P2 | S | Salesperson sees Imports | Hidden |
| IMP-033 | P2 | S | Branch-limited user, GRN in other branch | Refused |
| IMP-034 | P2 | F | Shipment status flow in_transit → customs → received → costed | Displayed; costed after allocation |
| IMP-035 | P2 | F | Shipment list columns: shipment, supplier, container/GD, ETA, status, unallocated | Correct totals |
| IMP-036 | P2 | F | Unallocated total = sum of unallocated costs | Yes |
| IMP-037 | P2 | F | Customs lookup (simulated) shows GD lookup result | No "simulated" banner on the page any more; lookup still returns stub data |
| IMP-038 | P2 | D | Journal on allocate: Dr 1200 (inventory part) / Dr 1500 (tax) / Dr deposit asset / Dr expense / Cr 2000 or accrued charges | Balanced; one journal per allocation |
| IMP-039 | P2 | D | Reconciliation after allocation | Inventory control = valuation |
| IMP-040 | P2 | D | P&L after allocation | Expense cost in P&L; inventory cost not |
| IMP-041 | P2 | D | Deposit later refunded | Manual journal reversal path; documented |
| IMP-042 | P2 | E | Cost 0.0001 | Accepted; allocation rounds to 0 on small lines without error |
| IMP-043 | P2 | E | 50 costs on one shipment | Allocated in one journal |
| IMP-044 | P2 | E | GRN with 100 lines | Allocation computes < 2 s |
| IMP-045 | P2 | E | Cost in USD? | Costs are PKR only; UI labels PKR |
| IMP-046 | P2 | F | Shipment for walk-in supplier GRN | Works |
| IMP-047 | P2 | F | Shipment from bill when GRN also exists | Lines from the bill used |
| IMP-048 | P2 | N | Shipment from cancelled GRN | Refused |
| IMP-049 | P2 | F | Two shipments for the same GRN | Allowed? verify; each allocates its own costs |
| IMP-050 | P2 | F | Delete cost before allocation | If supported; else not offered |
| IMP-051 | P2 | F | Edit cost after allocation | Not allowed (immutable) |
| IMP-052 | P2 | F | Shipment number sequence per year | SHP-2026-001, 002 |
| IMP-053 | P2 | U | Shipment table on phone | Scroll hint |
| IMP-054 | P2 | U | Add cost dialog placeholders | Amount empty with placeholder |
| IMP-055 | P2 | U | Classification help text | Explains each |
| IMP-056 | P2 | F | Search finds shipment by number/container | Yes |
| IMP-057 | P2 | F | Attention queue: shipments with unallocated costs | Listed |
| IMP-058 | P2 | D | Allocation then stock transfer | Value moves with units |
| IMP-059 | P2 | D | Allocation then supplier return | Return at current avg cost incl. landed; payable reduced by bill price only (document) |
| IMP-060 | P2 | D | Allocation then count correction | Uses new avg |
| IMP-061 | P2 | D | Idempotent allocate retry | One journal |
| IMP-062 | P2 | F | Audit entries for shipment commands | Present |
| IMP-063 | P2 | F | Hidden Imports module with existing shipments | Hidden; data kept; API refused |
| IMP-064 | P2 | F | Turn Imports on later | Deposits and expense accounts provisioned once |
| IMP-065 | P2 | E | Label with emoji | Saved |
| IMP-066 | P2 | E | Amount 999,999,999,999 | Refused (trillion rule) |
| IMP-067 | P2 | E | Negative amount | Refused |
| IMP-068 | P2 | F | ETA in the past | Allowed |
| IMP-069 | P2 | F | Origin/port blank | Defaults applied |
| IMP-070 | P2 | F | Shipment detail shows per-line landed cost | Value per unit after allocation |
| IMP-071 | P2 | D | Landed cost per unit = (price×rate + allocated)/qty | Exact |
| IMP-072 | P2 | D | Sales after landed cost use new COGS | Margin reflects |
| IMP-073 | P2 | F | Sales analysis margin after allocation | Updated |
| IMP-074 | P2 | S | Auditor views shipments | Read-only |
| IMP-075 | P2 | S | `add_shipment_cost` as Payroll Administrator | Refused |
| IMP-076 | P2 | F | Shipment with no costs allocate | "All shipment costs are already allocated." (nothing pending) |
| IMP-077 | P2 | F | Reports: stock valuation shows landed value | Yes |
| IMP-078 | P2 | F | GRN print unaffected by allocation | Yes |
| IMP-079 | P2 | D | Allocation rounding across 3 lines of 1/3 each | Sum equals cost exactly |
| IMP-080 | P2 | D | Allocation with lines of quantity 0.5 | Works |
| IMP-081 | P2 | F | Attention clears after allocation | Yes |
| IMP-082 | P2 | F | Shipment list sorting newest first | Yes |
| IMP-083 | P2 | F | Filter by status | Works |
| IMP-084 | P2 | E | 200 shipments | List OK |
| IMP-085 | P2 | F | Recoverable tax appears in tax summary/reports | Yes |
| IMP-086 | P2 | F | Expense classification appears in P&L under clearing/import expenses | Yes |
| IMP-087 | P2 | D | Deposit classification on balance sheet as asset | Yes |
| IMP-088 | P2 | F | Shipment keyboard navigation | Buttons reachable |
| IMP-089 | P2 | U | Status badges colours | Pastel per status |
| IMP-090 | P2 | F | Shipment from GRN of a supplier later archived | Still viewable |
| IMP-091 | P2 | F | Shipment when Inventory hidden | Imports requires Inventory; cannot be on alone |
| IMP-092 | P2 | N | Turn off Inventory with Imports on | Imports turned off too (dependency) |
| IMP-093 | P2 | D | Allocation date defaults today; custom date in open period | Journal dated accordingly |
| IMP-094 | P2 | N | Allocation date in future locked? | Only locked months refused |
| IMP-095 | P2 | F | Container number with spaces | Saved as typed |
| IMP-096 | P2 | X | Allocation on GRN with 100 lines and 20 costs | < 3 s |
| IMP-097 | P2 | F | Export shipments CSV (if present) | Columns correct |
| IMP-098 | P2 | F | Attention item link opens Imports | Yes |
| IMP-099 | P2 | D | Trial balance after all import postings | Balanced |
| IMP-100 | P1 | F | End to end: USD GRN → shipment → 5 classified costs → allocate → sell → P&L and reconciliation correct | All pass |

Covered by automation: unit `workflows.test.ts` (allocation), `fixes.test.ts` (late charges).

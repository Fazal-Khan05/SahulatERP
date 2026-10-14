# 06 — Inventory: stock, transfers, corrections, valuation, warehouses (INV)

Preconditions: Inventory on; product "LED-24" with 50 units @ 1,500 in Main store.

| ID | P | T | Case | Expected |
|---|---|---|---|---|
| INV-001 | P1 | F | Inventory → Stock | Row per product: quantity, average cost, value, badge |
| INV-002 | P1 | F | Single warehouse | Tab says "Stock"; no warehouse column, filter or transfer button; no "Main branch" text anywhere |
| INV-003 | P1 | F | Add second warehouse | Warehouse column, filter, "Transfer stock" and per-warehouse breakdown appear |
| INV-004 | P1 | F | View product → movement history | Opening stock row with qty +50, value 75,000, type adjustment |
| INV-005 | P1 | F | Set quantity (count correction) 50 → 45, reason | Movement −5 @ avg cost; journal Dr 5300 shrinkage / Cr 1200 |
| INV-006 | P1 | F | Set quantity 45 → 60 with unit cost 1,600 | +15 @ 1,600; average cost recomputed = (45×1500+15×1600)/60 |
| INV-007 | P1 | N | Set quantity to the same number | "Enter a different quantity to save a stock correction." |
| INV-008 | P1 | N | Set quantity without reason | "Adjustment reason is required." |
| INV-009 | P1 | N | Increase without unit cost | "Enter a unit cost above zero for added stock." |
| INV-010 | P1 | N | Set quantity to −1 | Blocked; API nonneg |
| INV-011 | P1 | D | Stale expected quantity (someone else changed it) | "Stock changed since you opened this item. Current quantity in Main store: N" |
| INV-012 | P2 | F | Purpose opening_stock on increase | Offsets to 3000 equity |
| INV-013 | P2 | F | Purpose count_correction on increase | Offsets to 5300 |
| INV-014 | P2 | E | Set quantity 0.0001 | Accepted |
| INV-015 | P2 | E | Set quantity 999,999,999 | Accepted; value below one trillion rule |
| INV-016 | P2 | N | Set quantity in a locked period | "Accounting period … is locked." |
| INV-017 | P2 | N | Date in the future | Accepted or refused consistently (document) |
| INV-018 | P2 | E | Date `2026-02-30` | Validation error (iso date) |
| INV-019 | P1 | F | Bulk stock increase: two products | Two movements, one journal with total |
| INV-020 | P1 | N | Bulk increase with duplicate product | "Each product can appear only once in a stock increase." |
| INV-021 | P1 | N | Bulk increase line qty 0 | "Amount must be greater than zero." |
| INV-022 | P2 | N | Bulk increase value rounds to 0 (qty 0.0001 cost 0.0001) | "Each added stock line must have a positive value." |
| INV-023 | P2 | N | Bulk increase 501 lines | Validation max 500 |
| INV-024 | P2 | N | Bulk increase reason empty | Validation |
| INV-025 | P1 | F | Transfer 10 units Main → Lahore | Main −10, Lahore +10 at same value; no P&L effect |
| INV-026 | P1 | N | Transfer same warehouse | "Choose two different warehouses." |
| INV-027 | P1 | N | Transfer 60 when 50 available | "Insufficient stock for LED Panel 24W in Main store. Requested: 60, available: 50." |
| INV-028 | P2 | N | Transfer 0 | Refused |
| INV-029 | P2 | F | Transfer dialog closes on success | Yes (scoped auto-close) |
| INV-030 | P2 | F | Transfer in a locked period | Refused |
| INV-031 | P2 | S | Warehouse Manager of branch A transfers from branch B | "This warehouse is outside your permitted branches." |
| INV-032 | P2 | S | Salesperson opens Inventory | Allowed to view? Verify canView; transfer buttons absent |
| INV-033 | P2 | D | Average cost after transfer unchanged in both | Yes |
| INV-034 | P1 | D | Sale of 10 @ avg 1,500 | COGS 15,000; stock 40; value 60,000 |
| INV-035 | P1 | D | Purchase receipt 20 @ 1,800 | Avg = (40×1500+20×1800)/60 = 1,600 |
| INV-036 | P1 | D | Sale after that at avg 1,600 | COGS uses 1,600 |
| INV-037 | P1 | D | Return of 1 unit from an invoice | Stock +1 at the invoice line's cost; value restored |
| INV-038 | P2 | D | Stock never negative via any path | Direct invoice, delivery, transfer, correction all guarded |
| INV-039 | P2 | D | Rounding: 3 units @ 10.0001 then sell 1 | Value never drifts beyond 0.0001; final stock 0 has value 0 |
| INV-040 | P2 | D | Sell exactly all stock | Qty 0, value exactly 0.0000 |
| INV-041 | P2 | F | Stock level filter Available / Low / Out | Correct sets |
| INV-042 | P2 | F | Category filter | Works |
| INV-043 | P2 | F | Search by SKU | Works |
| INV-044 | P2 | F | Badge "Out of stock" red at 0 | Yes |
| INV-045 | P2 | F | "Low stock" when qty ≤ reorder level and > 0 | Yes |
| INV-046 | P2 | F | Overview attention: low stock queue | Lists the items |
| INV-047 | P1 | F | Warehouses tab: add warehouse with branch | Created; unique name |
| INV-048 | P1 | N | Duplicate warehouse name | "Warehouse X already exists." |
| INV-049 | P2 | N | Warehouse name empty | Refused |
| INV-050 | P1 | F | Add branch | "Branch X already exists." on duplicate |
| INV-051 | P2 | F | Branch picker appears in header only with ≥2 branches | Yes |
| INV-052 | P2 | F | Branch picker filters documents/stock | Yes |
| INV-053 | P2 | S | Member with branchIds [A] | Sees only branch A data; picker locked |
| INV-054 | P2 | F | Archive a warehouse with stock | Refused or prevented (define) ; empty warehouse archive allowed |
| INV-055 | P2 | F | Default warehouse on documents | First warehouse when single |
| INV-056 | P2 | F | Document warehouse select hidden when single | Yes |
| INV-057 | P2 | F | Stock valuation report = Stock tab total | Equal to the paisa |
| INV-058 | P2 | D | Inventory control (1200) = valuation | Control reconciliation "reconciled" |
| INV-059 | P2 | F | Movement history types: adjustment, sale, purchase, transfer, return | Labelled; source document linked |
| INV-060 | P2 | F | Movement history order | Chronological; running quantity |
| INV-061 | P2 | U | Item details on phone | Sections stack; history scrolls |
| INV-062 | P2 | F | Set quantity dialog closes on success | Yes |
| INV-063 | P2 | F | Set quantity dialog shows current qty and value | Yes |
| INV-064 | P2 | E | Reason 2,000 chars; 2,001 refused | Yes |
| INV-065 | P2 | E | Unit cost with 4 decimals | Stored |
| INV-066 | P2 | E | Unit cost 0.00001 | Rounds to 0 → "Enter a unit cost above zero" |
| INV-067 | P2 | D | Correction journal memo contains reason | Yes |
| INV-068 | P2 | D | Journal source id = movement id; re-posting same source | "This source has already been posted." |
| INV-069 | P2 | D | Idempotent retry of set_stock_quantity | Single movement |
| INV-070 | P2 | F | Stock in two warehouses, sell from Lahore only | Main unchanged |
| INV-071 | P2 | F | Delivery from warehouse with 0 of the item | Insufficient stock message names the warehouse |
| INV-072 | P2 | F | Stock tab totals row | Sum of values |
| INV-073 | P2 | F | Export stock CSV (report) | Matches tab |
| INV-074 | P2 | F | Archived product with stock in Stock tab | Shown (stock is real) with archived mark |
| INV-075 | P2 | F | Product with stock in only one of two warehouses | Breakdown shows 0 for the other |
| INV-076 | P2 | U | Transfer dialog warehouse selects exclude archived | Yes |
| INV-077 | P2 | F | Transfer multiple lines | Each guarded individually; all-or-nothing |
| INV-078 | P2 | N | Transfer with unknown item id | "Product not found." |
| INV-079 | P2 | N | Transfer with unknown warehouse | "Warehouse not found." |
| INV-080 | P2 | F | stock_adjust (free adjustment) non-zero | Posted |
| INV-081 | P2 | N | stock_adjust 0 | "Enter a non-zero adjustment." |
| INV-082 | P2 | F | Count correction when average cost is 0 (no history) | Uses product standard cost; if 0 requires unit cost |
| INV-083 | P2 | D | Valuation after opening stock, purchase, sale, return, correction, transfer | Equals sum of movements' values |
| INV-084 | P2 | D | Stock movements report = history | Yes |
| INV-085 | P2 | F | Overview "Inventory value" metric | Equals valuation |
| INV-086 | P2 | X | 2,000 products × 3 warehouses | Stock tab renders < 2 s |
| INV-087 | P2 | X | 50,000 movements for one item | History paginates/scrolls; no freeze |
| INV-088 | P2 | F | Warehouse rename | Reflected in history and documents |
| INV-089 | P2 | F | Branch rename | Reflected in picker |
| INV-090 | P2 | S | Auditor views stock | Read-only; no buttons |
| INV-091 | P2 | S | `set_stock_quantity` as Salesperson via API | Refused |
| INV-092 | P2 | F | Hidden Inventory module | Stock view gone; sale still moves stock (engine) |
| INV-093 | P2 | F | Re-enable Inventory | View returns with all data |
| INV-094 | P2 | E | Warehouse name with emoji | Saved |
| INV-095 | P2 | E | 50 warehouses | Selects remain usable |
| INV-096 | P2 | F | Transfer then cancel? | Transfers post immediately; no draft; reversing requires opposite transfer |
| INV-097 | P2 | D | Transfer journal | None (no accounting effect) or balanced zero — verify no unbalanced posting |
| INV-098 | P2 | U | Quantity formatting `50 pcs` with unit | Yes; blank unit → `50` |
| INV-099 | P2 | U | Average cost formatted `Rs 1,500` | Yes |
| INV-100 | P1 | F | End to end: opening stock → purchase → transfer → sale → return → correction; reconciliation reconciled | All pass |

Covered by automation: `master-data.spec.ts` (warehouses, set quantity), `documents.spec.ts` (stock on delivery/invoice/return), unit `workflows.test.ts`, `fixes.test.ts`.

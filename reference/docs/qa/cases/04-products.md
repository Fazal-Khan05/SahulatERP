# 04 — Products, opening stock, CSV import/export (PRD)

Preconditions: Inventory module on; signed in as Owner unless stated. Form: SKU*, name*, category, unit, selling price*, standard cost, HS code, reorder level, weight, volume; new products also get Opening stock (quantity, cost per unit, warehouse when >1).

| ID | P | T | Case | Expected |
|---|---|---|---|---|
| PRD-001 | P1 | F | Inventory → Products → New product with SKU, name, price | "{name} saved."; appears in list |
| PRD-002 | P1 | N | Empty SKU | HTML required blocks; API: "SKU is required" |
| PRD-003 | P1 | N | Empty name | Blocked; API: name min 2 |
| PRD-004 | P1 | N | Name of 1 char | Refused |
| PRD-005 | P1 | N | Duplicate SKU, different case `led-24` vs `LED-24` | "SKU LED-24 already exists." |
| PRD-006 | P2 | E | SKU with surrounding spaces | Trimmed before uniqueness check |
| PRD-007 | P2 | E | SKU 50 chars | Accepted; 51 refused |
| PRD-008 | P2 | E | SKU with slash, hash, Urdu | Accepted; shows in lists and print |
| PRD-009 | P1 | N | Price left empty | HTML required blocks submit (price is required) |
| PRD-010 | P2 | E | Price `0` | Accepted (free item) |
| PRD-011 | P1 | N | Price `-5` | Blocked by min=0; API "Amount cannot be negative." |
| PRD-012 | P2 | E | Price `0.0001` | Accepted; shows Rs 0 in list (4 dp stored) |
| PRD-013 | P2 | E | Price `999999999999` (1 trillion − 1) | Accepted; `1000000000000` refused "Enter a valid number below one trillion" |
| PRD-014 | P2 | N | Price `abc` via API | Validation error |
| PRD-015 | P2 | N | Price `1e3` typed | Browser number input accepts → 1000 |
| PRD-016 | P2 | E | Price with 6 decimals `12.345678` | Stored at 4 dp, rounding defined (half-up) |
| PRD-017 | P2 | F | Cost left empty | Saved as 0 (placeholder shown) |
| PRD-018 | P2 | F | Unit left blank | Saved blank; invoice shows quantity only |
| PRD-019 | P2 | E | Unit `1000 pcs` (user puts quantity in unit) | Saved as text; prints "199 1000 pcs" — documented limitation; hint text says "pcs, box, kg…" |
| PRD-020 | P2 | E | Unit 20 chars; 21 refused | Yes |
| PRD-021 | P2 | F | Category blank | Saved as "General" placeholder? No: saved blank — verify list shows blank, commission by category treats as uncategorised |
| PRD-022 | P2 | F | Reorder level 0 | Badge logic: "Available" when qty>0 |
| PRD-023 | P2 | F | Reorder level 10, stock 5 | "Low stock" badge; Overview attention item |
| PRD-024 | P2 | N | Reorder level `-1` | Blocked min 0; API int min 0 |
| PRD-025 | P2 | N | Reorder level `2.5` | HTML step 1 blocks; API int refused |
| PRD-026 | P2 | F | Weight/volume default placeholders 1 | Saved 1 when left empty |
| PRD-027 | P2 | E | Weight 0 | Accepted; landed-cost by weight excludes it (verify IMP) |
| PRD-028 | P2 | F | HS code free text | Saved |
| PRD-029 | P1 | F | Opening stock: qty 50, cost 1500 | Product saved AND stock 50 @ 1,500 = Rs 75,000 in Stock tab; notice "Increased stock for 1 product" |
| PRD-030 | P1 | D | Opening stock journal | Dr Inventory 75,000 / Cr Opening balance equity (3000) |
| PRD-031 | P1 | N | Opening qty 50, cost empty | Product saved; error "Product saved, but the opening stock was not booked: Amount must be greater than zero. …"; product exists with 0 stock |
| PRD-032 | P2 | N | Opening qty 0, cost 500 | No stock movement; product saved silently |
| PRD-033 | P2 | N | Opening qty `-3` | Blocked by min 0 |
| PRD-034 | P2 | E | Opening qty `0.5` kg | Accepted (step 0.0001) |
| PRD-035 | P2 | E | Opening qty `0.00001` | Rounds to 0 at 4 dp → treated as no stock or refused; no negative value |
| PRD-036 | P2 | F | Two warehouses: warehouse select shown | Yes; one warehouse: hidden |
| PRD-037 | P2 | F | Opening stock into second warehouse | Stock shows in that warehouse only |
| PRD-038 | P2 | N | Opening stock while the current month is locked | Product saved; stock refused "Accounting period YYYY-MM is locked." |
| PRD-039 | P2 | S | Warehouse Manager limited to branch A chooses warehouse in branch B | "This warehouse is outside your permitted branches." |
| PRD-040 | P2 | F | Edit existing product | No Opening stock section |
| PRD-041 | P2 | F | Edit shows stored price `2400` not `2400.0000` | Yes |
| PRD-042 | P2 | F | Edit SKU to another product's SKU | "SKU … already exists." |
| PRD-043 | P2 | F | Edit price | Future invoices prefill new price; posted documents unchanged |
| PRD-044 | P2 | F | Edit archived product keeps archived flag | Yes |
| PRD-045 | P1 | F | Archive product | Moves to Archived filter; hidden from invoice product list |
| PRD-046 | P1 | N | Create invoice line with archived product via API | "{name} is archived. Restore it first." |
| PRD-047 | P2 | F | Restore product | Back in active list |
| PRD-048 | P2 | F | Archive product with stock on hand | Allowed; stock valuation still counts it |
| PRD-049 | P2 | S | Salesperson tries to archive | Button absent; API "Your role does not permit this action." |
| PRD-050 | P2 | F | Search products by SKU fragment | Case-insensitive match |
| PRD-051 | P2 | F | Search by name with Urdu | Works |
| PRD-052 | P2 | F | Status filter Active/Archived/All | Counts correct |
| PRD-053 | P2 | F | Clear filters link | Resets |
| PRD-054 | P2 | U | Table on phone | Horizontal scroll hint; first column bold |
| PRD-055 | P1 | F | Export CSV | File `items-YYYY-MM-DD.csv`, headers from spec, one row per visible product |
| PRD-056 | P2 | F | Export with filters applied | Only visible rows |
| PRD-057 | P2 | F | Export when list empty | Button disabled |
| PRD-058 | P2 | E | Export product with comma and quotes in name | CSV properly quoted |
| PRD-059 | P2 | E | Export Unicode | UTF-8 BOM or plain UTF-8 opens in Excel correctly |
| PRD-060 | P1 | F | Import CSV: download template | Headers `sku,name,category,unit,price,cost,…`; example row |
| PRD-061 | P1 | F | Import 5 valid rows | Preview shows mapping; Import → 5 products |
| PRD-062 | P1 | F | Header auto-mapping "Item Code" → sku | Recognised |
| PRD-063 | P1 | N | Row with missing SKU | "Nothing was imported. Fix these rows…" with row number; zero imported |
| PRD-064 | P1 | N | Two rows with same SKU in file | "SKU X appears more than once in the file"; nothing imported |
| PRD-065 | P1 | N | Row SKU already exists (mode create) | "SKU X already exists"; nothing imported |
| PRD-066 | P2 | F | Mode update: existing SKU rows | Updated in place; new ones created |
| PRD-067 | P2 | N | Price `abc` in a row | Row error; nothing imported |
| PRD-068 | P2 | N | Negative price row | Row error |
| PRD-069 | P2 | E | 500 rows | Imported; list responsive |
| PRD-070 | P2 | E | 501+ rows | Clear limit message or chunked; no timeout |
| PRD-071 | P2 | E | Empty file | "No rows" message |
| PRD-072 | P2 | E | File with only headers | Same |
| PRD-073 | P2 | E | Windows line endings | Parsed |
| PRD-074 | P2 | E | Semicolon-delimited file | Not parsed as columns → clear mapping failure, not silent garbage |
| PRD-075 | P2 | E | Excel `.xlsx` chosen | Refused by type |
| PRD-076 | P2 | E | 20 MB CSV | Refused or streamed; no browser freeze |
| PRD-077 | P2 | E | Quoted fields with embedded commas and newlines | Parsed correctly |
| PRD-078 | P2 | E | UTF-8 BOM at start | First header still mapped |
| PRD-079 | P2 | E | Required column unmapped | Import button disabled with hint listing required columns |
| PRD-080 | P2 | F | Error list shows at most 20 rows then "…and N more" | Yes |
| PRD-081 | P2 | S | Import as Salesperson | Button absent; API refused |
| PRD-082 | P2 | D | Import never creates stock | Correct; opening stock is set separately |
| PRD-083 | P2 | D | Import is atomic | One bad row → zero rows created (verified by count) |
| PRD-084 | P2 | D | Import idempotency: retry same key | No duplicates |
| PRD-085 | P2 | F | View product (Stock tab → View) | Item details: stock by warehouse, movement history |
| PRD-086 | P2 | F | Item details → Set quantity (count correction) | See INV cases; from product context works |
| PRD-087 | P2 | U | Required asterisks on SKU, name, price | Yes |
| PRD-088 | P2 | U | Placeholders grey, typed values dark | Yes |
| PRD-089 | P2 | U | "Opening stock" section separated by a rule | Yes |
| PRD-090 | P2 | U | Dialog on phone is a bottom sheet with sticky actions | Yes |
| PRD-091 | P2 | F | Cancel after typing | Nothing saved |
| PRD-092 | P2 | F | Escape closes | Nothing saved |
| PRD-093 | P2 | F | Submit with Enter in SKU field | Saves |
| PRD-094 | P2 | E | Product name 120 chars; 121 refused | Yes |
| PRD-095 | P2 | E | Name with only spaces | Refused (trim → <2) |
| PRD-096 | P2 | F | Same name, different SKU | Allowed |
| PRD-097 | P2 | F | Product count in Settings → Features hide dialog | Matches |
| PRD-098 | P2 | X | 5,000 products | List search < 300 ms; invoice product select usable |
| PRD-099 | P2 | D | Price shown in list formatted `Rs 2,400` | Yes |
| PRD-100 | P1 | F | End to end: import 10 → set opening stock on two → sell one → export | Export reflects data; stock correct |

Covered by automation: `master-data.spec.ts` (create/edit/archive/import), `documents.spec.ts` (archived refusal), unit `master-data.test.ts`.

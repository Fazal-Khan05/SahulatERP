# 08 — Purchasing, foreign currency, supplier payments (PUR)

Chain: purchase order → goods receipt note (GRN) → supplier bill → supplier return. Currencies PKR, USD, CNY with exchange rate; PKR rate must be 1.

| ID | P | T | Case | Expected |
|---|---|---|---|---|
| PUR-001 | P1 | F | Purchasing → New purchase order, supplier, product, qty, "Submit purchase order" | Created and submitted; no stock, no ledger |
| PUR-002 | P1 | F | Save draft | Draft row |
| PUR-003 | P1 | N | Supplier empty | "Enter the supplier's name." |
| PUR-004 | P1 | F | New supplier name → "Save supplier?" Yes | Supplier created (Importer, 60? verify default 30 days) |
| PUR-005 | P1 | F | New supplier name → No | Booked to "Walk-in supplier"; typed name shown |
| PUR-006 | P1 | F | Currency USD, rate 280, line 100 × $10 | USD total 1,000; PKR equivalent 280,000 shown |
| PUR-007 | P1 | N | Currency USD, rate empty | "Amount must be greater than zero." (fxRate pos) |
| PUR-008 | P1 | N | Currency PKR, rate 280 | "PKR exchange rate must be 1." |
| PUR-009 | P2 | E | Rate 0.0001 | Accepted |
| PUR-010 | P2 | E | Rate 1e12 | Refused (below one trillion) |
| PUR-011 | P2 | N | Currency EUR via API | Validation (PKR/USD/CNY only) |
| PUR-012 | P2 | F | CNY order | Works like USD |
| PUR-013 | P2 | F | Rate placeholder "e.g. 280" shown when empty | Yes |
| PUR-014 | P1 | F | Submitted PO → Receive → GRN with full quantities | GRN draft; submit → stock in at PKR cost (price × rate) |
| PUR-015 | P1 | F | Receive part (40 of 100) | GRN for 40; PO shows 60 remaining on next Receive |
| PUR-016 | P1 | N | Receive 61 when 60 remain | "Converted quantity exceeds the remaining source quantity." |
| PUR-017 | P1 | F | Receive remaining 60 | PO fully received; Receive button gone |
| PUR-018 | P1 | F | GRN submit journal | Dr 1200 inventory / Cr GRNI or 2000 payable (verify account) at PKR value |
| PUR-019 | P1 | F | GRN → Invoice → supplier bill submit | Payable in USD at the bill's rate; PKR value posted |
| PUR-020 | P2 | F | Bill rate differs from GRN rate | Difference posted to FX gain/loss (verify account) |
| PUR-021 | P2 | N | Convert GRN with different currency via API | "Source party, warehouse and currency must match." |
| PUR-022 | P2 | N | Convert PO directly to bill via API | "Invalid document conversion." |
| PUR-023 | P2 | N | Convert a draft PO | "Submit the source document first." |
| PUR-024 | P1 | F | Supplier return on a bill (1 unit) | PR-… submitted; stock −1; payable reduced |
| PUR-025 | P1 | N | Return more than received | "Return exceeds the unreturned quantity." |
| PUR-026 | P2 | N | Return on a GRN (not bill) | "Select a submitted sales or supplier invoice." |
| PUR-027 | P2 | N | Return when the stock was already sold | "Insufficient stock for …" |
| PUR-028 | P1 | F | Supplier payments → Record payment USD 1,000 allocating to the bill | Bill paid; payable cleared |
| PUR-029 | P1 | F | "PKR actually paid" higher than rate value | Exchange loss posted automatically |
| PUR-030 | P1 | F | PKR paid lower | Exchange gain |
| PUR-031 | P1 | N | Allocation exceeds bill outstanding | "Allocation exceeds the invoice's outstanding balance." |
| PUR-032 | P1 | N | Allocations ≠ amount | "Allocations must equal the receipt amount." |
| PUR-033 | P2 | N | Same bill twice in allocations | "Duplicate allocation." |
| PUR-034 | P2 | N | Allocate to a bill of another supplier | "Receipt must reference submitted invoices for the same party." |
| PUR-035 | P2 | N | Allocate to a draft bill | Same |
| PUR-036 | P1 | S | Recovery Officer pays a supplier | "Recovery officers cannot pay suppliers." |
| PUR-037 | P2 | F | Payment method cash from Cash in hand | Cash account credited |
| PUR-038 | P2 | F | Payment method bank with account chosen | That bank credited |
| PUR-039 | P2 | F | Payment by cheque (outgoing) | Recorded; no cheque register state machine for outgoing? verify behaviour |
| PUR-040 | P2 | N | Payment amount 0 | Refused |
| PUR-041 | P2 | N | Payment in locked period | Refused |
| PUR-042 | P2 | F | Partial payment | Bill outstanding reduced; aged payables updated |
| PUR-043 | P2 | F | Two partial payments | Sum; second cannot exceed remaining |
| PUR-044 | P2 | F | Supplier statement | PO not shown; GRN/bill/return/payment with running balance |
| PUR-045 | P1 | S | Salesperson opens Purchasing | Not visible; API "Your role cannot create purchase documents." |
| PUR-046 | P1 | S | Sales Manager submits a PO | "Your role can submit sales documents only." |
| PUR-047 | P2 | S | Warehouse Manager creates PO | "Warehouse users can create receipts and deliveries only." |
| PUR-048 | P2 | S | Warehouse Manager submits GRN | Allowed |
| PUR-049 | P2 | S | Warehouse Manager submits bill | "Your role can submit warehouse documents only." |
| PUR-050 | P2 | S | Accountant full chain | Allowed |
| PUR-051 | P2 | F | PO print | Shows currency and rate; totals in USD and PKR |
| PUR-052 | P2 | F | Bill print | Supplier, due date by terms |
| PUR-053 | P2 | F | Due date = date + supplier terms | Yes |
| PUR-054 | P2 | F | Edit draft PO currency after lines | Totals recompute |
| PUR-055 | P2 | N | Submit PO in locked period | Refused |
| PUR-056 | P2 | F | Cancel draft GRN | Frees PO remaining |
| PUR-057 | P2 | N | Cancel submitted GRN | Refused; use return |
| PUR-058 | P2 | D | GRN with 3 lines, avg cost per product | Each product's avg updated independently |
| PUR-059 | P2 | D | Rounding: $0.3333 × 3 at 280 | PKR value rounded at 4 dp; journal balanced |
| PUR-060 | P2 | D | Payable control (2000) = open bills | Reconciled |
| PUR-061 | P2 | D | Input tax on bill with tax 18 | Dr 1500 input tax (verify code) |
| PUR-062 | P2 | F | Tax 0 on purchases | No tax line |
| PUR-063 | P2 | F | Discount on PO line | PKR value net of discount |
| PUR-064 | P2 | E | 100 lines PO | OK |
| PUR-065 | P2 | E | Qty 0.5 kg | OK |
| PUR-066 | P2 | F | Numbering PO-2026-0001, GRN-, BILL-, PR- | Yes |
| PUR-067 | P2 | F | Purchasing list filters by type/status/supplier/date | Yes |
| PUR-068 | P2 | F | Search by walk-in supplier typed name | Found |
| PUR-069 | P2 | F | Supplier payments tab lists payments | Yes with status |
| PUR-070 | P2 | F | Bill overdue in attention queue | Yes when past due |
| PUR-071 | P2 | F | Receive dialog shows remaining per line | Yes |
| PUR-072 | P2 | F | Receive dialog line set to 0 | Line skipped; at least one line >0 required |
| PUR-073 | P2 | N | Receive all lines 0 | Refused |
| PUR-074 | P2 | F | GRN warehouse = PO warehouse | Enforced |
| PUR-075 | P2 | F | Warehouse select on PO hidden when single | Yes |
| PUR-076 | P2 | F | Bill without GRN (direct bill) | Allowed? verify; if allowed, stock not moved |
| PUR-077 | P2 | F | Return on walk-in supplier bill | Works; typed name carried |
| PUR-078 | P2 | F | Supplier archived after PO | GRN conversion refused "archived. Restore it first." |
| PUR-079 | P2 | F | Product archived after PO | Conversion refused |
| PUR-080 | P2 | D | Idempotent retry of submit GRN | One stock move |
| PUR-081 | P2 | D | Idempotent retry of payment | One journal |
| PUR-082 | P2 | F | Payment note 1,000 chars; 1,001 refused | Yes |
| PUR-083 | P2 | F | Cheque number on outgoing cheque 100 chars | Yes |
| PUR-084 | P2 | U | Payment dialog shows open bills with outstanding | Oldest first; amount spreads oldest-first on typing total |
| PUR-085 | P2 | U | "PKR actually paid" only for non-PKR bills | Yes |
| PUR-086 | P2 | U | Editor on phone | Usable |
| PUR-087 | P2 | S | Branch-limited Accountant submits GRN in other branch | Refused |
| PUR-088 | P2 | F | Hidden Purchasing | View gone; API refused |
| PUR-089 | P2 | F | Imports off: no shipment button on GRN | Correct |
| PUR-090 | P2 | F | Imports on: "Create shipment" available for submitted GRN/bill | Yes (see IMP) |
| PUR-091 | P2 | D | FX: bill at 280, payment at 285 for $1,000 | Loss 5,000 posted; payable cleared exactly |
| PUR-092 | P2 | D | FX: payment at 275 | Gain 5,000 |
| PUR-093 | P2 | D | Partial FX payments at different rates | Each computes vs bill rate on allocated portion |
| PUR-094 | P2 | E | Rate with 4 decimals 280.1234 | Stored |
| PUR-095 | P2 | E | Rate 5 decimals | Rounded to 4 |
| PUR-096 | P2 | F | Supplier payment print (voucher) | "Payment voucher" title |
| PUR-097 | P2 | X | 500 POs in list | Filters < 1 s |
| PUR-098 | P2 | F | Overview shows purchases? | Not required; verify no error |
| PUR-099 | P2 | F | Aged payables report after chain | Buckets correct |
| PUR-100 | P1 | F | End to end: USD PO → two GRNs → bill → return 1 → payment with FX loss; reconciliation reconciled | All pass |

Covered by automation: `documents.spec.ts` (PO→GRN→bill), `cash-bank-reports.spec.ts` (payments), unit `workflows.test.ts`.

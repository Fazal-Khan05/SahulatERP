# 07 — Sales documents and the invoice editor (SAL)

Chain: quotation → sales order → delivery note → sales invoice → credit note (return). Direct invoice allowed. Submit posts stock (delivery or direct invoice) and ledger.

| ID | P | T | Case | Expected |
|---|---|---|---|---|
| SAL-001 | P1 | F | Sales → New invoice: customer, product, qty 1, "Submit sales invoice" | Created and submitted in one click; row "Submitted"; stock −1; journal posted |
| SAL-002 | P1 | F | Same with "Save draft" | Row "Draft"; no stock or journal effect |
| SAL-003 | P1 | F | Submit from the list on a draft | Submitted |
| SAL-004 | P1 | F | Submit from document details | Submitted |
| SAL-005 | P1 | N | Submit with insufficient stock | Editor keeps draft; red "Saved as a draft but not submitted. Insufficient stock for … Requested: 9, available: 5." |
| SAL-006 | P1 | F | Fix qty and press Submit again | Same draft updated and submitted; exactly one row |
| SAL-007 | P1 | N | Empty customer | "Enter the customer's name." |
| SAL-008 | P1 | N | No product line | "Add at least one product line." |
| SAL-009 | P1 | N | Product chosen, qty empty | "Enter a quantity on line 1." |
| SAL-010 | P1 | N | Qty 0 | Same |
| SAL-011 | P2 | N | Qty negative | Blocked by min; API "Amount must be greater than zero." |
| SAL-012 | P2 | E | Qty 0.0001 | Accepted |
| SAL-013 | P2 | E | Qty 0.00001 | Rounds to 0 → refused |
| SAL-014 | P2 | E | Qty 1,000,000 with stock | Accepted if stock |
| SAL-015 | P1 | F | Price prefilled from product | Yes; editable |
| SAL-016 | P2 | F | Product with price 0 | Price field empty with placeholder 0.00 |
| SAL-017 | P2 | E | Price empty on submit | Treated as 0; line total 0 |
| SAL-018 | P2 | E | Price negative | Blocked/refused |
| SAL-019 | P2 | F | Discount 10% | Line total ×0.9 |
| SAL-020 | P2 | E | Discount 100% | Line total 0 |
| SAL-021 | P2 | N | Discount 101 | Blocked max 100; API refused |
| SAL-022 | P2 | F | Tax 18 | Tax = net×18%; totals update live |
| SAL-023 | P2 | E | Tax 0 and blank | Both 0 |
| SAL-024 | P2 | N | Tax 150 | Refused |
| SAL-025 | P2 | F | Default tax from settings prefilled on sales lines | Yes when configured |
| SAL-026 | P1 | N | Same product on two lines | "Use one line per product." |
| SAL-027 | P2 | F | Add line / remove line | Totals recalc; cannot remove last line? (verify: can, then "Add at least one") |
| SAL-028 | P2 | E | 100 lines | Accepted; 101 refused |
| SAL-029 | P2 | F | Salesperson column for sales | Employee select; required for Salesperson role (own id) |
| SAL-030 | P1 | S | Salesperson role creates invoice with another salesperson on a line | "Salespeople can create their own sales only." |
| SAL-031 | P1 | S | Salesperson edits another's draft | "Salespeople can edit their own drafts only." |
| SAL-032 | P1 | S | Salesperson submits an invoice | "Sales documents require manager approval." (or allowed per role matrix — assert actual) |
| SAL-033 | P2 | S | Warehouse Manager creates invoice | "Warehouse users can create receipts and deliveries only." |
| SAL-034 | P2 | S | Recovery Officer creates invoice | Refused |
| SAL-035 | P2 | S | Accountant creates and submits invoice | Allowed |
| SAL-036 | P1 | F | Quotation → Submit → Convert → sales order | Lines copied; parentId set; chain shown |
| SAL-037 | P1 | N | Convert a draft quotation | "Submit the source document first." |
| SAL-038 | P1 | F | Sales order → Deliver part of a line | Delivery note draft with the entered quantities |
| SAL-039 | P1 | N | Deliver more than remaining | "Converted quantity exceeds the remaining source quantity." |
| SAL-040 | P1 | F | Deliver remaining later | Second delivery; order fully delivered; no more Deliver button |
| SAL-041 | P1 | F | Submit delivery | Stock out; COGS posted; no receivable yet |
| SAL-042 | P1 | F | Delivery → Invoice | Invoice draft from delivery; submitting does NOT move stock again |
| SAL-043 | P1 | F | Direct invoice (no delivery) submit | Moves stock |
| SAL-044 | P2 | N | Convert invoice | "This document cannot be converted." |
| SAL-045 | P2 | N | Convert with different warehouse on child via API | "Source party, warehouse and currency must match." |
| SAL-046 | P2 | N | Convert quotation directly to delivery via API | "Invalid document conversion." |
| SAL-047 | P2 | F | Cancel a draft with reason | Status cancelled; reason appended to notes; parent quantity freed |
| SAL-048 | P1 | N | Cancel a submitted invoice | "Only draft documents can be cancelled. Use a return or reversal for posted documents." |
| SAL-049 | P1 | N | Edit a submitted invoice | "Only draft documents can be edited…" |
| SAL-050 | P1 | N | Submit twice (double click / retry) | "Only draft documents can be submitted." or idempotent no-op; one journal |
| SAL-051 | P1 | F | Return 1 unit, reason damaged | Credit note CN-… submitted; stock +1; invoice returned amount; balance reduced |
| SAL-052 | P1 | N | Return more than unreturned | "Return exceeds the unreturned quantity." |
| SAL-053 | P2 | N | Return same line twice in one request | "Duplicate return line." |
| SAL-054 | P2 | F | Return all lines | Balance due 0; credit note total = invoice |
| SAL-055 | P2 | F | Return after partial payment | Overpaid → "Customer credit" shown negative balance |
| SAL-056 | P2 | N | Return on a draft invoice | "Select a submitted sales or supplier invoice." |
| SAL-057 | P2 | F | Credit note print | Shows typed/customer name, lines, reason |
| SAL-058 | P2 | D | Return journal | Reverses revenue, tax, receivable and COGS/stock proportionally |
| SAL-059 | P2 | F | Invoice date in the future | Accepted; due date computed |
| SAL-060 | P2 | N | Invoice in locked period | "Accounting period YYYY-MM is locked." |
| SAL-061 | P2 | N | Due date before date | Accepted or refused consistently (document) |
| SAL-062 | P2 | E | Date `2026-13-01` | Validation |
| SAL-063 | P2 | F | Notes 2,000 chars; 2,001 refused | Yes |
| SAL-064 | P2 | E | Notes with newlines | Printed with line breaks |
| SAL-065 | P1 | F | Numbering INV-2026-0001, 0002 … per year | Sequential; gaps only from cancellations? (cancelled keeps its number) |
| SAL-066 | P2 | D | Two users create invoices simultaneously | Distinct numbers; one revision conflict retried transparently |
| SAL-067 | P2 | F | Document list filters: type, status, customer, dates, search | Combine correctly; Clear filters |
| SAL-068 | P2 | F | Search by typed walk-in name | Found |
| SAL-069 | P2 | F | List ordering newest first | Yes |
| SAL-070 | P2 | F | View → details: chain, lines, totals, payments, returns | Correct |
| SAL-071 | P2 | F | Details Print button | Opens print view |
| SAL-072 | P2 | F | Edit a draft: change customer | Allowed; credit check on submit uses new customer |
| SAL-073 | P2 | F | Edit a draft: remove all lines and save | Refused |
| SAL-074 | P2 | U | Editor on phone | Bottom sheet; line table scrolls horizontally; sticky actions |
| SAL-075 | P2 | U | Three buttons: Cancel, Save draft (outline), Submit (violet) | Yes |
| SAL-076 | P2 | U | Spinner on the pressed button only | Yes |
| SAL-077 | P2 | U | Placeholders Qty / 0.00 / 0 / 0 | Yes |
| SAL-078 | P2 | U | Unit hint under qty after product chosen | Yes |
| SAL-079 | P2 | U | Line total and Net/Tax/Total formatting | `Rs 4,500` |
| SAL-080 | P2 | F | Escape closes editor with unsaved changes | Closes (no confirm) — document |
| SAL-081 | P2 | F | Overview "Recent sales" shows last 5 | Yes with walk-in names |
| SAL-082 | P2 | F | Overview metric "Total sales" | Sum of submitted invoices net of returns |
| SAL-083 | P2 | F | Credit limit path (see PTY-012/013) | Works from editor with owner reason field visible only for Owner + matched customer with limit |
| SAL-084 | P2 | D | Tax snapshot stored on invoice | Registered flag/tax id frozen |
| SAL-085 | P2 | D | Invoice `paid` updates on receipt | Yes; `outstanding` = total − paid − returned |
| SAL-086 | P2 | D | Journal for invoice: Dr 1100 total / Cr 4000 net / Cr 2100 tax; plus Dr 5000 / Cr 1200 cost on direct | Yes |
| SAL-087 | P2 | D | Journal memo and source = invoice id | Yes |
| SAL-088 | P2 | F | Quotation has no stock or ledger effect on submit | Correct |
| SAL-089 | P2 | F | Sales order submit no stock effect | Correct |
| SAL-090 | P2 | F | Delivery note print | Quantities, no prices? (verify design) |
| SAL-091 | P2 | F | Convert order with multiple products partially twice | Remaining tracked per line |
| SAL-092 | P2 | F | Cancel a delivery draft frees order quantity | Yes |
| SAL-093 | P2 | N | Submit a document whose product was archived after drafting | "{name} is archived. Restore it first." on submit? (engine checks at create; verify submit path) |
| SAL-094 | P2 | S | Salesperson sees only own documents in list | Yes (scopeWorkspace) |
| SAL-095 | P2 | S | Sales Manager sees all | Yes |
| SAL-096 | P2 | F | Commission splits via API totalling 90% | "Commission splits must total 100%." |
| SAL-097 | P2 | X | Invoice with 100 lines submit | < 3 s |
| SAL-098 | P2 | F | Hidden Sales module | Sales view gone; API refused |
| SAL-099 | P2 | F | Invoice for a customer in another branch (branch-limited member) | "This branch is outside your permitted branches." |
| SAL-100 | P1 | F | End to end: quotation → order → two deliveries → invoice → partial return → receipt; reconciliation reconciled | All pass |

Covered by automation: `documents.spec.ts` (full cycle, walk-in, credit limit), `qa-regression.spec.ts`, unit `documents.test.ts`, `workflows.test.ts`.

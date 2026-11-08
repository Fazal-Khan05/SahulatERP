# 05 — Customers and suppliers, walk-in names, credit limits (PTY)

Fields: name*, type, city, phone, email, tax id, registered (sales-tax), credit limit (0 = none), terms (days), customer class.

| ID | P | T | Case | Expected |
|---|---|---|---|---|
| PTY-001 | P1 | F | Sales → Customers → New customer, name only | Saved with defaults |
| PTY-002 | P1 | N | Name empty / 1 char | Refused |
| PTY-003 | P1 | N | Duplicate customer name (case-insensitive) | "A customer named X already exists." |
| PTY-004 | P2 | F | Same name as a supplier | Allowed (types are separate) |
| PTY-005 | P2 | E | Name with trailing spaces | Trimmed; duplicate check on trimmed |
| PTY-006 | P2 | E | Name 120 chars | Accepted; longer refused |
| PTY-007 | P2 | F | Terms 0 days | Due date = invoice date |
| PTY-008 | P2 | F | Terms 365 | Due date a year later |
| PTY-009 | P2 | N | Terms -1 | Refused |
| PTY-010 | P2 | N | Terms 2.5 | Refused (integer) |
| PTY-011 | P1 | F | Credit limit 0 | No credit check on invoices |
| PTY-012 | P1 | F | Credit limit 100,000; outstanding 90,000; new invoice 20,000 | "Customer credit limit exceeded. An owner must enter an override reason." |
| PTY-013 | P1 | F | Same with Owner override reason | Submits; reason stored on invoice |
| PTY-014 | P1 | S | Accountant supplies override reason | Still refused (owner only) |
| PTY-015 | P2 | E | Limit exactly equal to exposure + invoice | Allowed (not exceeded) |
| PTY-016 | P2 | E | Limit exceeded by 0.0001 | Refused |
| PTY-017 | P2 | F | Credit check counts only submitted invoices minus paid/returned | Verified with a return |
| PTY-018 | P2 | F | Credit check ignores drafts | Yes |
| PTY-019 | P2 | F | Registered = true with tax id | Tax snapshot on invoice marks registered |
| PTY-020 | P2 | F | Registered = true, tax id empty | Allowed or hinted; print shows blank |
| PTY-021 | P2 | F | Customer class Retailer/Wholesaler/… | Used by class-based commission plans |
| PTY-022 | P2 | E | Email invalid | Saved as text (no strict validation) or validated consistently |
| PTY-023 | P2 | E | Phone `0300-1234567` | Saved; printed |
| PTY-024 | P2 | F | Edit customer type via API customer→supplier | "A party's type cannot be changed." |
| PTY-025 | P1 | F | Archive customer | Hidden from invoice suggestions |
| PTY-026 | P1 | N | Create document for archived customer via API | "{name} is archived. Restore it first." |
| PTY-027 | P2 | F | Archive customer with outstanding balance | Allowed; receivables still include them (verify report) |
| PTY-028 | P2 | F | Restore | Back in suggestions |
| PTY-029 | P2 | S | Recovery Officer creates customer | Allowed? Access list: save_party = Accountant, Sales Manager, Warehouse Manager (+Owner). Recovery Officer refused |
| PTY-030 | P2 | S | Salesperson creates customer | Refused via API; invoice editor "Yes, save customer" fails with message, "No" path still works |
| PTY-031 | P1 | F | Invoice editor: type existing name exactly | Matched; hint shows city/phone/terms; no prompt |
| PTY-032 | P1 | F | Type existing name in different case | Matched |
| PTY-033 | P1 | F | Type a new name, Submit | "Save customer?" dialog with No/Yes |
| PTY-034 | P1 | F | Yes, save customer | Customer created with city/phone; invoice booked to it |
| PTY-035 | P1 | F | No, don't save | Invoice booked to "Walk-in customer"; typed name shown in list and on print; no customer created |
| PTY-036 | P1 | F | First "No" ever | "Walk-in customer" account created automatically |
| PTY-037 | P1 | F | Second "No" | Reuses the same walk-in account (count stays 1) |
| PTY-038 | P2 | F | Walk-in customer archived, then "No" | Error "Walk-in customer is archived. Restore it in Sales → Customers first." |
| PTY-039 | P2 | F | Type "Walk-in customer" exactly | Matches the shared account; no prompt; no display name |
| PTY-040 | P2 | F | "No" then submit fails (stock) and retry | No second prompt; same draft updated |
| PTY-041 | P2 | F | Change the name after answering | Prompt asked again for the new name |
| PTY-042 | P2 | F | Edit a walk-in draft | Name field shows typed name; saving keeps it |
| PTY-043 | P2 | F | Convert walk-in order → delivery → invoice | Typed name carried |
| PTY-044 | P2 | F | Return on walk-in invoice | Credit note shows typed name |
| PTY-045 | P2 | F | Receipt for a walk-in invoice | Choose "Walk-in customer"; open invoices listed by number |
| PTY-046 | P2 | F | Customer statement for Walk-in customer | All walk-in invoices together (documented) |
| PTY-047 | P2 | F | Search "Rashid" after a walk-in sale | Invoice found by typed name |
| PTY-048 | P2 | E | Typed name equals an existing customer but with extra inner spaces | Not matched (exact trimmed compare) → prompt; acceptable |
| PTY-049 | P2 | E | Typed name 121 chars | Refused by API max 120 with message |
| PTY-050 | P2 | E | Typed name with `<b>` | Printed as text |
| PTY-051 | P2 | F | Supplier editor: same flow with "Save supplier?" and "Walk-in supplier" | Yes |
| PTY-052 | P2 | F | New supplier via PO "Yes" | Supplier created with class Importer, 30-day terms |
| PTY-053 | P2 | F | Cancel the Save dialog (X) | Back to editor; nothing saved |
| PTY-054 | P2 | U | Dialog copy mentions the typed name and walk-in account | Yes |
| PTY-055 | P2 | U | Hint under name: "New customer. You can choose whether to save them." | Yes |
| PTY-056 | P2 | F | City and phone optional fields appear only for new names | Yes |
| PTY-057 | P2 | F | Customer list search by city | Works |
| PTY-058 | P1 | F | Export customers CSV | Correct columns |
| PTY-059 | P1 | F | Import customers CSV valid | Created |
| PTY-060 | P1 | N | Import duplicate name in file | "customer X appears more than once in the file" |
| PTY-061 | P1 | N | Import existing name (create mode) | "customer X already exists" |
| PTY-062 | P2 | F | Import update mode | Updates by name |
| PTY-063 | P2 | N | Import credit limit `abc` | Row error |
| PTY-064 | P2 | N | Import terms `-5` | Row error |
| PTY-065 | P2 | E | Import registered `yes/true/1` | All accepted as true |
| PTY-066 | P2 | E | Import 500 customers | OK |
| PTY-067 | P2 | F | Suppliers list under Purchasing | Separate tab |
| PTY-068 | P2 | F | Supplier terms 60 → bill due date | +60 days |
| PTY-069 | P2 | F | Supplier credit limit field | Ignored for purchases (no supplier credit check) — verify no error |
| PTY-070 | P2 | F | Customer with 0-day terms on quotation | Due date same day; no validity logic |
| PTY-071 | P2 | F | Delete customer | No delete; archive only (verify no delete control) |
| PTY-072 | P2 | D | Archiving customer keeps historical invoices and statements | Yes |
| PTY-073 | P2 | F | Count in Settings → Features (customers) | Matches including archived? Verify spec: counts all |
| PTY-074 | P2 | U | Customers table phone column on phone width | Scrolls |
| PTY-075 | P2 | F | Receipt dialog lists only customers (not suppliers) | Yes |
| PTY-076 | P2 | F | Payment dialog lists only suppliers | Yes |
| PTY-077 | P2 | F | Follow-up dialog lists customers only | Yes |
| PTY-078 | P2 | S | Salesperson sees customers list | Allowed (view) |
| PTY-079 | P2 | S | Warehouse Manager archives customer | Allowed per access list |
| PTY-080 | P2 | E | Credit limit `1e12` | Refused (below one trillion rule) |
| PTY-081 | P2 | E | Credit limit `0.5` | Accepted |
| PTY-082 | P2 | F | Credit override reason 500 chars; 501 refused | Yes |
| PTY-083 | P2 | F | Override reason empty string with limit exceeded | Refused |
| PTY-084 | P2 | F | Credit limit exceeded on quotation | No check (only sales_invoice) |
| PTY-085 | P2 | F | Credit limit exceeded on sales order | Verify product rule: check applies to invoice only |
| PTY-086 | P2 | F | Customer renamed after invoices | Lists and statements show new name; printed PDFs regenerated show new name (no snapshot) — document |
| PTY-087 | P2 | F | Walk-in customer renamed by user | New "No" sales create a fresh "Walk-in customer" (name match) — document behaviour |
| PTY-088 | P2 | F | Two customers "Ali Traders" and "Ali Traders Ltd" | Typing "Ali Traders" matches the exact one |
| PTY-089 | P2 | U | Datalist suggestions show city · phone | Yes |
| PTY-090 | P2 | U | Suggestions on iOS Safari | Datalist works or free text still saves |
| PTY-091 | P2 | F | Paste a name with newline | Trimmed |
| PTY-092 | P2 | S | `save_party` with type `employee` | Validation error |
| PTY-093 | P2 | S | `save_party` for another tenant's id | Not found in this tenant |
| PTY-094 | P2 | D | Audit shows party creations from the invoice path | Yes (save_party command) |
| PTY-095 | P2 | F | Customer class free text `VIP` | Saved; commission class plan can reference |
| PTY-096 | P2 | E | Tax id with spaces | Saved as typed |
| PTY-097 | P2 | F | Registered customer tax snapshot on invoice after customer changes to unregistered | Old invoice snapshot unchanged |
| PTY-098 | P2 | X | 10,000 customers | Suggestion datalist still usable (or capped with search) |
| PTY-099 | P2 | F | Supplier statement | Bills, returns, payments with running balance |
| PTY-100 | P1 | F | End to end: new customer via invoice "Yes", limit 50,000, invoice 60,000 refused, override by owner, receipt clears | All pass; statement balances |

Covered by automation: `documents.spec.ts` (Yes/No, credit limit), `master-data.spec.ts`, unit `documents.test.ts`, `master-data.test.ts`.

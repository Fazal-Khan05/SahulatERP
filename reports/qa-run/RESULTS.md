# SahulatERP SQA run — results

Generated 2026-10-14 15:03 UTC from `npm run test:qa` and the QA browser pass.

| Area | Cases | Pass | Fail | Browser not yet run | Manual only | Missing |
|---|---|---|---|---|---|---|
| Sign-in, password reset, sessions (AUTH) | 100 | 75 | 7 | 0 | 18 | 0 |
| Onboarding wizard and provisioning (ONB) | 100 | 93 | 6 | 0 | 1 | 0 |
| Settings: company & documents, features, access, audit (SET) | 100 | 97 | 3 | 0 | 0 | 0 |
| Products, opening stock, CSV import/export (PRD) | 100 | 94 | 6 | 0 | 0 | 0 |
| Customers and suppliers, walk-in names, credit limits (PTY) | 100 | 96 | 3 | 0 | 1 | 0 |
| Inventory: stock, transfers, corrections, valuation, warehouses (INV) | 100 | 98 | 2 | 0 | 0 | 0 |
| Sales documents and the invoice editor (SAL) | 100 | 98 | 1 | 0 | 1 | 0 |
| Purchasing, foreign currency, supplier payments (PUR) | 100 | 93 | 7 | 0 | 0 | 0 |
| Imports and landed cost (IMP) | 100 | 94 | 6 | 0 | 0 | 0 |
| Collections: receipts, cheques (PDC), follow-ups (COL) | 100 | 96 | 4 | 0 | 0 | 0 |
| Cash and bank (CSH) | 100 | 96 | 3 | 0 | 1 | 0 |
| Commissions (COM) | 100 | 100 | 0 | 0 | 0 | 0 |
| Payroll (PAY) | 100 | 94 | 6 | 0 | 0 | 0 |
| Accounting: journals, reversals, periods, invariants (ACC) | 100 | 97 | 3 | 0 | 0 | 0 |
| Reports and CSV export (RPT) | 100 | 92 | 7 | 0 | 1 | 0 |
| Printing, PDF and document view (PRN) | 100 | 85 | 13 | 0 | 2 | 0 |
| Shell: navigation, search, notifications, workspace switcher, Overview (NAV) | 100 | 87 | 10 | 0 | 3 | 0 |
| Security, tenancy, roles, API (SEC) | 100 | 81 | 8 | 0 | 11 | 0 |
| Responsive, mobile, accessibility, motion (UIX) | 100 | 71 | 14 | 0 | 15 | 0 |
| Data integrity, concurrency, failure recovery, migrations (DAT) | 100 | 92 | 5 | 0 | 3 | 0 |
| **Total** | **2000** | **1829** | **114** | **0** | **57** | **0** |

## Failures (114)

| ID | P | Case | Failing test | First error line |
|---|---|---|---|---|
| AUTH-019 | P1 | Sign out from the sidebar profile button | AUTH-019 [browser] sign out from sidebar profile returns to login; Back does not show workspace content | Error: [2mexpect([22m[31mlocator[39m[2m).[22mtoHaveCount[2m([22m[32mexpected[39m[2m)[22m failed |
| AUTH-032 | P2 | Forgot password with empty email | AUTH-032 forgot password with empty email is validated client-side before any request [defect] | AssertionError: expected 'async function reset() {\n    setBusy…' to match /if\s*\(\s*!email/ |
| AUTH-049 | P2 | Sign out in one tab, act in another tab | AUTH-049 [browser] sign out in one tab; other tab next command gets 401 and shows login | Error: [2mexpect([22m[31mlocator[39m[2m).[22mtoBeVisible[2m([22m[2m)[22m failed |
| AUTH-061 | P2 | Sign in while offline | AUTH-061 [browser] sign in offline shows network error; retry works online | Error: offline message was "Failed to fetch" |
| AUTH-065 | P2 | Cookies | AUTH-065 session cookies are HttpOnly; no token in localStorage [defect] | AssertionError: expected false to be true // Object.is equality |
| AUTH-083 | P3 | Loading state on first paint before hydration | AUTH-083 controls are disabled until hydrated so no click is lost [defect: login "Sign in securely" is enabled in server HTML; workbench nav is disabled] | AssertionError: expected '<main class="login-shell"><section cl…' to match /<button type="submit"[^>]*disabled=""/ |
| AUTH-084 | P2 | Refresh on `/account/reset` after a successful change | AUTH-084 [browser] refresh /account/reset after success shows expired/complete state | Error: [2mexpect([22m[31mlocator[39m[2m).[22mtoHaveCount[2m([22m[32mexpected[39m[2m)[22m failed |
| ONB-061 | P2 | Reduced motion | ONB-061 [browser] reduced motion: provisioning lines without stagger, slow ring | Error: ring animation under reduced motion: {"duration":"1e-05s","count":"1"} |
| ONB-067 | P2 | Card on 390px phone | ONB-067 [browser] setup card at 390px: full screen, numbered steps, sticky footer, no horizontal scroll | Error: {"card":407,"page":407,"screen":390} |
| ONB-069 | P2 | Documents step on phone | ONB-069 [browser] Documents step on phone: preview below form, scrollable in card | Error: page width at 390 px |
| ONB-077 | P2 | `set_modules` with unknown key `crypto` | ONB-077 set_modules with unknown key "crypto" is a validation error [defect] | AssertionError: unknown module key should be refused, not silently dropped: expected undefined to be an instance of Error |
| ONB-088 | P2 | Owner finishes setup while a second member is on the card in another browser | ONB-088 [browser] owner finishes setup while a second member is on the card; the second member's next action shows the workspace | Error: {"overview":false,"card":1,"error":"Setup is already complete."} |
| ONB-093 | P2 | Logo upload while offline | ONB-093 [browser] logo upload while offline shows a clear error and can be retried | Error: offline upload message was "Failed to fetch" |
| SET-069 | P2 | Branding preview typography/colours match print | SET-069 [browser] branding preview typography/colours match print | Error: [2mexpect([22m[31mreceived[39m[2m).[22mtoEqual[2m([22m[32mexpected[39m[2m) // deep equality[22m |
| SET-075 | P2 | Settings → Features counts "N turned on" | SET-075 [browser] Settings → Features shows an "N turned on" count matching the switches (no such count found in FeaturesSettings; verify) | Error: [2mexpect([22m[31mlocator[39m[2m).[22mtoContainText[2m([22m[32mexpected[39m[2m)[22m failed |
| SET-085 | P2 | Default tax absent on new company | SET-085 new company has no default tax rate, so a line sent without a rate carries 0% tax (engine defaults an omitted taxRate to 18%) [browser part: placeholder 0] [defect] | AssertionError: expected '18.0000' to be '0.0000' // Object.is equality |
| PRD-014 | P2 | Price `abc` via API | PRD-014 price "abc" via API gives a validation error, not a raw library error [defect] | AssertionError: expected '[DecimalError] Invalid argument: abc' not to contain 'DecimalError' |
| PRD-016 | P2 | Price with 6 decimals `12.345678` | PRD-016 price with 6 decimals is stored at 4 dp, rounded half-up [defect] | AssertionError: expected '12.345678' to match /^12\.3457(0*)$/ |
| PRD-031 | P1 | Opening qty 50, cost empty | PRD-031 opening qty 50 with cost empty: product kept with 0 stock and the stock step refused "Amount must be greater than zero." [defect] | AssertionError: expected '[DecimalError] Invalid argument: ' to contain 'Amount must be greater than zero.' |
| PRD-035 | P2 | Opening qty `0.00001` | PRD-035 opening qty 0.00001 is refused or books nothing; never a zero-quantity movement carrying value [defect] | AssertionError: expected [ { …(8) } ] to deeply equal [] |
| PRD-076 | P2 | 20 MB CSV | PRD-076 [browser] 20 MB CSV is refused or parsed without freezing the browser | Error: longest main-thread block 3011 ms |
| PRD-095 | P2 | Name with only spaces | PRD-095 a name of only spaces is refused (trim → <2) [defect] | AssertionError: whitespace-only product name should be refused: expected undefined to be an instance of Error |
| PTY-030 | P2 | Salesperson creates customer | PTY-030 Salesperson: "Yes, save customer" is refused, and the "No" path still works on a company without a walk-in account [defect] | AssertionError: first "No" as Salesperson must not need save_party: expected 'Your role does not permit this action.' to be '' // Object.is equality |
| PTY-098 | P2 | 10,000 customers | PTY-098 [browser] 10,000 customers: suggestion datalist still usable (or capped with search) | Error: [2mexpect([22m[31mreceived[39m[2m).[22mtoBeLessThan[2m([22m[32mexpected[39m[2m)[22m |
| PTY-099 | P2 | Supplier statement | PTY-099 supplier statement shows bill, return and payment with a running balance (payment reduces the balance) [defect] | AssertionError: expected [ …(3) ] to deeply equal [ …(3) ] |
| INV-063 | P2 | Set quantity dialog shows current qty and value | INV-063 [browser] set-quantity dialog shows the current quantity and value | Error: stock value Rs 125,954.49 shown in the edit form |
| INV-086 | P2 | 2,000 products × 3 warehouses | INV-086 Stock tab for 2,000 products × 3 warehouses renders in under 2 s (server-side render alone measured 2.0–3.0 s) [browser part: real browser] [defect] | AssertionError: expected 7571.574729999999 to be less than 2000 |
| SAL-013 | P2 | Qty 0.00001 | SAL-013 qty 0.00001 (below 4 dp) is refused [defect] | AssertionError: create_document should be refused: expected undefined to be an instance of Error |
| PUR-007 | P1 | Currency USD, rate empty | PUR-007 USD with empty rate refused with a clear message [defect] | AssertionError: expected '[DecimalError] Invalid argument: ' to contain 'Amount must be greater than zero.' |
| PUR-020 | P2 | Bill rate differs from GRN rate | PUR-020 bill rate different from GRN rate posts the difference to FX and clears GRNI [defect] | AssertionError: expected '5000.0000' to be '0.0000' // Object.is equality |
| PUR-032 | P1 | Allocations ≠ amount | PUR-032 supplier payment whose amount differs from its allocations is refused [defect] | AssertionError: create_receipt should be refused: expected undefined to be an instance of Error |
| PUR-044 | P2 | Supplier statement | PUR-044 supplier statement: bill, return and payment with a correct running balance; PO not shown [case-corrected: GRNs are not listed either] [defect] | AssertionError: expected '417200.0000' to be '137200.0000' // Object.is equality |
| PUR-070 | P2 | Bill overdue in attention queue | PUR-070 [browser] overdue bill in the attention queue (code review: workbench.tsx attentionItems has no supplier-bill entry — likely fails) | Error: [2mexpect([22m[31mlocator[39m[2m).[22mtoHaveCount[2m([22m[32mexpected[39m[2m)[22m failed |
| PUR-085 | P2 | "PKR actually paid" only for non-PKR bills | PUR-085 [browser] "PKR actually paid" only for non-PKR bills (code review: document-dialogs.tsx shows it for every supplier payment — likely fails; see PUR-032) | Error: "PKR actually paid" shown for a supplier whose bills are all in PKR |
| PUR-095 | P2 | Rate 5 decimals | PUR-095 rate with 5 decimals is rounded to 4 [defect] | AssertionError: expected '280.12345' to be '280.1235' // Object.is equality |
| IMP-037 | P2 | Customs lookup (simulated) shows GD lookup result | IMP-037 [browser] customs/GD lookup (simulated) result (code review: no customs lookup exists anywhere in src — likely fails) | Error: [2mexpect([22m[31mlocator[39m[2m).[22mtoBeVisible[2m([22m[2m)[22m failed |
| IMP-054 | P2 | Add cost dialog placeholders | IMP-054 [browser] add-cost dialog: amount empty with placeholder (code review: no add-cost dialog found in src/components) | Error: [2mexpect([22m[31mlocator[39m[2m).[22mtoBeVisible[2m([22m[2m)[22m failed |
| IMP-055 | P2 | Classification help text | IMP-055 [browser] classification help text explains each class | Error: [2mexpect([22m[31mlocator[39m[2m).[22mtoContainText[2m([22m[32mexpected[39m[2m)[22m failed |
| IMP-056 | P2 | Search finds shipment by number/container | IMP-056 [browser] search finds shipment by number/container | Error: [2mexpect([22m[31mreceived[39m[2m).[22mtoEqual[2m([22m[32mexpected[39m[2m) // deep equality[22m |
| IMP-082 | P2 | Shipment list sorting newest first | IMP-082 [browser] shipment list sorted newest first | Error: [2mexpect([22m[31mreceived[39m[2m).[22mtoEqual[2m([22m[32mexpected[39m[2m) // deep equality[22m |
| IMP-083 | P2 | Filter by status | IMP-083 [browser] shipment filter by status | Error: [2mexpect([22m[31mlocator[39m[2m).[22mtoBeVisible[2m([22m[2m)[22m failed |
| COL-053 | P2 | Follow-up on supplier via API | COL-053 follow-up on a supplier via API is refused [defect] | AssertionError: follow_up should be refused: expected undefined to be an instance of Error |
| COL-075 | P2 | Receipts list filters by method/status | COL-075 [browser] receipts list filters by method/status | Error: [2mexpect([22m[31mlocator[39m[2m).[22mtoBeVisible[2m([22m[2m)[22m failed |
| COL-076 | P2 | Search by cheque number | COL-076 [browser] search by cheque number | Error: search results for cheque CHQ-1002 |
| COL-084 | P2 | 5,000 receipts | COL-084 [browser] 5,000 receipts: list and aging render < 2 s | Error: [2mexpect([22m[31mreceived[39m[2m).[22mtoBeLessThan[2m([22m[32mexpected[39m[2m)[22m |
| CSH-050 | P2 | Negative balance styled red | CSH-050 [browser] negative balance is styled red | Error: card colour rgb(41, 45, 52) is red |
| CSH-051 | P2 | Dialogs on phone | CSH-051 [browser] cash & bank dialogs open as bottom sheets on a phone | Error: Transfer between accounts |
| CSH-095 | P2 | Card hover lift only with mouse | CSH-095 [browser] card hover lift only with a mouse (no sticky hover on touch) | Error: no sticky hover styles after a tap on touch |
| PAY-025 | P2 | Reconcile = recreate run (cancel draft and create) | PAY-025 reconcile by recreating the run (cancel draft and create again) works [defect] | AssertionError: expected false to be true // Object.is equality |
| PAY-032 | P2 | Attendance 31 in file | PAY-032 attendance 31 in the file is a row error [defect] | AssertionError: import_records should be refused: expected undefined to be an instance of Error |
| PAY-062 | P2 | Settings → Payroll visible only with Payroll on | PAY-062 [browser] Settings → Payroll section visible only while Payroll is on | Error: Settings has a Payroll section while Payroll is on |
| PAY-063 | P2 | Lines table columns readable on phone | PAY-063 [browser] payroll lines table scrolls horizontally and stays readable on a phone | Error: a payroll lines table with one row per employee |
| PAY-064 | P2 | Status badges | PAY-064 [browser] payroll status badges use distinct colours | Error: four statuses, four colours |
| PAY-094 | P2 | Error wording for prototype rules | PAY-094 create_payroll success message has no "prototype" wording [defect] | AssertionError: expected 'Payroll calculated using prototype ru…' not to match /prototype/i |
| ACC-017 | P1 | Reverse an opening-balance journal | ACC-017 reversing an opening-balance journal is refused (demo opening balances and opening stock entered in-app) [defect] | AssertionError: inventory control after reversing opening stock: expected false to be true // Object.is equality |
| ACC-053 | P2 | Journal search by memo/number | ACC-053 [browser] journal search by memo or number | Error: a way to find JV-00003 by number |
| ACC-091 | P2 | Debit/credit columns aligned, tabular numerals | ACC-091 [browser] debit/credit columns aligned with tabular numerals | Error: Accounting trial balance "Net balance" aligned right |
| RPT-004 | P2 | Aged receivables as-of date in the past | RPT-004 aged receivables as of a past date excludes receipts made after that date [defect] | AssertionError: expected '0.0000' to be '1000.0000' // Object.is equality |
| RPT-011 | P2 | Statement print | RPT-011 [browser] statement print is branded with company header and period | Error: customer named on the printed statement |
| RPT-012 | P2 | Supplier statement | RPT-012 supplier statement: bills, returns and payments move the balance in the right direction [defect] | AssertionError: payment line: expected [ '400.0000', '', '1300.0000' ] to deeply equal [ '', '400.0000', '500.0000' ] |
| RPT-044 | P2 | Branch-limited Accountant: P&L | RPT-044 branch-limited Accountant: ledger reports are not offered (journals are not sent) [defect] | AssertionError: expected '\'use client\';\n\nimport { useEffect…' to match /const ledgerView=[^;]*branchIds/ |
| RPT-048 | P2 | Print a report | RPT-048 [browser] printing a report uses clean print CSS | Error: [2mexpect([22m[31mreceived[39m[2m).[22mtoEqual[2m([22m[32mexpected[39m[2m) // deep equality[22m |
| RPT-053 | P2 | Statement with bounced cheque | RPT-053 statement with a bounced cheque shows the receipt and its reversal [defect] | AssertionError: expected [ 'Sales invoice' ] to deeply equal [ 'Sales invoice', …(2) ] |
| RPT-072 | P2 | Sales analysis by salesperson with splits | RPT-072 sales analysis by salesperson with splits gives each person their share [defect] | AssertionError: expected [ [ 'Unassigned', '1000.0000' ] ] to deeply equal [ [ 'Hamza Khan', '600.0000' ], …(1) ] |
| PRN-016 | P2 | Qty 1,234,567 | PRN-016 quantity 1,234,567 printed with thousands separators [defect] | AssertionError: expected '<main class="print-page"><div class="…' to contain '1,234,567 pcs' |
| PRN-020 | P2 | Draft invoice print | PRN-020 draft invoice print shows a visible DRAFT status [defect] | AssertionError: expected 'SALES INVOICE INV-2026-0005 PRINT / S…' to contain 'DRAFT' |
| PRN-021 | P2 | Cancelled invoice print | PRN-021 cancelled invoice print shows CANCELLED [defect] | AssertionError: expected 'SALES INVOICE INV-2026-0006 PRINT / S…' to contain 'CANCELLED' |
| PRN-026 | P2 | Purchase order print | PRN-026 USD purchase order shows currency, rate and totals in both currencies [defect: amounts carry "Rs" and no PKR equivalent] | AssertionError: expected 'Rs 100' not to match /^Rs/ |
| PRN-039 | P2 | Print preview A4 portrait | PRN-039 [browser] A4 portrait preview: 10 lines fit one page; 60 lines break without splitting a row | Error: 10-line invoice fits one A4 page |
| PRN-040 | P2 | Print preview Letter | PRN-040 [browser] Letter-size print preview fits | Error: totals amounts printed in full |
| PRN-044 | P2 | 100-line invoice | PRN-044 [browser] 100-line invoice paginates; totals on the last page | Error: last page carries the totals with the full balance |
| PRN-045 | P2 | Very long product name (120 chars) | PRN-045 [browser] 120-char product name wraps within its column | Error: description may wrap |
| PRN-046 | P2 | Notes 2,000 chars | PRN-046 [browser] 2,000-char notes wrap, not clipped | Error: notes column has room to wrap |
| PRN-056 | P2 | Document chain shown in details (QUO → SO → DN → INV) | PRN-056 [browser] details dialog shows QUO → SO → DN → INV chain links | Error: chain row is a link |
| PRN-069 | P2 | Tax snapshot shows registered status at invoice time | PRN-069 printed tax details come from the invoice-time tax snapshot [defect: print uses the current party tax id] | AssertionError: expected 'Sales invoice INV-2026-0001 Print / S…' to contain 'NTN / STRN: 1234567-8' |
| PRN-072 | P2 | Rate column formatting `Rs 2,400` / `$10.00` | PRN-072 rate formatting "Rs 2,400" for PKR and "$10.00" for USD [defect: USD rates print as "Rs 10"] | AssertionError: expected '<main class="print-page"><div class="…' to contain '$10.00' |
| PRN-091 | P2 | Address with newlines in header | PRN-091 company address with newlines prints line breaks in the header [defect: address span has no pre-line/pre-wrap] | AssertionError: expected '/* Standard document template: used b…' to match /\.doc-identity[^{]*span[^{]*\{[^}]*wh…/ |
| NAV-015 | P1 | Search "INV-2026" | NAV-015 [browser] search "INV-2026" lists documents; Enter opens the first | Error: [2mexpect([22m[31mlocator[39m[2m).[22mtoHaveCount[2m([22m[32mexpected[39m[2m)[22m failed |
| NAV-026 | P2 | Arrow keys move selection, Escape closes | NAV-026 [browser] arrow keys move selection; Escape closes | Error: ArrowDown selects the first result |
| NAV-027 | P2 | Result click navigates to module and opens record | NAV-027 [browser] result click navigates to module and opens record | Error: the invoice opens |
| NAV-028 | P2 | Search with 20k records | NAV-028 [browser] search with 20k records < 100 ms per keystroke | Error: [2mexpect([22m[31mreceived[39m[2m).[22mtoBeLessThan[2m([22m[32mexpected[39m[2m)[22m |
| NAV-037 | P2 | Metric cards stagger in | NAV-037 metric cards stagger in by 40ms; reduced motion has no stagger [defect: cards never set --i, so every delay is 0] | AssertionError: expected '<div class="app-shell "><aside id="ap…' to match /class="metric-card" style="--i:1"/ |
| NAV-043 | P2 | No "Design partner", "Revision", "prototype" copy anywhere | NAV-043 no "Design partner", "Revision" or "prototype" copy anywhere in the UI [defect: Settings → Company and access shows a "Revision" label] | AssertionError: settings-view: expected '\'use client\';\nimport { useRef, use…' not to match />Revision</ |
| NAV-054 | P2 | Escape closes drawer | NAV-054 [browser] Escape closes drawer | Error: drawer closes on Escape |
| NAV-076 | P2 | Attention item "Draft sales documents to submit" opens Sales filtered to drafts | NAV-076 [browser] "Draft sales documents to submit" opens Sales filtered to drafts (source navigates to Sales only) | Error: status filter preset to Draft |
| NAV-080 | P2 | Search dialog on phone | NAV-080 [browser] search dialog on phone full-width with 16px input | Error: search input is 16px on a touch phone |
| NAV-082 | P2 | Long company name in switcher | NAV-082 [browser] long company name truncated with ellipsis in switcher | Error: switcher trigger truncates with an ellipsis |
| SEC-030 | P1 | Salesperson page load | SEC-030 Salesperson scope: API projection (own sales docs, customers, own commissions, zero salaries, no journals/audit/payroll) and the direct RLS path [defect: RLS lets a salesperson read every document in the tenant] | AssertionError: expected [ 'goods_receipt', …(2) ] to deeply equal [] |
| SEC-046 | P2 | Content-Type text/plain | SEC-046 Content-Type text/plain is refused with 400 [defect: the body is parsed regardless of content type] | AssertionError: expected 200 to be 400 // Object.is equality |
| SEC-053 | P2 | CSV injection `=cmd()` in export | SEC-053 CSV injection: formula-leading cells are neutralised on export [defect: toCsv writes =cmd() verbatim] | AssertionError: expected '"=cmd/""/c calc""!A1","+SUM(1,2)",@x,…' not to match /(^/,)"?[=+@-]/ |
| SEC-054 | P2 | Path traversal in branding upload | SEC-054 path traversal in branding: upload filename ignored; saved paths must stay inside the tenant folder [defect: save_branding accepts "<tenant>/../<other>/logo.png"] | AssertionError: expected [Function] to throw an error |
| SEC-066 | P2 | Audit records actor id, type, time, not payload secrets | SEC-066 audit records actor id, action and time, never payload secrets [defect: audit stores the editable display name, not the user id] | AssertionError: expected 'QA Me' to be 'u-sec-066' // Object.is equality |
| SEC-068 | P2 | 500 on engine exception returns generic message | SEC-068 an unexpected engine exception returns 500 with a generic message and is logged server-side [defect: returns 400 with the raw TypeError text, nothing logged] | AssertionError: expected 'Cannot read properties of null (readi…' not to match /Cannot read/null/undefined/ |
| SEC-089 | P2 | Open redirect in `next` param | SEC-089 open redirect in next= is blocked for every variant [defect: "/\evil.com" redirects off-site] | AssertionError: /\evil.com: expected 'evil.com' to be 'localhost' // Object.is equality |
| SEC-100 | P1 | End to end: eight roles each run a scripted set of allowed/denied commands | SEC-100 eight roles × scripted commands: allow/deny matrix (company, branding and modules are Settings, Owner/Accountant only after setup) [defect: every non-Auditor role may save_company, save_branding and set_modules server-side] | AssertionError: expected { Owner: [ 'save_item', …(10) ], …(7) } to deeply equal { Owner: [ 'save_item', …(10) ], …(7) } |
| UIX-001 | P1 | Every module at 390×844 | UIX-001 [browser] every module at 390×844 has no horizontal page scroll | Error: [2mexpect([22m[31mreceived[39m[2m).[22mtoEqual[2m([22m[32mexpected[39m[2m) // deep equality[22m |
| UIX-003 | P2 | 768×1024 tablet | UIX-003 [browser] 768×1024 tablet: sidebar or drawer, readable | Error: [2mexpect([22m[31mreceived[39m[2m).[22mtoEqual[2m([22m[32mexpected[39m[2m) // deep equality[22m |
| UIX-005 | P2 | 320px width | UIX-005 [browser] 320px width usable; wraps | Error: [2mexpect([22m[31mreceived[39m[2m).[22mtoEqual[2m([22m[32mexpected[39m[2m) // deep equality[22m |
| UIX-024 | P2 | Contrast: badges (green/amber/red/violet/cyan on pastels) ≥ 4.5:1 | UIX-024 badges (green/amber/red/violet/cyan on pastels) ≥ 4.5:1 [defect: danger badge #d92d20 on #fee9e7 is 4.15:1] | AssertionError: expected [ 'danger 4.15' ] to deeply equal [] |
| UIX-027 | P2 | Contrast: setup footer white on tinted scrim | UIX-027 setup footer (white 88% on the tinted scrim over the page) ≥ 4.5:1 [defect: ≈1.9:1 at worst against the light page behind the scrim] | AssertionError: expected 1.8706744677270146 to be greater than or equal to 4.5 |
| UIX-029 | P1 | Focus visible everywhere (violet ring) | UIX-029 [browser] focus ring visible everywhere | Error: [2mexpect([22m[31mreceived[39m[2m).[22mtoEqual[2m([22m[32mexpected[39m[2m) // deep equality[22m |
| UIX-030 | P2 | Focus trapped in dialogs; returns to trigger on close | UIX-030 [browser] focus trapped in dialogs and returned to the trigger | Error: [2mexpect([22m[31mreceived[39m[2m).[22mtoEqual[2m([22m[32mexpected[39m[2m) // deep equality[22m |
| UIX-053 | P2 | Metric stagger 40ms | UIX-053 metric cards stagger by 40 ms [defect: no card sets --i, so all delays are 0] | AssertionError: expected '<div class="app-shell "><aside id="ap…' to match /class="metric-card" style="--i:\d"/ |
| UIX-059 | P2 | Empty states have a next action | UIX-059 [browser] empty states offer a next action | Error: [2mexpect([22m[31mreceived[39m[2m).[22mtoEqual[2m([22m[32mexpected[39m[2m) // deep equality[22m |
| UIX-062 | P2 | Single radius scale 6/10/14/20 | UIX-062 [browser] computed radii follow 6/10/14/20 (legacy rules in globals.css still declare 5/7/9px) | Error: [2mexpect([22m[31mreceived[39m[2m).[22mtoEqual[2m([22m[32mexpected[39m[2m) // deep equality[22m |
| UIX-083 | P2 | Long names truncate with ellipsis where fixed width | UIX-083 [browser] long names truncate with ellipsis in fixed-width spots | Error: [2mexpect([22m[31mreceived[39m[2m).[22mtoEqual[2m([22m[32mexpected[39m[2m) // deep equality[22m |
| UIX-089 | P2 | Toast/notice readable on phone | UIX-089 [browser] notices readable on phone | Error: the notice is on screen after the action |
| UIX-092 | P2 | axe-core no serious violations on every module | UIX-092 [browser] axe-core: no serious violations on every module | Error: [2mexpect([22m[31mreceived[39m[2m).[22mtoEqual[2m([22m[32mexpected[39m[2m) // deep equality[22m |
| UIX-099 | P2 | Setup card full-screen on phone | UIX-099 [browser] setup card full-screen on phone | Error: step 1: nothing behind the card widens the page |
| DAT-004 | P1 | Quantity precision 4 dp | DAT-004 quantity precision 4 dp: 0.00005 rounds consistently between the document and stock [defect: line keeps 0.00005, stock move is 0.0001] | AssertionError: expected false to be true // Object.is equality |
| DAT-011 | P1 | Retry with network error after server commit | DAT-011 a client retry after the server committed returns the original result [defect: replay returns recordId "" and "This operation was already completed."] | AssertionError: expected '' to be '982758bc-1072-41c5-ac63-8220cba5b24e' // Object.is equality |
| DAT-058 | P2 | Browser closed mid-command | DAT-058 [browser] browser closed mid-command: server completes; reload shows the result | Error: [2mexpect([22m[31mreceived[39m[2m).[22mtoBe[2m([22m[32mexpected[39m[2m) // Object.is equality[22m |
| DAT-060 | P2 | DB unreachable | DAT-060 database unreachable → 500 with a generic message; retry later works [defect: status 400 "Unexpected request failure.", not 500] | AssertionError: expected 400 to be 500 // Object.is equality |
| DAT-075 | P2 | Whitespace-only inputs | DAT-075 whitespace-only inputs are rejected where required [defect: save_party accepts "   " and stores an empty name] | AssertionError: save_party should be refused: expected undefined to be an instance of Error |

## Case corrections (69)

- ONB-050: [case-corrected: the chart is a fixed list (accountNames) present for every company regardless of modules; nothing is provisioned per module]
- ONB-051: [case-corrected: series are derived from existing documents on first use, not provisioned records]
- ONB-068: [case-corrected: the Documents step stacks the preview under the form below 1000 px, so iPad portrait shows one column]
- ONB-090: [case-corrected: the address limit is 500 characters (form maxLength 500, API max 500)]
- ONB-092: [case-corrected: stored as typed (not trimmed); prints an empty-looking footer paragraph]
- SET-024: [case-corrected: message lists modules in catalogue order: "Collections & PDCs, Commissions cannot stay on without Sales."]
- SET-058: [case-corrected: only Owner, Accountant and Auditor see Settings; other roles have no Settings entry]
- SET-068: [case-corrected: it uses the first submitted invoice in the list, not the latest]
- SET-086: [case-corrected: settings.numbering ("DP" for a new company) is stored but not used; documents use fixed kind prefixes like INV-YYYY-0001]
- PRD-002: [case-corrected: API error is the min-length validation (route shows "Check the highlighted information."); "SKU is required" is the CSV import message]
- PTY-023: [case-corrected: party phone is not printed on documents (print shows name, city, email, NTN)]
- PTY-060: [case-corrected: message is "X appears more than once in the file" without the "customer" prefix]
- PTY-093: [case-corrected: the id is treated as a new record in this tenant; no other tenant's data is read or changed]
- INV-008: [case-corrected: set_stock_quantity returns the min-length validation (form field is required); "Adjustment reason is required." is the stock_adjust message]
- INV-046: [case-corrected: the Overview attention list has no low-stock entry; low stock shows only as Inventory badges/filter]
- INV-060: [case-corrected: the report is chronological; Item details shows the newest 20 movements first with no running quantity]
- INV-072: [case-corrected: the Stock tab has no totals row; the total is in Reports → Stock valuation]
- INV-074: [case-corrected: shown, but without an "archived" mark]
- SAL-099: [case-corrected: message is "This warehouse is outside your permitted branches."]
- PUR-018: [case-corrected: credit goes to 2010 Goods received, not billed]
- PUR-031: [case-corrected: message is "Invalid invoice allocation."]
- PUR-034: [case-corrected: message is "Invalid invoice allocation."]
- PUR-035: [case-corrected: message is "Invalid invoice allocation."]
- PUR-044: [case-corrected: GRNs are not listed either]
- PUR-051: [case-corrected: totals are in the document currency only; PKR equivalent appears only via the exchange-rate line]
- PUR-061: [case-corrected: input tax account is 1300 Recoverable tax]
- PUR-076: [case-corrected: a direct bill DOES move stock in and debits 1200]
- IMP-066: [case-corrected: accepted (below one trillion); 1,000,000,000,000 is refused]
- IMP-069: [case-corrected: defaults apply only when the fields are omitted; blank strings are stored blank]
- IMP-073: [case-corrected: Sales analysis has no margin column; the overview margin (summary) reflects landed cost]
- IMP-086: [case-corrected: posts to 5300 "Operating expense", not a separate clearing/import expense line]
- COL-005: [case-corrected: message is "Invalid invoice allocation."]
- COL-006: [case-corrected: message is "Invalid invoice allocation."]
- COL-007: [case-corrected: message is "Invalid invoice allocation."]
- COL-044: [case-corrected: REC-0001, REC-0002… one global series without a year, shared with supplier payments]
- CSH-046: [case-corrected: accepted (limit is below one trillion); 1,000,000,000,000 is refused]
- CSH-048: [case-corrected: surrounding whitespace is trimmed; an inner newline is kept as typed]
- CSH-094: [case-corrected: summary cards are not tappable; the account name in the Accounts list opens the activity]
- COM-028: [case-corrected: paid may exceed released after a bounce until payroll recovers it]
- COM-055: [case-corrected: message is "Hamza Khan appears more than once in the file" without the word "employee"]
- COM-081: [case-corrected: states read unreleased / pending (released, awaiting approval) / approved / recoverable]
- COM-091: [case-corrected: approved resets to false when the release changes]
- PAY-043: [case-corrected: net = commission − income tax − employee EOBI]
- PAY-048: [case-corrected: PAY-YYYY-MM (one run per month), not PAY-2026-0001]
- ACC-008: [case-corrected: rejected at validation with "Amount cannot be negative."]
- ACC-014: [case-corrected: memo "Reversal · JV-00001"; message is the generic "Changes saved."]
- ACC-033: [case-corrected: JV-00001 style, not J-2026-0001]
- ACC-054: [case-corrected: the date range lives in Reports → General ledger; Accounting lists the latest 8]
- ACC-090: [case-corrected: no separate journal detail screen; the Recent posted journals table is the journal view]
- RPT-038: [case-corrected: range defaults to 1 January of the current year → today (year to date); as-at defaults to today]
- RPT-046: [case-corrected: rows open the module queue, not a report]
- RPT-073: [case-corrected: labelled "Unassigned"]
- RPT-076: [case-corrected: amounts are shown with "Rs", not "PKR"]
- PRN-002: [case-corrected: logo box is 22mm (≈83px) square with object-fit: contain]
- PRN-043: [case-corrected: the print template uses Arial/Helvetica with "Noto Naskh Arabic" fallback, not Geist]
- PRN-053: [case-corrected: the logo sits on the white document header, not on an accent background]
- PRN-073: [case-corrected: "0%" is printed for zero discounts as well, not only when non-zero]
- PRN-078: [case-corrected: title is "<Kind> <number>", e.g. "Sales invoice INV-…", set client-side by PrintActions]
- PRN-081: [case-corrected: @page margins are 14mm sides/top and 16mm bottom, A4]
- NAV-019: [case-corrected: search covers documents, customers, suppliers and products only, as its description says; employees are never returned for any role, so salaries cannot leak]
- NAV-031: [case-corrected: queues are commission awaiting approval, unallocated shipment costs, open customer invoices, cheques due, follow-ups due and draft sales; there is no low-stock or overdue supplier-bill queue]
- NAV-038: [case-corrected: weekly totals up to 12 weeks ending at the latest activity, not 6 months; bars violet (accent) and cyan (accent-2) with legend]
- NAV-061: [case-corrected: the company is kept by the ?tenant= query that stays in the URL, not by a cookie]
- NAV-064: [case-corrected: reads "SAHULAT ERP  Made for the way you do business." and "PKR · Asia/Karachi" without the extra dots]
- SEC-002: [case-corrected: 403 TENANT_REQUIRED, not 400]
- SEC-041: [case-corrected: the client does not auto-retry; it shows "Another change was saved first. Refresh and try again."]
- DAT-003: [case-corrected: 33.3333 / 33.3333 / 33.3334 — the last line takes the remainder]
- DAT-014: [case-corrected: a receipt above the outstanding is refused; a return after full payment is allowed and leaves a customer credit (negative outstanding) by design]
- DAT-090: [case-corrected: postCommand retries once with the same body only when the response is not JSON or a 5xx without a message; a 5xx with a message is not retried]

## Behaviour recorded where the case asked "assert/verify" (227)

- AUTH-001: [documented: email field is pre-filled with owner@sahulaterp.com]
- AUTH-002: [documented: signs in at /?tenant=QA so it lands on that company; a bare / would open the first non-demo membership]
- AUTH-006: [documented: also minLength=8]
- AUTH-010: [documented: no account has a 200-char password; the field and the request carry all 200 characters and Supabase answers with the generic error]
- AUTH-011: [documented: the browser email validation blocks it before any request]
- AUTH-012: [documented: blocked by email validation, nothing rendered]
- AUTH-019: [documented: sign-out ends every session of the account]
- AUTH-022: [documented: login keeps pathname+search via window.location.assign]
- AUTH-049: [documented: sign-out ends every session of the account]
- AUTH-068: [documented: verified from script source; not run against hosted]
- AUTH-073: [documented: shows Supabase's own message "Invalid login credentials" verbatim]
- AUTH-076: [documented: passes browser validation, reaches Supabase and gets the generic error]
- AUTH-078: [documented: no account has an emoji password; the field and request keep the emoji and Supabase answers with the generic error]
- AUTH-088: [documented: no a+qa account exists; the address is accepted by the form and sent unchanged, Supabase answers generically]
- AUTH-090: [documented: sign-out ends every session of the account]
- ONB-005: [documented: the wizard refuses client-side with "Enter the company name and address."; the API only refuses at complete_setup]
- ONB-012: [documented: input type=email blocks in the browser; API refuses "Invalid email address"]
- ONB-073: [documented: sign-out ends every session of the account]
- ONB-075: [documented: any step 1-4 is accepted in any order]
- ONB-088: [documented: simulated with the same owner in a second browser context; no second member account]
- SET-029: [documented: no trimming; refused as "Password incorrect."]
- SET-048: [documented: the route only ever resets the demo tenant; non-members get 403]
- SET-072: [documented: no contrast validation; white headings are a design limitation]
- SET-079: [documented: an open tab moves to Overview on its next successful command]
- SET-083: [documented: the form blocks it (textarea required); the API save_company accepts a blank address after setup]
- PRD-015: [documented: browser number input sends 1000; the API accepts "1e3" and stores it as typed, valued as 1000]
- PRD-019: [documented limitation; hint "pcs, box, kg…"]
- PRD-021: [documented: new-product form defaults to "General"; a cleared category saves blank and a category plan pays its default rate]
- PRD-059: [documented: plain UTF-8 without BOM, text/csv;charset=utf-8]
- PRD-070: [documented: limit is 2,000 rows per file; 2,001 refused by the API and by the dialog "Import at most 2,000 rows at a time."]
- PRD-074: [documented: the parser auto-detects ";" so columns map correctly rather than failing]
- PRD-076: [documented: the whole file is parsed on the main thread, then refused with "Import at most 2,000 rows at a time."]
- PTY-022: [documented]
- PTY-046: [documented]
- PTY-073: [documented: counts all]
- PTY-085: [documented: the check applies to sales invoices only]
- PTY-086: [documented: no name snapshot on documents]
- PTY-087: [documented: lookup is by name]
- INV-015: [documented: the resulting value 1,499,999,923,500 exceeds one trillion; the below-one-trillion rule applies to inputs only]
- INV-017: [documented: accepted (no future-date guard)]
- INV-032: [documented: Inventory is not in the Salesperson sidebar; the stock data is still sent (for selling) and the view has no edit/transfer buttons]
- INV-054: [documented: there is no warehouse archive; set_archived accepts only party/item]
- INV-066: [documented: for 15+ units the value rounds up to 0.0002 and is accepted]
- INV-076: [documented: warehouses cannot be archived, so there is nothing to exclude]
- INV-077: [documented: a transfer moves one product; each is guarded on its own and an over-quantity transfer changes nothing]
- SAL-009: [documented: engine throws raw "[DecimalError]
- SAL-023: [documented: engine defaults taxRate to 18 when the field is omitted entirely]
- SAL-032: [documented: role gate refuses first with "Your role does not permit this action."]
- SAL-061: [documented: accepted, no ordering check]
- SAL-080: [documented: closes immediately, no confirmation, typed data discarded]
- SAL-090: [documented: quantities AND rates/amounts/totals are shown]
- SAL-093: [documented: create refuses archived products but submit of an existing draft still succeeds]
- PUR-004: [documented: Importer class, 30-day default terms]
- PUR-039: [documented: recorded as status received with no journal; follows the same deposit/clear state machine, posting on clear]
- IMP-023: [documented: allocation refused "Allocation needs positive weights."; no fallback]
- IMP-034: [documented: engine has no in_transit/customs commands; new shipments start "received", adding a cost sets "received", allocation sets "costed"]
- IMP-041: [documented: no refund command; a manual journal Dr bank / Cr 1400 clears it]
- IMP-045: [documented: a cost has no currency; on a USD GRN the amount is posted as PKR as entered]
- IMP-049: [documented: allowed; each allocates its own costs]
- IMP-050: [documented: not supported; no delete command exists]
- IMP-051: [documented: no edit command; allocated costs are immutable]
- IMP-059: [documented: return removes stock at the bill line cost (excl. landed cost); landed cost stays on remaining units; payable reduced by bill price only]
- IMP-064: [documented: nothing is provisioned; deposit/expense accounts are part of the fixed chart]
- IMP-085: [documented: no separate tax summary; shown as 1300 Recoverable tax on the balance sheet and trial balance]
- IMP-092: [documented: engine refuses unless Imports is also turned off ("Imports & costing cannot stay on without Inventory."); dropping both hides both]
- IMP-097: [documented: there is no shipment CSV export]
- COL-026: [documented: recovery is recorded only via payroll when commission was already paid (see COL-071)]
- COL-035: [documented: no cheques-in-hand account]
- COL-046: [documented: refused, "Your role does not permit this action."]
- COL-059: [documented: received/deposited cheques are not shown as pending lines]
- COL-060: [documented: allowed; aging unaffected, no crash]
- COL-061: [documented: allowed when the month is not locked]
- COL-069: [documented: with Collections off no customer receipt can be recorded]
- COL-079: [documented: API accepts it; clearing then posts to 1000 "Bank & cash (legacy)"]
- COL-080: [documented: allowed by the engine; UI lists only bank accounts]
- COL-087: [documented: allowed]
- COL-091: [documented: allowed; journal and statement use the clear date]
- COL-094: [documented: received → Deposit/Bounced, deposited → Cleared/Bounced; cleared and bounced cheques leave "Cheques in hand" and keep only Print, so a cleared cheque cannot be bounced from the UI]
- CSH-009: [documented: cap is 99 accounts, codes 1001–1099]
- CSH-013: [documented: no balance check; source goes negative]
- CSH-025: [documented: Cash & bank activity has no date filter; Reports → General ledger filters an account by date]
- CSH-034: [documented: the reconciliation row compares the account total with itself, so it can never show a variance]
- CSH-055: [documented: no engine default]
- CSH-063: [documented: no pagination; card shows latest 50 movements]
- CSH-064: [documented: not present in Cash & bank; use Reports → General ledger export]
- CSH-065: [documented: not present; search covers documents, parties and items only]
- CSH-066: [documented: bank cards show details; cash cards show "Cash"]
- CSH-078: [documented: the memo wraps in full; no truncation or tooltip]
- CSH-085: [documented: creation order everywhere, not bank-first or alphabetical]
- CSH-087: [documented: id falls back to "record" slug; code assigned normally]
- COM-011: [documented: unlisted categories fall back to the plan rate]
- COM-014: [documented: marginal tiers on each line's own net base, not cumulative across invoices]
- COM-015: [documented: once the salesperson's month-to-date base incl. this line reaches the target, that line's commission is multiplied]
- COM-052: [documented: allowed; commission accrues]
- COM-057: [documented: export columns are the same for all roles, values come from the projection]
- COM-061: [documented: refused, so cash releases always have a collections path]
- COM-062: [documented: accrual is not gated by the module]
- COM-066: [documented: 2200 is cleared at payroll approval; payment settles 2300]
- COM-069: [documented: a zero entitlement row is created and no journal is posted]
- COM-072: [documented: the amount up to the threshold earns the lower tier; only the excess earns the next tier]
- COM-080: [documented: not present; rows carry invoices, quantity, net, returns only]
- COM-084: [documented: every type shows all fields — category, class, tier rates, target and multiplier]
- COM-087: [documented: not present; search covers documents, parties and items only]
- COM-094: [documented: payroll skips inactive employees, so it is not paid until reactivated]
- PAY-010: [documented: basic = salary × attendance ÷ 30; allowance is not prorated]
- PAY-011: [documented: basic 0, allowance still paid; with no allowance the employee EOBI makes deductions exceed earnings and the whole run is refused]
- PAY-026: [documented: expense posts at approval, payment credits legacy 1000]
- PAY-033: [documented: not present; printable kinds are sales, purchase and receipt documents only]
- PAY-041: [documented: no account provisioning needed; chart is fixed]
- PAY-050: [documented: allowed]
- PAY-053: [documented: no payroll row in the Control reconciliation]
- PAY-054: [documented: not offered — no command exists]
- PAY-076: [documented: not present in the Payroll view]
- PAY-077: [documented: not present; search covers documents, parties and items only]
- PAY-080: [documented: employer EOBI is inside 5200 Salary expense, no separate line]
- PAY-081: [documented: 2400 is never settled in-app]
- PAY-082: [documented: payroll pay settles 2300 automatically; 2400 needs a manual journal because record_expense only allows 5100/5200/5300]
- PAY-083: [documented: import and the form default to 30; the API requires attendance]
- PAY-085: [documented: not present; payroll appears only through P&L / ledger accounts]
- PAY-089: [documented: not present — runs show no line or commission detail and no tooltip]
- ACC-010: [documented: the command still reports "Balanced journal posted."]
- ACC-012: [documented: an empty string is allowed; omitting memo fails validation]
- ACC-048: [documented: allowed; reconciliation then shows a variance]
- ACC-055: [documented: not present in the Accounting view; Reports offers General ledger / Trial balance CSV]
- ACC-056: [documented: manual journals are not auto-allocated]
- ACC-087: [documented: the database rejects it ("not balanced") and keeps the old revision]
- RPT-014: [documented: net and returns per person present; COGS, margin and commission not present]
- RPT-016: [documented: margin not present]
- RPT-020: [documented: aging excludes unbilled landed-cost charges; aging + landed-cost payable = control]
- RPT-024: [documented: no separate gross-profit line]
- RPT-037: [documented: the Export button is disabled when the table has no rows]
- RPT-055: [documented: not present; COGS incl. landed cost is visible in P&L 5000]
- RPT-061: [documented: an uncleared cheque posts nothing, so it is not an asset until cleared]
- RPT-063: [documented: no option to show them]
- RPT-065: [documented: verified on a fresh company; the reset script is hosted]
- RPT-066: [documented: shared parameters persist across reports; leaving Reports resets them; no crash]
- RPT-070: [documented: opening and closing 0 with no lines; the table shows an "Opening balance" row rather than "No activity"]
- RPT-078: [documented: "Rs -1,234.5" with a leading hyphen-minus]
- RPT-079: [documented: bold with a heavy top border; not sticky]
- RPT-087: [documented: not present; exports are generated in the browser]
- RPT-090: [documented: reports are not routed — /reports and ?report= open the app at Overview]
- RPT-092: [documented: always omitted, no toggle]
- RPT-093: [documented: no currency column]
- RPT-097: [documented: the open tab does not refresh by itself]
- RPT-099: [documented: header cells are <th> in <thead> without an explicit scope attribute]
- PRN-010: [documented: walk-in invoices show the shared walk-in account terms, here "0 days"]
- PRN-014: [documented]
- PRN-023: [documented: Due row still printed from dueDate]
- PRN-025: [documented: prices and amounts are printed too]
- PRN-028: [documented: Due is the date entered on the bill, not recomputed from supplier terms]
- PRN-032: [documented: printed from Reports → statement via browser print; no /print/statement route]
- PRN-037: [documented: 600 s expiry; expired-link failure needs hosted storage]
- PRN-050: [documented: glyph rendering needs a browser]
- PRN-058: [documented: a return appears as its credit note in "Document chain", the line shows "1 returned" and totals show "Returns / credits"]
- PRN-062: [documented: the sheet keeps 20px radius on its bottom corners too — globals.css `.dialog-content{border-radius:20px}` (colour layer) overrides the phone sheet rule `…0 0`]
- PRN-063: [documented: a non-member tenant falls back to the first membership]
- PRN-064: [documented: memberships[0]
- PRN-067: [documented: print is allowed; there are no documents so any id is not found]
- PRN-068: [documented: branding is not snapshotted]
- PRN-070: [documented: not present on the template]
- PRN-074: [documented]
- PRN-075: [documented: Chromium names the PDF after the tab title, which stays "SahulatERP · Your business, connected"; PrintActions' "Sales invoice <number>" title is not applied]
- PRN-079: [documented: Print opens a new tab; closing it leaves the app tab exactly as it was]
- PRN-080: [documented: repetition itself needs a browser]
- PRN-083: [documented: headless Chromium cannot show the native dialog; the page leaves the shortcut to the browser (keydown not prevented) and the browser prints the same @media print output the button uses]
- PRN-084: [documented: allowed; document kept]
- PRN-085: [documented: all walk-in documents are grouped under the one shared account]
- PRN-090: [documented: not present]
- PRN-093: [documented: NTN is omitted with the letterhead, consistently]
- PRN-100: [documented: A4 layout needs a browser]
- NAV-008: [documented: current company carries a check icon labelled "Current company"; there is no separate highlight colour]
- NAV-009: [documented: target navigation intercepted and verified; the other company is not opened per the isolation rule]
- NAV-010: [documented: the owner account belongs to 6 companies, so a one-company menu cannot be produced without creating a user; verified the trigger shows the current company and it appears exactly once in the menu]
- NAV-022: [documented: placeholder "Invoice number, customer, SKU…" and the description; the results area stays empty, also for spaces only]
- NAV-023: [documented: results appear from the first character with no "type more" message; "Al" returns the first 8 documents (their type text "sales invoice" matches), so the Ali Traders customer is pushed past the 8-result cap]
- NAV-030: [documented: one row per queue labelled "{count} · {Module}" rather than grouped headings; queues are commission awaiting approval, unallocated shipment costs, open customer invoices, cheques due, follow-ups due, draft sales]
- NAV-057: [documented: tabs expose role=tablist/tab and aria-selected; no role=tabpanel/aria-controls and no arrow-key movement between tabs]
- NAV-060: [documented: module switches add no history entries; Back leaves the app for the previous page and Forward reloads the same company on Overview]
- NAV-063: [documented: non-Owner members could not be signed in here; demo vs non-demo verified]
- NAV-069: [documented: the document editor also closes on an overlay click, discarding typed lines]
- NAV-083: [documented: with 10 entries the menu fits within 1440×900 and 1366×768 without scrolling; the menu has no max-height, so it does not scroll itself]
- NAV-090: [documented]
- NAV-097: [documented: the notice reads the browser text "Failed to fetch"]
- SEC-005: [documented: an Owner/Accountant/Auditor can read their own tenant's snapshot; a salesperson none]
- SEC-010: [documented: no build output scanned, source only]
- SEC-011: [documented: .env.example also has NEXT_PUBLIC_APP_URL]
- SEC-039: [documented: treated as a replay — unchanged workspace, recordId "", "This operation was already completed."]
- SEC-044: [documented: no 413 at app level; field limits reject it]
- SEC-047: [documented: signed-in GET returns the role-scoped workspace]
- SEC-048: [documented: session cookies are SameSite=Lax (@supabase/ssr default); the route has no Origin check and also accepts ?tenant= in the URL]
- SEC-050: [documented: X-Content-Type-Options, Referrer-Policy, X-Frame-Options DENY, Permissions-Policy on all routes; no CSP; HSTS left to the host]
- SEC-051: [documented: list/dialog rendering needs a browser]
- SEC-058: [documented: route always targets the demo tenant]
- SEC-060: [documented: none in the app; only the 5-per-15-min password throttle exists]
- SEC-080: [documented]
- SEC-091: [documented: names are compared with trim + toLowerCase only; NFC "Café" and NFD "Café" are both accepted]
- SEC-095: [documented: only "Empty workspace command body" (method/length/type) and database rejection messages are logged]
- UIX-016: [documented: colour-only :hover rules on nav and buttons are not gated]
- UIX-031: [documented: not present]
- UIX-047: [documented: spinners, skeleton pulse, provisioning ring and the 800 ms setup reveal are longer by design]
- UIX-049: [documented: only .setup-progress animates width]
- UIX-054: [documented: the nav-icon hover scale is not pointer-gated]
- UIX-057: [documented: formatter checked; every screen needs a browser pass]
- UIX-061: [documented: only the branding accent swatch palette in branding-form.tsx]
- UIX-065: [documented: also the welcome-strip icon tile]
- UIX-079: [documented: document editor and record forms checked in source only]
- UIX-080: [documented: filter-bar selects are a compact 12.64 px / 41 px size; form selects are 14 px / 42 px; radius, border, background, colour and font are identical everywhere]
- UIX-084: [documented: Geist has no Arabic script; Chromium falls back to a system Arabic font]
- DAT-005: [documented: fxRate 280.12345 is stored as entered and used at full precision; posted PKR amounts round half-up to 4 dp]
- DAT-013: [documented: requests are serialised by the revision check]
- DAT-026: [documented: preserved, except the retired fbr and bankLines keys which are dropped]
- DAT-027: [documented: schemaVersion stays 1; additive fields are defaulted by decodeWorkspace; no version switch exists]
- DAT-032: [documented: no]
- DAT-039: [documented: a plain string sort then puts …-10000 before …-9999]
- DAT-042: [documented]
- DAT-048: [documented: content is identical; ids and audit timestamps are regenerated, so a raw hash differs]
- DAT-049: [documented: extrapolated from 200 invoices]
- DAT-050: [documented: engine only, excluding network/DB]
- DAT-051: [documented: 9,9xx extra documents are drafts cloned from an engine-built draft (no postings, so the ledger stays balanced); a 10k-document company cannot be built command-by-command in test time]
- DAT-057: [documented: the walk-in account remains; acceptable]
- DAT-063: [documented: future dates are accepted]
- DAT-074: [documented: not normalised; NFC and NFD forms are distinct]
- DAT-081: [documented: not normalised; insertion order from the engine]
- DAT-088: [documented: re-runs this pack's UI file and then its print file, each alone in a child Playwright run (the reverse of the default 16 → 19 order), and compares every outcome with its tag: defect-tagged tests fail, manual-tagged tests skip, the rest pass]
- DAT-089: [documented: the server under test is a production build, so there is no on-demand compile to provoke; the warm-up is wired in the config and every route it touches answers below 500]
- DAT-091: [documented: a 4xx whose body is not JSON is retried once]
- DAT-094: [documented: the server re-reads the latest snapshot on every POST, so the command applies on top without a conflict]

## Manual-only cases (57)

- AUTH-031 "Forgot your password?" with a valid email — [manual] reset email delivery with link to /auth/callback?next=/account/reset (redirectTo verified in source)
- AUTH-034 Forgot password twice quickly — [manual] two quick reset requests: hosted Supabase rate limit surfaced cleanly
- AUTH-036 Set new password of 8 chars — [browser] set an 8-char password via reset link; new works, old fails
- AUTH-039 New password 72+ chars — [manual] 72+ char new password: hosted GoTrue limit, never silently truncated
- AUTH-040 New password equal to old password — [manual] new password equal to old: hosted Supabase policy
- AUTH-042 Reuse the reset link after success — [browser] reused reset link shows expired state
- AUTH-043 Reset link opened in a different browser — [manual] reset link opened in a different browser
- AUTH-050 Session expiry after the refresh token lapses — [manual] session expiry after refresh-token lapse returns to login
- AUTH-051 Two accounts in two browsers simultaneously — [browser] two accounts in two browser contexts see only their own memberships
- AUTH-059 Password manager autofill — [manual] password-manager autofill fills both fields
- AUTH-066 Reset-password flow for a user, then sign in as another user in same browser — [browser] reset flow for one user then sign in as another in same browser: no leakage
- AUTH-067 Member created by `npm run member:create` with MEMBER_DEMO=1 — [manual] member:create with MEMBER_DEMO=1 against hosted: sees own and demo company
- AUTH-070 `company:reset` for a member — [manual] company:reset against hosted: next sign-in shows setup card
- AUTH-079 20 failed logins in a minute — [manual] 20 failed logins/minute: hosted Supabase rate limit surfaced
- AUTH-085 Reset page with another user's recovery token — [manual] reset page with another user's recovery token changes only that user
- AUTH-086 Browser with cookies disabled — [manual] cookies disabled: clear failure, no loop
- AUTH-097 Sign in, change password elsewhere, continue — [manual] password changed elsewhere: session continues until refresh fails
- AUTH-100 Full round trip: sign up by script → sign in → setup → sign out → forgot → reset → sign in — [manual] full round trip script sign-up → sign in → setup → sign out → forgot → reset → sign in
- ONB-097 Company reset by script, user already signed in — [manual] company reset by script while signed in; next navigation shows the setup card (needs hosted Supabase)
- PTY-090 Suggestions on iOS Safari — [browser] suggestions on iOS Safari: datalist works or free text still saves
- SAL-066 Two users create invoices simultaneously — [manual] two users create invoices at once: needs real Supabase commits (code review: api/workspace/route.ts:59 returns 409 "Another change was saved first. Refresh and try again." with no transparent retry; engine numbers from the same base revision collide)
- CSH-086 Balance after company reset — [manual] balances after company reset are 0 — reset runs the hosted company:reset script; fresh-company zero state is covered by CSH-002
- RPT-098 CSV opens in Excel with correct columns — [manual] exported CSV opens in Excel with correct columns
- PRN-054 Print on phone (iOS Share → Print) — [manual] iPhone Share → Print layout fits without clipping
- PRN-099 Print page in Safari — [manual] print page in Safari matches Chrome
- NAV-070 First load TTI < 3 s on 4G — [manual] first load TTI < 3 s on 4G (Lighthouse)
- NAV-075 Hover motion only with mouse — [manual] touch device: no stuck hover after tap
- NAV-095 Idle for 1 hour then act — [manual] idle 1 hour then act: works or clean re-login
- SEC-056 Logo signed URL reuse after expiry — [manual] logo signed URL reused after its 600 s expiry fails (hosted Storage)
- SEC-061 Session fixation: sign in doesn't reuse pre-login session id — [manual] session fixation: sign-in issues a new session (hosted Supabase Auth)
- SEC-062 Logout invalidates refresh token — [manual] logout invalidates the refresh token (hosted Supabase Auth)
- SEC-063 Password reset token single-use — [manual] password reset token is single-use (hosted Supabase Auth)
- SEC-069 Dependency audit `npm audit` — [manual] npm audit: no high/critical (needs the npm registry)
- SEC-085 Vercel env has no service key exposed as NEXT_PUBLIC — [manual] Vercel env exposes no service key as NEXT_PUBLIC_*
- SEC-086 HTTPS only; HSTS — [manual] HTTPS only with HSTS on the deployed host
- SEC-087 Cookie secure flags in prod — [manual] production cookies carry Secure
- SEC-096 Backup/restore of snapshot table — [manual] backup/restore of the production snapshot table, then rebuild the projection
- SEC-097 Penetration smoke with OWASP ZAP baseline — [manual] OWASP ZAP baseline scan: no high alerts
- SEC-098 Auth brute force — [manual] auth brute force hits hosted Supabase limits
- UIX-009 Sheet content scrolls with overscroll contained — [manual] sheet content scrolls with overscroll contained (no rubber-band) on iOS
- UIX-011 Keyboard open on phone with sheet — [manual] phone keyboard open with sheet keeps actions reachable
- UIX-019 Landscape phone — [manual] landscape phone usable
- UIX-043 Screen reader reads setup steps and progress — [manual] screen reader announces setup steps and progress
- UIX-072 Windows high-contrast mode — [manual] Windows high-contrast mode keeps borders visible
- UIX-073 Safari desktop rendering — [manual] Safari desktop matches Chrome
- UIX-074 Firefox rendering — [manual] Firefox matches Chrome
- UIX-075 iOS Safari bottom bar overlap — [manual] iOS Safari bottom bar does not cover sticky actions
- UIX-076 Android Chrome keyboard resize — [manual] Android Chrome keyboard resizes the layout
- UIX-077 Datalist on iOS — [manual] datalist on iOS offers suggestions or free text
- UIX-078 Date input on iOS — [manual] date input on iOS opens the native picker
- UIX-090 Lighthouse accessibility ≥ 95 on login, overview, sales — [manual] Lighthouse accessibility ≥ 95 on login, overview, sales
- UIX-091 Lighthouse performance ≥ 80 mobile — [manual] Lighthouse mobile performance ≥ 80
- UIX-094 Voice control names match visible labels — [manual] voice control names match visible labels
- UIX-100 Full tour on iPhone hardware — [manual] full tour on iPhone hardware
- DAT-023 Migration dry-run on hosted copy — [manual] migration dry-run on a hosted copy
- DAT-062 Supabase auth slow — [manual] slow hosted Supabase auth: UI waits, no duplicate
- DAT-098 Vercel deploy rollback — [manual] Vercel deploy rollback: previous build reads current snapshots

## Browser cases not yet run (0)


## Missing (no test or todo) (0)


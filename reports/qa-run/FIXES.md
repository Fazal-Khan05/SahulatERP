# SahulatERP: defect fix log

Every defect from the QA run (`DEFECTS.md`) with the commit(s) that fixed it on branch `fix/qa-defects`. Each fix was made and tested one at a time (fix → tests for that feature → commit), then re-verified in the final full run of all 2,000 cases.

| Defect | Sev | Title | Cases | Fix commits |
|---|---|---|---|---|
| D-01 | S1 | Supplier statement adds payments to the balance | PUR-044, PTY-099, RPT-012 | `35995df` Fix D-01: supplier statement lowers the balance on payments |
| D-02 | S1 | Supplier payment amount need not equal its allocations; the difference is booked as an FX gain/loss | PUR-032, PUR-085 | `b5d6858` Fix D-02: a supplier payment must equal its allocations unless a bill is in foreign currency |
| D-03 | S1 | Bill rate different from GRN rate leaves a GRNI residue | PUR-020 | `cbc3e9b` Fix D-03: a bill from a GRN clears GRNI (2010) at the GRN's booked value |
| D-04 | S1 | An opening-stock journal can be reversed and breaks the inventory control | ACC-017 | `54fa0e4` Fix D-04: refuse reversing a journal that has stock movements |
| D-05 | S1 | Amount, quantity and FX precision is not enforced at input (the 4-dp gap) | SAL-013, DAT-004, PRD-035, PRD-016, PUR-095 | `c05ded6` Fix D-05: enforce 4 dp precision (half-up) on amounts, quantities and FX rates at input |
| D-06 | S1 | Payroll attendance import accepts 31 days and overpays | PAY-032 | `d545307` Fix D-06: attendance import and save_employee share one 0–30 rule |
| D-07 | S1 | RLS lets any member read every document in the tenant | SEC-030 | `7e48822` Fix D-07: RLS lets any member read every document |
| D-08 | S1 | Every non-Auditor role can change company settings, branding and modules | SEC-100 | `0ed2f76` Fix D-08: company, branding and modules are Owner/Accountant only after setup<br>`670ce34` Fix D-08 (settings UI): company, branding and features read-only except for Owner and Accountant<br>`22b896b` Integration: branding upload uses the engine's canRun rule (D-08/D-19); SEC-084 checks the six-tenant allow-list |
| D-09 | S2 | Payroll cannot run on a real company | PAY-062 | `c0121b6` Fix D-09: Settings → Payroll & tax form over save_settings |
| D-10 | S2 | A stale draft payroll cannot be fixed | PAY-025 | `32f674d` Fix D-10: cancel_payroll for a stale draft or reviewed run<br>`6d2c746` Fix D-44 and D-10 (UI): payroll run lines, Cancel run, month picker |
| D-11 | S2 | Imports screen is read-only | IMP-054, IMP-055 | `cee7075` Fix D-11: Imports screen can create shipments and add classified costs |
| D-12 | S2 | Aged balances for a past date include later receipts | RPT-004 | `a58d249` Fix D-12: aged balances for a past date count only what had cleared by then |
| D-13 | S2 | Branch-limited Accountant sees an empty P&L | RPT-044 | `9d9bbbd` Fix D-13: branch-limited Accountant/Owner no longer sees an all-zero P&L<br>`3d9b00e` D-13 follow-up: Accounting follows ledgerView like Reports |
| D-14 | S2 | Foreign-currency documents print "Rs" | PRN-026, PRN-072 | `bd49136` Fix D-14: foreign-currency documents print their own currency<br>`b35fcb0` Fix D-14 (invoice editor): line totals and totals show in the document's currency; the PKR equivalent stays in rupees<br>`4efcbcc` Fix D-14 (documents list): totals use the document's currency |
| D-15 | S2 | Reprint ignores the invoice-time tax snapshot | PRN-069 | `31c1ac3` Fix D-15: reprints use the invoice-time tax snapshot |
| D-16 | S2 | App-wide table CSS leaks into the print template | PRN-039, PRN-040, PRN-044, PRN-045, PRN-046 | `ab549f2` Fix D-16: isolate the print template from app table styles<br>`dcc9ed5` D-16 follow-up: line items fit the sheet at phone widths |
| D-17 | S2 | Retry after commit returns an empty record ID | DAT-011 | `486eeb7` Fix D-17: a replayed command returns its original record ID and message |
| D-18 | S2 | Open redirect in `/auth/callback?next=` | SEC-089 | `639469f` Fix D-18: open redirect in /auth/callback?next= |
| D-19 | S2 | Branding path traversal | SEC-054 | `4c1a088` Fix D-19: branding paths must be exactly <tenant>/<logo/letterhead>.<png/jpg/jpeg><br>`7599962` Fix D-19 (upload route): refuse branding uploads before storing; sign only exact branding paths<br>`22b896b` Integration: branding upload uses the engine's canRun rule (D-08/D-19); SEC-084 checks the six-tenant allow-list |
| D-20 | S2 | CSV formula injection | SEC-053 | `2c8cb6e` Fix D-20: CSV formula injection on export<br>`bb1120e` Fix D-20 (import side): re-importing our CSV export drops the guard quote |
| D-21 | S2 | Audit records the editable display name | SEC-066 | `9762270` Fix D-21: audit entries store the member's user id, with the name for display<br>`bf073cd` Fix D-21 (UI): Audit history shows the actor's display name |
| D-22 | S2 | Back after sign-out shows workspace content | AUTH-019 | `481f9a9` Fix D-22: Back after sign-out shows workspace content |
| D-23 | S3 | Raw "[DecimalError] Invalid argument" shown | PRD-014, PRD-031, PUR-007, SAL-009 | `b16436d` Fix D-23: invalid or empty numbers give a clean validation message |
| D-24 | S3 | Draft and cancelled documents print without a status | PRN-020, PRN-021 | `841218f` Fix D-24: drafts and cancelled documents print with a status mark |
| D-25 | S3 | Bounced cheque missing from the statement | RPT-053 | `caf0656` Fix D-25: statement shows a bounced cheque and its reversal<br>`3ce7a34` D-25 follow-up: label the reversal line "Cheque bounced · <cheque no.>" |
| D-26 | S3 | Sales analysis ignores commission splits | RPT-072 | `7fea069` Fix D-26: sales analysis by salesperson apportions commission splits |
| D-27 | S3 | Omitted `taxRate` defaults to 18% on a company with no tax rate | SET-085 | `a339557` Fix D-27: an omitted line taxRate takes the company tax rate, or 0 when blank |
| D-28 | S3 | Salesperson's "No, don't save" fails on a fresh company | PTY-030 | `8dd8caf` Fix D-28: "No, don't save" books to the walk-in account inside create_document |
| D-29 | S3 | Whitespace-only names are stored empty | PRD-095, DAT-075 | `8171e7d` Fix D-29: trim party names, product names and SKUs before their length checks |
| D-30 | S3 | Unexpected errors return 400 with raw text and are not logged | SEC-068, DAT-060 | `2554cf8` Fix D-30: unexpected errors return 400 with raw text and are not logged<br>`48f384f` Fix D-30 follow-up: keep the API error helper inside the workspace route folder |
| D-31 | S3 | Session cookies readable by JavaScript | AUTH-065 | `1a97c9a` Fix D-31: session cookies are HttpOnly; sign-in and password reset run on the server |
| D-32 | S3 | Workspace POST accepts any content type | SEC-046 | `c7c0f13` Fix D-32: workspace POST accepts any content type |
| D-33 | S3 | Command dropped if the browser closes mid-request | DAT-058 | `25642bb` Fix D-33: command dropped if the browser closes mid-request |
| D-34 | S3 | 401 in another tab shows an error, not the login | AUTH-049 | `79baa3a` Fix D-34: a 401 from a command sends the member to sign in |
| D-35 | S3 | Phone top bar is wider than the screen | UIX-001, UIX-005, UIX-099, ONB-067, ONB-069 | `edd2226` Fix D-35: phone top bar no longer wider than the screen |
| D-36 | S3 | Large data sets render slowly | INV-086, COL-084, NAV-028, PTY-098 | `6f32777` Fix D-36 (invoice editor): cap customer suggestions at 50 and filter by the typed text<br>`c3f5fe3` Fix D-36 (inventory): one pass over stock moves and paged stock tables<br>`5baf9de` Fix D-36 (global search): index once per workspace, capped scans<br>`a4f7856` Fix D-36 (collections): customer receipts draw 100 rows at a time |
| D-37 | S3 | 20 MB CSV freezes the tab before being refused | PRD-076 | `74fa657` Fix D-37: refuse an oversized CSV after its first chunk |
| D-38 | S3 | Search dialog keyboard and record opening | NAV-015, NAV-026, NAV-027 | `bfce3bd` Fix D-38: search keyboard selection opens the chosen record<br>`d8e76ce` D-38 follow-up: search opens suppliers and products on their tab |
| D-39 | S3 | Search does not cover journals, cheques or shipments | ACC-053, COL-076, IMP-056 | `d84060c` Fix D-39: search covers cheques, shipments and journals |
| D-40 | S3 | Missing list filters and sort | COL-075, IMP-082, IMP-083 | `18f5c71` Fix D-40: receipt and shipment filters; shipments newest first |
| D-41 | S3 | No customs/GD lookup (simulated) | IMP-037 | `47f318b` D-41: withdraw the customs/GD lookup case (out of scope); test asserts no lookup is offered |
| D-42 | S3 | Overdue supplier bills not in the attention queue | PUR-070 | `37eee78` Fix D-42: overdue supplier bills in Needs attention |
| D-43 | S3 | Report printing is unusable | RPT-011, RPT-048 | `7bc61a4` Fix D-43: reports print cleanly with a company header |
| D-44 | S3 | No per-employee payroll lines view | PAY-063 | `6d2c746` Fix D-44 and D-10 (UI): payroll run lines, Cancel run, month picker |
| D-45 | S3 | Focus is lost when a dialog closes | UIX-030 | `ecfdf24` Fix D-45: return focus to the opener when a dialog closes |
| D-46 | S3 | Notice off-screen on phone | UIX-089 | `2329e34` Fix D-46: the shell notice stays in view after an action |
| D-47 | S3 | Colour contrast failures | UIX-024, UIX-027, UIX-092 | `b69fe40` Fix D-47 (printed labels): document label colours meet 4.5:1<br>`2574eff` Fix D-47 (forms): scroll regions are focusable, labelled regions<br>`bcb57df` Fix D-47: danger colour, setup footer and scroll-region focus meet contrast<br>`3d5e9d4` UIX-092 passes after integration (D-47 tokens, focusable scroll regions)<br>`bc52259` Fix D-47 (workbench tables): Cheques in hand scroll region is focusable |
| D-48 | S3 | Stale setup card in a second session | ONB-088 | `7b93bd0` Fix D-48: a stale setup card opens the finished workspace |
| D-49 | S4 | Offline errors read "Failed to fetch" | AUTH-061, ONB-093 | `2a723cf` Fix D-49 (login): offline sign-in says "No internet connection", not "Failed to fetch"<br>`b42d9f6` Fix D-49 (branding): offline uploads say there is no internet connection |
| D-50 | S4 | Forgot password with empty email sends a request | AUTH-032 | `851ef89` Fix D-50: "Forgot password" checks the email address before sending anything |
| D-51 | S4 | Login submit enabled before hydration | AUTH-083 | `fb601a7` Fix D-51: login buttons stay disabled until the page has hydrated |
| D-52 | S4 | Refreshing `/account/reset` after success shows the form again | AUTH-084 | `0a0988e` Fix D-52: refreshing /account/reset after a successful change shows the finished state |
| D-53 | S4 | Reduced motion stops the provisioning ring | ONB-061 | `acda99b` Fix D-53: reduced motion slows the provisioning ring instead of freezing it |
| D-54 | S4 | `set_modules` silently drops unknown keys | ONB-077 | `51aaaad` Fix D-54: set_modules refuses unknown module keys |
| D-55 | S4 | Follow-up accepted on a supplier | COL-053 | `0827d6b` Fix D-55: follow-ups only for customers |
| D-56 | S4 | Metric cards never stagger | NAV-037, UIX-053 | `b763fd9` Fix D-56: metric cards stagger in by 40 ms |
| D-57 | S4 | Internal wording visible | NAV-043, PAY-094 | `3ae6558` Fix D-57 (engine message): create_payroll says "Payroll calculated."<br>`7ee57b3` Fix D-57 (settings): drop the internal Revision label from Settings → Access |
| D-58 | S4 | Long company name wraps in the switcher | NAV-082, UIX-083 | `1f8d3a2` Fix D-58: long company name ends in an ellipsis in the sidebar switcher |
| D-59 | S4 | Escape does not close the phone drawer | NAV-054 | `c09c9c1` Fix D-59: Escape closes the phone drawer |
| D-60 | S4 | "Draft sales documents" link does not preset the filter | NAV-076 | `0cfecb2` Fix D-60: "Draft sales documents to submit" opens Sales filtered to drafts |
| D-61 | S4 | Phone search input is 15.2 px (iOS zooms on focus) | NAV-080 | `01ca4b8` Fix D-61: search input is 16px on touch and phone |
| D-62 | S4 | Tablet Overview overflows (799 px at 768) | UIX-003 | `4e425a7` Fix D-62: tablet Overview metric tiles wrap two per row |
| D-63 | S4 | Phone sheets keep 20 px bottom corners | CSH-051, PRN-062 | `e2467dd` Fix D-63: phone bottom sheets have square bottom corners |
| D-64 | S4 | Sticky hover shadow after a tap | CSH-095 | `3e14196` Fix D-64: card hover only with a mouse; hover lift works after the entrance |
| D-65 | S4 | Negative bank balance not red | CSH-050 | `2e5912e` Fix D-65: overdrawn bank and cash balances show in red |
| D-66 | S4 | Payroll status badges share a colour | PAY-064 | `4307b47` Fix D-66: payroll status badges each have their own colour |
| D-67 | S4 | Trial balance columns left-aligned | ACC-091 | `c1af150` Fix D-67: amount columns in workspace tables are right-aligned |
| D-68 | S4 | Set-quantity dialog lacks the current value | INV-063 | `12944f0` Fix D-68: set-quantity dialog shows the current stock value |
| D-69 | S4 | Branding preview font differs from print | SET-069 | `e43b5a1` Fix D-69: branding preview uses the print font |
| D-70 | S4 | Features tab has no "N turned on" count | SET-075 | `e537107` Fix D-70: Settings → Features shows how many modules are turned on |
| D-71 | S4 | Stray border radii (3/4/5/8/9 px) | UIX-062 | `d181756` Fix D-71: border radii follow the 6/10/14/20 scale |
| D-72 | S4 | Default (blue) focus ring on scroll regions | UIX-029 | `0813c06` Fix D-72: violet focus ring on scroll regions (UIX-029)<br>`e7ea962` D-72 follow-up: violet focus ring on any tabbable region wrapper |
| D-73 | S4 | Empty states offer no next action | UIX-059 | `63ecfb8` Fix D-73 (forms): empty states in lists offer the next step<br>`e60180f` Fix D-73 (workbench): empty tables offer the next step |
| D-74 | S4 | Printed quantities lack thousands separators | PRN-016 | `51aec86` Fix D-74: printed quantities carry thousands separators |
| D-75 | S4 | Company address newlines lost in the print header | PRN-091 | `9fc8272` Fix D-75: company address line breaks print in the header |
| D-76 | S4 | Document-chain rows are not links | PRN-056 | `85331a5` Fix D-76: document-chain rows open their document |
| D-77 | S2 | An expiring session is refreshed but not saved (found during fix verification) | AUTH-050 | `a0da162` Fix D-77: session-refresh proxy saves refreshed Supabase sessions |
| D-78 | S4 | Production CSS drops the standard backdrop-filter (found during fix verification) | SET-041 | `8bcf73e` Fix D-78: prefixed backdrop-filter first so the production minifier keeps the standard property |

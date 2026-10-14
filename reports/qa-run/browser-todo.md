# Browser cases to run (316)

Generated from reports/qa-run/results.json. Columns: ID | P | Case | Expected | What the engine pass said to check in the browser.


## Sign-in, password reset, sessions (AUTH)

| ID | P | Case | Expected | Note |
|---|---|---|---|---|
| AUTH-002 | P1 | Sign in with valid email and password | Lands on the member's own company (Overview or setup card); no error | valid sign-in lands on own company (Overview or setup card) without error |
| AUTH-003 | P1 | Wrong password | Error under the form; stays on login; password field kept focusable; no page reload | wrong password shows error under the form, stays on login, no reload |
| AUTH-004 | P1 | Unknown email | Same generic error as wrong password (no account enumeration) | unknown email shows the same generic error as wrong password (hosted Supabase message) |
| AUTH-007 | P2 | Email with surrounding spaces `  user@x.com  ` | Trimmed and accepted | email with surrounding spaces is trimmed by type=email and accepted |
| AUTH-008 | P2 | Email in different case `USER@X.COM` | Accepted (Supabase emails are case-insensitive) | upper-case email signs in (Supabase case-insensitive) |
| AUTH-009 | P3 | Password with leading/trailing spaces | Not trimmed; must match exactly what was set | password with leading/trailing spaces is not trimmed |
| AUTH-010 | P2 | 200-character password | Accepted if it matches; no truncation | 200-character password accepted when it matches |
| AUTH-011 | P2 | SQL-ish email `' OR 1=1--@x.com` | Generic failure; no 500 | SQL-ish email ' OR 1=1--@x.com gives generic failure, no 500 |
| AUTH-012 | P2 | Script tag in email field | Rendered as text in any error; no XSS | script tag in email renders as text in any error |
| AUTH-013 | P2 | Unicode email local part | Rejected by email validation or generic failure; no crash | Unicode email local part rejected or generic failure, no crash |
| AUTH-014 | P2 | Toggle password visibility (eye icon) | Characters shown/hidden; cursor position kept | eye toggle shows/hides characters and keeps the cursor |
| AUTH-016 | P2 | Press Enter in password field | Submits the form | Enter in password field submits |
| AUTH-017 | P2 | Double-click "Sign in securely" | One request; button shows spinner and is disabled while busy | double-click sends one request; spinner and disabled while busy |
| AUTH-018 | P1 | Sign in, reload the page | Still signed in (cookie session) | reload keeps the cookie session |
| AUTH-019 | P1 | Sign out from the sidebar profile button | Returns to login; back button does not show workspace content | sign out from sidebar profile returns to login; Back does not show workspace content |
| AUTH-033 | P2 | Forgot password with unknown email | Same confirmation text (no enumeration) | forgot password for unknown email shows the same confirmation text |
| AUTH-036 | P1 | Set new password of 8 chars | Saved; can sign in with it; old password fails | set an 8-char password via reset link; new works, old fails |
| AUTH-037 | P1 | New password of 7 chars | Refused with length message | 7-char new password refused with length message |
| AUTH-038 | P2 | New password empty | Blocked | empty new password blocked |
| AUTH-041 | P1 | Open reset page without a valid session | "Expired" state with link back to login | reset page without a session shows expired state with link to login |
| AUTH-042 | P2 | Reuse the reset link after success | Expired state | reused reset link shows expired state |
| AUTH-049 | P2 | Sign out in one tab, act in another tab | Other tab's next command gets 401 and the UI shows the login | sign out in one tab; other tab next command gets 401 and shows login |
| AUTH-051 | P2 | Two accounts in two browsers simultaneously | Independent sessions; each sees only its memberships | two accounts in two browser contexts see only their own memberships |
| AUTH-052 | P2 | Same account in two tabs | Both work; commands from both apply | same account in two tabs; commands from both apply |
| AUTH-053 | P3 | Login page at 390px wide | Single column, inputs 16px font, no zoom on focus, no horizontal scroll | login at 390px: single column, 16px inputs, no horizontal scroll |
| AUTH-058 | P3 | Reduced-motion OS setting | No slide animations on login | reduced-motion: no slide animations on login |
| AUTH-060 | P2 | Browser back after signing in | Does not return to the login form with the app signed in | Back after sign-in does not show the login form while signed in |
| AUTH-061 | P2 | Sign in while offline | Clear network error; retry works when online | sign in offline shows network error; retry works online |
| AUTH-062 | P2 | Sign in while Supabase auth is slow (>10s) | Spinner persists; no duplicate submit; eventually resolves | slow auth (>10s): spinner persists, no duplicate submit |
| AUTH-063 | P2 | Inspect network: password sent only over HTTPS to Supabase | No password in URL or logs | network inspection: password only in HTTPS body to Supabase, never in URL/logs |
| AUTH-066 | P1 | Reset-password flow for a user, then sign in as another user in same browser | No cross-user leakage | reset flow for one user then sign in as another in same browser: no leakage |
| AUTH-073 | P3 | Error message wording for wrong password | Plain English, no Supabase internals | wrong-password copy is plain English (shows raw Supabase error.message today) |
| AUTH-074 | P3 | Focus ring on inputs | Violet ring, visible with keyboard | violet focus ring visible with keyboard |
| AUTH-076 | P2 | Email 254 chars | Accepted by validation or clear error | 254-char email accepted or clear error |
| AUTH-077 | P2 | Paste email with newline | Newline stripped or rejected; no crash | pasted email with newline stripped or rejected |
| AUTH-078 | P3 | Emoji as password | Works if it was set that way | emoji password works if set that way |
| AUTH-084 | P2 | Refresh on `/account/reset` after a successful change | Shows expired/complete state, not the form | refresh /account/reset after success shows expired/complete state |
| AUTH-088 | P2 | Sign in with an email that has a plus tag `a+qa@x.com` | Works | plus-tag email a+qa@x.com signs in |
| AUTH-090 | P2 | Sign out while a command is in flight | Command may complete server-side; UI returns to login without error | sign out while a command is in flight returns to login without error |
| AUTH-093 | P2 | Deep link `/print/...` then sign in | After sign-in the user reaches the app (returning to the deep link is acceptable) | deep link /print/... then sign in reaches the app |
| AUTH-096 | P2 | Very slow network (3G throttle) | Login usable; no duplicate submissions | 3G throttle: login usable, no duplicate submissions |

## Onboarding wizard and provisioning (ONB)

| ID | P | Case | Expected | Note |
|---|---|---|---|---|
| ONB-016 | P2 | Back from step 2 to step 1 | Fields show saved values; slide-left transition | Back from step 2 shows saved step-1 values with slide-left transition |
| ONB-044 | P2 | Selected tile has violet outline and lifted shadow | Yes | selected tile has violet outline and lifted shadow |
| ONB-047 | P2 | Edit from Review → step 1, change name, Continue through | Review reflects change | Edit from Review → step 1, change name, continue through; Review shows the change |
| ONB-048 | P1 | "Create my workspace" | Provisioning screen: ring, "Setting up {company}", staggered module lines; stays ≥2.6s | "Create my workspace" shows provisioning ring, "Setting up {company}", staggered lines for ≥2.6 s |
| ONB-060 | P2 | Provisioning lines equal selected modules + "Opening your books" + "Preparing your workspace" | Yes | provisioning lines = selected modules + "Opening your books" + "Preparing your workspace" |
| ONB-061 | P2 | Reduced motion | Lines appear without stagger; ring slow | reduced motion: provisioning lines without stagger, slow ring |
| ONB-066 | P2 | Search excludes records of off modules | Yes | global search excludes records of modules that are off |
| ONB-067 | P2 | Card on 390px phone | Fills screen; step titles collapse to numbers except current; sticky footer buttons; no horizontal scroll | setup card at 390px: full screen, numbered steps, sticky footer, no horizontal scroll |
| ONB-068 | P2 | Card on iPad portrait | Centred with scrim; both columns on Documents step | setup card on iPad portrait: centred with scrim, two columns on Documents |
| ONB-069 | P2 | Documents step on phone | Preview below the form; scrollable inside card | Documents step on phone: preview below form, scrollable in card |
| ONB-070 | P2 | Backdrop | Dashboard visible but blurred; not clickable; not focusable with Tab (`inert`) | backdrop blurred, not clickable, not focusable (inert) |
| ONB-072 | P2 | Switch to another company from the footer | Navigates with `?tenant`; wizard state of the first is kept | switch company from the wizard footer keeps the first company's wizard state |
| ONB-073 | P2 | Sign out from the wizard | Login screen | Sign out from the wizard returns to the login screen |
| ONB-074 | P2 | Escape key on the card | Does nothing (setup cannot be dismissed) | Escape on the setup card does nothing |
| ONB-085 | P2 | Step transition forward slides from right, back from left | Yes | step transition forward slides from right, back from left |
| ONB-088 | P2 | Owner finishes setup while a second member is on the card in another browser | Second member's next action shows the workspace | owner finishes setup while a second member is on the card; the second member's next action shows the workspace |
| ONB-093 | P2 | Logo upload while offline | Clear error; can retry | logo upload while offline shows a clear error and can be retried |
| ONB-099 | P2 | Setup with All features on a slow connection | Provisioning completes; UI never shows a half-provisioned sidebar | All features on a slow connection: provisioning completes, no half-provisioned sidebar |

## Settings: company & documents, features, access, audit (SET)

| ID | P | Case | Expected | Note |
|---|---|---|---|---|
| SET-012 | P2 | Edit, then switch tab without saving | Changes lost without crash (acceptable) or kept; no partial save | edit, switch tab without saving: changes dropped or kept, never partially saved |
| SET-027 | P2 | Cancel the hide dialog | Switch stays on | Cancel on the hide dialog leaves the switch on |
| SET-028 | P2 | Press Escape on the hide dialog | Closes, no change | Escape closes the hide dialog with no change |
| SET-033 | P2 | Hidden module's records in search | Not shown | records of a hidden module do not appear in search |
| SET-040 | P2 | Tiles in Settings use the same colours as sidebar | Yes | Settings tiles use the same colours as the sidebar |
| SET-041 | P2 | Dialog backdrop blurred and tinted | Yes | hide dialog backdrop blurred and tinted |
| SET-042 | P2 | Dialog on phone | Bottom sheet; password input 16px | hide dialog on phone is a bottom sheet with 16px password input |
| SET-043 | P2 | Access tab: company name, tax id, revision | Correct | Access tab shows company name, tax id and revision |
| SET-044 | P2 | "View as role" | Enabled only for Owner in a demo company | "View as role" enabled only for the Owner of a demo company |
| SET-045 | P2 | View as Salesperson | Sidebar reduces; "Previewing as Salesperson" chip; Exit preview | View as Salesperson: reduced sidebar, "Previewing as Salesperson" chip, Exit preview |
| SET-060 | P2 | Active tab violet underline | Yes | active tab has a violet underline |
| SET-069 | P2 | Branding preview typography/colours match print | Yes | branding preview typography/colours match print |
| SET-075 | P2 | Settings → Features counts "N turned on" | Matches | Settings → Features shows an "N turned on" count matching the switches (no such count found in FeaturesSettings; verify) |
| SET-076 | P2 | Long module descriptions wrap in tiles | Yes | long module descriptions wrap inside tiles |
| SET-079 | P2 | Hide module while that module's view is open | View closes to Overview; no blank page | hiding the module whose view is open returns to Overview, no blank page |
| SET-080 | P2 | Settings on a company still in setup | Not reachable (setup card) | Settings is not reachable while the company is still in setup (setup card) |
| SET-090 | P2 | Error notice from a failed save is red | Yes (noticeError) | error notice from a failed save is red (noticeError) |
| SET-091 | P2 | Success notice is neutral/green | Yes | success notice is neutral/green |
| SET-092 | P2 | Notice clears when the next command starts | Yes | notice clears when the next command starts |

## Products, opening stock, CSV import/export (PRD)

| ID | P | Case | Expected | Note |
|---|---|---|---|---|
| PRD-053 | P2 | Clear filters link | Resets | "Clear filters" resets search and status |
| PRD-054 | P2 | Table on phone | Horizontal scroll hint; first column bold | products table on phone: horizontal scroll hint, bold first column |
| PRD-076 | P2 | 20 MB CSV | Refused or streamed; no browser freeze | 20 MB CSV is refused or parsed without freezing the browser |
| PRD-088 | P2 | Placeholders grey, typed values dark | Yes | placeholders grey, typed values dark |
| PRD-090 | P2 | Dialog on phone is a bottom sheet with sticky actions | Yes | product dialog on phone is a bottom sheet with sticky actions |
| PRD-091 | P2 | Cancel after typing | Nothing saved | Cancel after typing saves nothing |
| PRD-092 | P2 | Escape closes | Nothing saved | Escape closes the dialog and saves nothing |
| PRD-093 | P2 | Submit with Enter in SKU field | Saves | Enter in the SKU field submits and saves |

## Customers and suppliers, walk-in names, credit limits (PTY)

| ID | P | Case | Expected | Note |
|---|---|---|---|---|
| PTY-031 | P1 | Invoice editor: type existing name exactly | Matched; hint shows city/phone/terms; no prompt | typing an existing name exactly matches it; hint shows city/phone/terms; no prompt |
| PTY-032 | P1 | Type existing name in different case | Matched | typing an existing name in a different case matches it |
| PTY-033 | P1 | Type a new name, Submit | "Save customer?" dialog with No/Yes | typing a new name then Submit opens "Save customer?" with No/Yes |
| PTY-041 | P2 | Change the name after answering | Prompt asked again for the new name | changing the name after answering asks again for the new name |
| PTY-048 | P2 | Typed name equals an existing customer but with extra inner spaces | Not matched (exact trimmed compare) → prompt; acceptable | typed name with extra inner spaces is not matched and prompts |
| PTY-053 | P2 | Cancel the Save dialog (X) | Back to editor; nothing saved | closing the Save dialog (X) returns to the editor with nothing saved |
| PTY-054 | P2 | Dialog copy mentions the typed name and walk-in account | Yes | dialog copy mentions the typed name and the walk-in account |
| PTY-056 | P2 | City and phone optional fields appear only for new names | Yes | city and phone fields appear only for new names |
| PTY-074 | P2 | Customers table phone column on phone width | Scrolls | customers table phone column scrolls at phone width |
| PTY-075 | P2 | Receipt dialog lists only customers (not suppliers) | Yes | receipt dialog lists only customers |
| PTY-076 | P2 | Payment dialog lists only suppliers | Yes | payment dialog lists only suppliers |
| PTY-077 | P2 | Follow-up dialog lists customers only | Yes | follow-up dialog lists customers only |
| PTY-088 | P2 | Two customers "Ali Traders" and "Ali Traders Ltd" | Typing "Ali Traders" matches the exact one | with "Ali Traders" and "Ali Traders Ltd", typing "Ali Traders" matches the exact one |
| PTY-089 | P2 | Datalist suggestions show city · phone | Yes | datalist suggestions show city · phone |
| PTY-090 | P2 | Suggestions on iOS Safari | Datalist works or free text still saves | suggestions on iOS Safari: datalist works or free text still saves |
| PTY-098 | P2 | 10,000 customers | Suggestion datalist still usable (or capped with search) | 10,000 customers: suggestion datalist still usable (or capped with search) |

## Inventory: stock, transfers, corrections, valuation, warehouses (INV)

| ID | P | Case | Expected | Note |
|---|---|---|---|---|
| INV-041 | P2 | Stock level filter Available / Low / Out | Correct sets | stock level filter Available / Low / Out shows the right sets |
| INV-042 | P2 | Category filter | Works | category filter narrows the Stock list |
| INV-043 | P2 | Search by SKU | Works | Stock search by SKU |
| INV-051 | P2 | Branch picker appears in header only with ≥2 branches | Yes | branch picker appears in the header only with ≥2 branches |
| INV-052 | P2 | Branch picker filters documents/stock | Yes | branch picker filters documents and stock |
| INV-056 | P2 | Document warehouse select hidden when single | Yes | document warehouse select is hidden with a single warehouse |
| INV-061 | P2 | Item details on phone | Sections stack; history scrolls | item details on phone: sections stack, history scrolls |
| INV-062 | P2 | Set quantity dialog closes on success | Yes | set-quantity dialog closes on success |
| INV-063 | P2 | Set quantity dialog shows current qty and value | Yes | set-quantity dialog shows the current quantity and value |
| INV-087 | P2 | 50,000 movements for one item | History paginates/scrolls; no freeze | 50,000 movements for one item: history stays responsive (Item details shows the newest 20) |
| INV-095 | P2 | 50 warehouses | Selects remain usable | 50 warehouses: selects remain usable |

## Sales documents and the invoice editor (SAL)

| ID | P | Case | Expected | Note |
|---|---|---|---|---|
| SAL-015 | P1 | Price prefilled from product | Yes; editable | price prefilled from the product and editable |
| SAL-016 | P2 | Product with price 0 | Price field empty with placeholder 0.00 | product with price 0 shows empty price with placeholder 0.00 |
| SAL-025 | P2 | Default tax from settings prefilled on sales lines | Yes when configured | default tax rate from Settings prefilled on new sales lines |
| SAL-067 | P2 | Document list filters: type, status, customer, dates, search | Combine correctly; Clear filters | document list filters (type, status, customer, dates, search) combine; Clear filters |
| SAL-069 | P2 | List ordering newest first | Yes | list ordering newest first |
| SAL-070 | P2 | View → details: chain, lines, totals, payments, returns | Correct | details view shows chain, lines, totals, payments and returns |
| SAL-071 | P2 | Details Print button | Opens print view | details Print button opens the print view |
| SAL-074 | P2 | Editor on phone | Bottom sheet; line table scrolls horizontally; sticky actions | editor on phone: bottom sheet, line table scrolls horizontally, sticky actions |
| SAL-075 | P2 | Three buttons: Cancel, Save draft (outline), Submit (violet) | Yes | three buttons Cancel, Save draft (outline), Submit (violet) |
| SAL-076 | P2 | Spinner on the pressed button only | Yes | spinner only on the pressed button |
| SAL-077 | P2 | Placeholders Qty / 0.00 / 0 / 0 | Yes | placeholders Qty / 0.00 / 0 / 0 |
| SAL-078 | P2 | Unit hint under qty after product chosen | Yes | unit hint under qty after product chosen |
| SAL-079 | P2 | Line total and Net/Tax/Total formatting | `Rs 4,500` | line total and Net/Tax/Total formatted like Rs 4,500 |
| SAL-080 | P2 | Escape closes editor with unsaved changes | Closes (no confirm) — document | Escape closes the editor with unsaved changes (no confirm) — document |
| SAL-081 | P2 | Overview "Recent sales" shows last 5 | Yes with walk-in names | Overview "Recent sales" shows last 5 with walk-in names |

## Purchasing, foreign currency, supplier payments (PUR)

| ID | P | Case | Expected | Note |
|---|---|---|---|---|
| PUR-013 | P2 | Rate placeholder "e.g. 280" shown when empty | Yes | rate placeholder "e.g. 280" shown when empty |
| PUR-053 | P2 | Due date = date + supplier terms | Yes | due date defaults to date + supplier terms (computed by the editor; engine stores what is sent) |
| PUR-067 | P2 | Purchasing list filters by type/status/supplier/date | Yes | purchasing list filters by type/status/supplier/date |
| PUR-069 | P2 | Supplier payments tab lists payments | Yes with status | Supplier payments tab lists payments with status |
| PUR-070 | P2 | Bill overdue in attention queue | Yes when past due | overdue bill in the attention queue (code review: workbench.tsx attentionItems has no supplier-bill entry — likely fails) |
| PUR-071 | P2 | Receive dialog shows remaining per line | Yes | Receive dialog shows remaining per line |
| PUR-075 | P2 | Warehouse select on PO hidden when single | Yes | warehouse select hidden on PO when only one warehouse |
| PUR-084 | P2 | Payment dialog shows open bills with outstanding | Oldest first; amount spreads oldest-first on typing total | payment dialog lists open bills oldest first; typed total spreads oldest first |
| PUR-085 | P2 | "PKR actually paid" only for non-PKR bills | Yes | "PKR actually paid" only for non-PKR bills (code review: document-dialogs.tsx shows it for every supplier payment — likely fails; see PUR-032) |
| PUR-086 | P2 | Editor on phone | Usable | purchase editor usable on phone |
| PUR-097 | P2 | 500 POs in list | Filters < 1 s | 500 POs in the list; filters respond < 1 s |

## Imports and landed cost (IMP)

| ID | P | Case | Expected | Note |
|---|---|---|---|---|
| IMP-035 | P2 | Shipment list columns: shipment, supplier, container/GD, ETA, status, unallocated | Correct totals | shipment list columns: shipment, supplier, container/GD, ETA, status, unallocated |
| IMP-037 | P2 | Customs lookup (simulated) shows GD lookup result | No "simulated" banner on the page any more; lookup still returns stub data | customs/GD lookup (simulated) result (code review: no customs lookup exists anywhere in src — likely fails) |
| IMP-053 | P2 | Shipment table on phone | Scroll hint | shipment table on phone shows scroll hint |
| IMP-054 | P2 | Add cost dialog placeholders | Amount empty with placeholder | add-cost dialog: amount empty with placeholder (code review: no add-cost dialog found in src/components) |
| IMP-055 | P2 | Classification help text | Explains each | classification help text explains each class |
| IMP-056 | P2 | Search finds shipment by number/container | Yes | search finds shipment by number/container |
| IMP-057 | P2 | Attention queue: shipments with unallocated costs | Listed | attention queue lists shipments with unallocated costs |
| IMP-082 | P2 | Shipment list sorting newest first | Yes | shipment list sorted newest first |
| IMP-083 | P2 | Filter by status | Works | shipment filter by status |
| IMP-084 | P2 | 200 shipments | List OK | 200 shipments list renders |
| IMP-088 | P2 | Shipment keyboard navigation | Buttons reachable | shipment actions reachable by keyboard |
| IMP-089 | P2 | Status badges colours | Pastel per status | pastel status badge colours per status |
| IMP-097 | P2 | Export shipments CSV (if present) | Columns correct | export shipments CSV if present (code review: no shipment CSV export found) |
| IMP-098 | P2 | Attention item link opens Imports | Yes | attention item link opens Imports |

## Collections: receipts, cheques (PDC), follow-ups (COL)

| ID | P | Case | Expected | Note |
|---|---|---|---|---|
| COL-002 | P1 | Typing total spreads across open invoices oldest first | Allocation auto-filled; editable | typing a total spreads it across open invoices oldest first; allocations editable |
| COL-031 | P2 | Cheques in hand list: received/deposited with actions | Buttons per state | cheques in hand list (received/deposited) with per-state buttons |
| COL-032 | P2 | Attention: cheques due today/overdue | Listed | attention: cheques due today/overdue listed |
| COL-054 | P2 | Follow-up list per customer newest first | Yes | follow-up list per customer newest first |
| COL-055 | P2 | Follow-up dialog closes on success | Yes (follow_up auto-close) | follow-up dialog closes on success |
| COL-065 | P2 | Receipt dialog on phone | Bottom sheet; allocations table scroll | receipt dialog on phone: bottom sheet, allocations table scrolls |
| COL-066 | P2 | Method radio/select shows cheque fields only for cheque | Yes | cheque fields shown only for method cheque |
| COL-067 | P2 | Account select lists bank and cash accounts, not archived | Yes | account select lists bank and cash accounts, not archived |
| COL-068 | P2 | Amount placeholder | Empty with placeholder | amount field empty with placeholder |
| COL-070 | P2 | Cheque register also visible in Cash & bank | Same data | cheque register also visible in Cash & bank with the same data |
| COL-075 | P2 | Receipts list filters by method/status | Yes | receipts list filters by method/status |
| COL-076 | P2 | Search by cheque number | Found | search by cheque number |
| COL-084 | P2 | 5,000 receipts | List/aging < 2 s | 5,000 receipts: list and aging render < 2 s |
| COL-085 | P2 | Attention "Cheques due" count badge on bell | Matches | attention "Cheques due" count badge on the bell matches |
| COL-090 | P2 | Receipt for supplier via Collections | Not offered (Purchasing → Supplier payments) | Collections receipt dialog does not offer suppliers (Purchasing → Supplier payments) |
| COL-093 | P2 | Status badges: received amber, deposited info, cleared green, bounced red | Yes | status badge colours: received amber, deposited info, cleared green, bounced red |
| COL-094 | P2 | Receipt row actions by state | Deposit/Cleared/Bounced only valid ones | receipt row actions show only valid transitions |

## Cash and bank (CSH)

| ID | P | Case | Expected | Note |
|---|---|---|---|---|
| CSH-049 | P2 | Cards show type icon (bank/cash) | Yes | account cards show a bank or cash type icon |
| CSH-050 | P2 | Negative balance styled red | Yes | negative balance is styled red |
| CSH-051 | P2 | Dialogs on phone | Bottom sheets | cash & bank dialogs open as bottom sheets on a phone |
| CSH-052 | P2 | Transfer dialog closes on success | Yes | transfer dialog closes on success |
| CSH-053 | P2 | Expense dialog closes on success | Yes | expense dialog closes on success |
| CSH-066 | P2 | Account details text shows on card | Yes | account details text shows on the card |
| CSH-077 | P2 | Activity shows in/out columns with running balance | Yes | activity table shows In / Out columns with a running balance (engine rows verified in CSH-023) |
| CSH-078 | P2 | Memo truncation with tooltip | Readable | long memo truncates with a tooltip and stays readable |
| CSH-083 | P2 | Keyboard: Enter submits transfer form | Yes | Enter submits the transfer form |
| CSH-084 | P2 | Escape closes dialogs | Yes | Escape closes cash & bank dialogs |
| CSH-085 | P2 | Account select order | Bank first then cash or alphabetical; consistent | account select order is consistent (engine keeps creation order: bankAccounts array) |
| CSH-094 | P2 | Mobile card tap opens activity | Yes | tapping an account card on mobile opens its activity |
| CSH-095 | P2 | Card hover lift only with mouse | Yes | card hover lift only with a mouse (no sticky hover on touch) |

## Commissions (COM)

| ID | P | Case | Expected | Note |
|---|---|---|---|---|
| COM-081 | P2 | Entitlement badges earned/released/approved | Colours | entitlement badges earned / released / approved use distinct colours |
| COM-084 | P2 | Plan form shows only fields for its type | Yes or all; consistent | plan form shows fields for its type consistently |
| COM-085 | P2 | Salesperson "View as" preview from Owner | Entitlements filtered | Owner "View as" Salesperson filters entitlements (projection verified in COM-043) |
| COM-089 | P2 | LIVE label in sidebar | Present on Commissions | LIVE label shows on Commissions in the sidebar |

## Payroll (PAY)

| ID | P | Case | Expected | Note |
|---|---|---|---|---|
| PAY-062 | P2 | Settings → Payroll visible only with Payroll on | Yes | Settings → Payroll section visible only while Payroll is on |
| PAY-063 | P2 | Lines table columns readable on phone | Scroll | payroll lines table scrolls horizontally and stays readable on a phone |
| PAY-064 | P2 | Status badges | Colours | payroll status badges use distinct colours |
| PAY-088 | P2 | Review button disabled while busy | Yes | transition button is disabled while a command is busy |
| PAY-089 | P2 | Line commission tooltip lists invoices | If present | line commission tooltip listing invoices (not present in the runs table) |
| PAY-096 | P2 | Keyboard flow through transitions | Buttons focusable | keyboard: payroll transition buttons are focusable and operable |

## Accounting: journals, reversals, periods, invariants (ACC)

| ID | P | Case | Expected | Note |
|---|---|---|---|---|
| ACC-053 | P2 | Journal search by memo/number | Works | journal search by memo or number |
| ACC-054 | P2 | Filter by date range | Works | journal list date-range filter (Accounting view shows the latest 8; Reports → General ledger has a date range) |
| ACC-090 | P2 | Journal detail on phone | Readable | journal detail is readable on a phone |
| ACC-091 | P2 | Debit/credit columns aligned, tabular numerals | Yes | debit/credit columns aligned with tabular numerals |

## Reports and CSV export (RPT)

| ID | P | Case | Expected | Note |
|---|---|---|---|---|
| RPT-011 | P2 | Statement print | Branded; company header; period | statement print is branded with company header and period |
| RPT-046 | P2 | Report link from Overview "Needs attention" | Opens correct report | Overview "Needs attention" link opens the correct report/queue |
| RPT-047 | P2 | Tables on phone | Horizontal scroll; totals visible | report tables scroll horizontally on a phone with totals visible |
| RPT-048 | P2 | Print a report | Clean print CSS | printing a report uses clean print CSS |
| RPT-049 | P2 | Reports hidden module | Sidebar gone; Overview unaffected | hiding Reports removes the sidebar entry; Overview unaffected |
| RPT-066 | P2 | Report parameters persist while switching tabs | Acceptable either way; no crash | report parameters while switching tabs (acceptable either way; no crash) |
| RPT-067 | P2 | Reports keyboard accessible | Yes | reports are keyboard accessible |
| RPT-077 | P2 | Number formatting with tabular numerals | Yes | report numbers use tabular numerals |
| RPT-079 | P2 | Totals row sticky/bold | Yes | totals row is bold / sticky |
| RPT-088 | P2 | Empty states text | Helpful, no jargon | empty-state text is helpful ("Nothing to report for these parameters.") |
| RPT-089 | P2 | Report selector on phone | Dropdown/tabs usable | report selector usable on a phone |
| RPT-090 | P2 | Deep link to a report (if routed) | Opens | deep link to a specific report (report choice is component state, not routed) |
| RPT-097 | P2 | Report refresh after a new command in another tab | Reflects on next load | reports reflect a command made in another tab on next load |

## Printing, PDF and document view (PRN)

| ID | P | Case | Expected | Note |
|---|---|---|---|---|
| PRN-038 | P2 | "Print / Save as PDF" button | Opens browser print; button itself hidden in print output | "Print / Save as PDF" opens the print dialog; the button is hidden in print output |
| PRN-039 | P2 | Print preview A4 portrait | Fits one page for 10 lines; page breaks for 60 lines without splitting a row | A4 portrait preview: 10 lines fit one page; 60 lines break without splitting a row |
| PRN-040 | P2 | Print preview Letter | Fits | Letter-size print preview fits |
| PRN-044 | P2 | 100-line invoice | Paginates; totals on last page | 100-line invoice paginates; totals on the last page |
| PRN-045 | P2 | Very long product name (120 chars) | Wraps within column | 120-char product name wraps within its column |
| PRN-046 | P2 | Notes 2,000 chars | Wraps; not clipped | 2,000-char notes wrap, not clipped |
| PRN-047 | P2 | Footer 500 chars | Wraps | 500-char footer wraps |
| PRN-048 | P2 | Company name 120 chars | Wraps; header intact | 120-char company name wraps; header intact |
| PRN-049 | P2 | Urdu/Arabic script names | Renders right-to-left glyphs correctly | Urdu/Arabic party names render right-to-left correctly |
| PRN-051 | P2 | Logo 1×1 px | Scales; no layout break | 1×1 px logo scales without breaking layout |
| PRN-052 | P2 | Logo very wide (2000×100) | Constrained | very wide 2000×100 logo is constrained |
| PRN-053 | P2 | Logo transparent PNG on accent background | Readable | transparent PNG logo readable |
| PRN-056 | P2 | Document chain shown in details (QUO → SO → DN → INV) | Links work | details dialog shows QUO → SO → DN → INV chain links |
| PRN-057 | P2 | Details: payments list with cheque status | Yes | details dialog lists payments with cheque status |
| PRN-058 | P2 | Details: returns list | Yes | details dialog lists returns |
| PRN-059 | P2 | Details: Submit/Return/Convert/Print buttons by state and role | Correct | details Submit/Return/Convert/Print buttons by state and role |
| PRN-060 | P2 | Details for walk-in invoice | Typed name | details for walk-in invoice show the typed name |
| PRN-061 | P2 | Details for cancelled draft | Reason in notes | details for a cancelled draft show the reason in notes |
| PRN-062 | P2 | Details dialog on phone | Bottom sheet; scroll | details dialog on phone is a scrollable bottom sheet |
| PRN-075 | P2 | Save as PDF filename suggestion | Document number (browser default acceptable) | Save as PDF suggested filename (from the tab title) |
| PRN-076 | P2 | Print page load < 1.5 s | Yes | print page loads in < 1.5 s |
| PRN-077 | P2 | Print page has no console errors | Yes | print page has no console errors |
| PRN-079 | P2 | Back from print returns to app state | Yes | back from print returns to app state (print opens in a new tab) |
| PRN-083 | P2 | Print via keyboard Ctrl/Cmd+P | Same output | Ctrl/Cmd+P gives the same output |
| PRN-087 | P2 | Two tabs printing different docs | Independent | two tabs printing different documents are independent |

## Shell: navigation, search, notifications, workspace switcher, Overview (NAV)

| ID | P | Case | Expected | Note |
|---|---|---|---|---|
| NAV-002 | P1 | Click each item | View changes; breadcrumb "Workspace › {Module}"; URL unchanged (SPA state) | clicking each item changes the view; breadcrumb "Workspace › {Module}"; URL unchanged |
| NAV-005 | P2 | Keyboard: Tab through nav, Enter activates | Yes | Tab through nav; Enter activates |
| NAV-008 | P1 | Workspace switcher lists memberships with demo tag | Yes; current highlighted | switcher menu lists memberships with demo tag; current highlighted |
| NAV-009 | P1 | Switch company | Navigates with `?tenant=`; data of the other company | switching company navigates with ?tenant= and shows the other company |
| NAV-010 | P2 | Switcher with one company | Shows company; menu has only that | switcher with one company shows only that company |
| NAV-014 | P1 | Search ⌘K / Ctrl+K opens | Instantly, no animation | ⌘K / Ctrl+K opens search instantly |
| NAV-015 | P1 | Search "INV-2026" | Documents listed; Enter opens the first | search "INV-2026" lists documents; Enter opens the first |
| NAV-016 | P2 | Search customer name | Customers and their documents | search customer name lists customer and documents |
| NAV-017 | P2 | Search walk-in typed name | Document found | search walk-in typed name finds the document |
| NAV-018 | P2 | Search product SKU | Product | search product SKU finds the product |
| NAV-019 | P2 | Search employee | Only for roles allowed | search employee only for allowed roles |
| NAV-020 | P2 | Search respects module gating | Hidden module records absent | search respects module gating |
| NAV-021 | P2 | Search respects role scoping (Salesperson sees own docs) | Yes | search respects role scoping (Salesperson sees own docs) |
| NAV-022 | P2 | Search empty string | Prompt text | empty search shows prompt text |
| NAV-023 | P2 | Search 2 chars | Results or "type more" | 2-char search shows results or "type more" |
| NAV-025 | P2 | Search Urdu | Matches | Urdu search matches |
| NAV-026 | P2 | Arrow keys move selection, Escape closes | Yes | arrow keys move selection; Escape closes |
| NAV-027 | P2 | Result click navigates to module and opens record | Yes | result click navigates to module and opens record |
| NAV-028 | P2 | Search with 20k records | < 100 ms per keystroke | search with 20k records < 100 ms per keystroke |
| NAV-030 | P2 | Bell menu lists items grouped; click goes to module | Yes | bell menu lists grouped items; click goes to module |
| NAV-048 | P2 | Branch picker filters views | Yes | branch picker filters views |
| NAV-050 | P2 | Notice clears on next command | Yes | notice clears on next command |
| NAV-051 | P1 | Phone: hamburger opens drawer with scrim | Drawer slides; scrim blurred; close X | phone: hamburger opens drawer with blurred scrim and close X |
| NAV-052 | P2 | Tap scrim closes | Yes | tap scrim closes drawer |
| NAV-053 | P2 | Tap item closes drawer and navigates | Yes | tap item closes drawer and navigates |
| NAV-054 | P2 | Escape closes drawer | Yes | Escape closes drawer |
| NAV-057 | P2 | Tabbed modules (Sales: Documents/Customers; Inventory: Stock/Products/Warehouses) | Tabs work; aria | tabbed modules (Sales, Inventory) switch tabs with aria-selected |
| NAV-058 | P2 | Tab state resets when switching module | Acceptable; no crash | tab state resets when switching module without crash |
| NAV-059 | P2 | View transition fade/slide on module change | Yes | view transition fade/slide on module change |
| NAV-060 | P2 | Browser back/forward | No broken state (SPA; stays on app) | browser back/forward leaves no broken state |
| NAV-061 | P2 | Reload keeps company (via cookie) but returns to Overview | Yes | reload keeps company but returns to Overview |
| NAV-062 | P2 | Deep link `?tenant` reload | Same company | deep link ?tenant reload keeps the company |
| NAV-063 | P2 | Preview as role chip and Exit | Only demo + Owner | preview-as-role chip and Exit only for demo + Owner |
| NAV-066 | P2 | Two dialogs (editor + confirm) stacking | Focus trapped in top one | stacked editor + confirm dialogs trap focus in the top one |
| NAV-068 | P2 | Dialog Escape | Closes | Escape closes dialogs |
| NAV-069 | P2 | Dialog overlay click | Closes (or not for editor — consistent) | overlay click behaviour consistent |
| NAV-071 | P2 | Module switch < 100 ms | Yes | module switch < 100 ms |
| NAV-072 | P2 | Console free of errors on every module | Yes | console free of errors on every module |
| NAV-073 | P2 | Hydration warnings none | Yes | no hydration warnings |
| NAV-074 | P2 | Workspace menu animation from trigger origin | Yes | workspace menu animates from trigger origin |
| NAV-076 | P2 | Attention item "Draft sales documents to submit" opens Sales filtered to drafts | Yes | "Draft sales documents to submit" opens Sales filtered to drafts (source navigates to Sales only) |
| NAV-080 | P2 | Search dialog on phone | Full-width; keyboard 16px input | search dialog on phone full-width with 16px input |
| NAV-081 | P2 | Bell on phone | Menu fits | bell menu fits on phone |
| NAV-082 | P2 | Long company name in switcher | Truncated with ellipsis | long company name truncated with ellipsis in switcher |
| NAV-083 | P2 | Many companies (10) in switcher | Scrollable | 10 companies in switcher scroll |
| NAV-084 | P2 | Sidebar scroll with all modules on small height | Scrolls; bottom profile visible | sidebar scrolls on small height; profile visible |
| NAV-085 | P2 | Module label "Imports & costing" wraps on narrow sidebar | OK | "Imports & costing" wraps on narrow sidebar |
| NAV-096 | P2 | Two tabs, command in one | Other tab updates on next command (revision) without data loss | two tabs: command in one, other tab updates on its next command without data loss |
| NAV-097 | P2 | Offline then command | Error notice; retry works | offline command shows error notice; retry works |
| NAV-099 | P2 | Zoom 200% desktop | Layout usable; no overlap | desktop zoom 200% usable without overlap |
| NAV-100 | P1 | End to end tour (docs/DEMO-TOUR.md) at desktop and phone | Completes without console errors | docs/DEMO-TOUR.md end to end at desktop and phone without console errors |

## Responsive, mobile, accessibility, motion (UIX)

| ID | P | Case | Expected | Note |
|---|---|---|---|---|
| UIX-001 | P1 | Every module at 390×844 | No horizontal page scroll (`scrollWidth ≤ innerWidth`) | every module at 390×844 has no horizontal page scroll |
| UIX-002 | P1 | Every module at 1440×900 | Layout as designed | every module at 1440×900 lays out as designed |
| UIX-003 | P2 | 768×1024 tablet | Sidebar visible or drawer; readable | 768×1024 tablet: sidebar or drawer, readable |
| UIX-004 | P2 | 1920×1080 | Content max width; no stretching | 1920×1080: content max width, no stretching |
| UIX-005 | P2 | 320px width | Usable; wraps | 320px width usable; wraps |
| UIX-008 | P1 | Dialogs on phone are bottom sheets with sticky actions | Yes | dialogs on phone are bottom sheets with sticky actions |
| UIX-028 | P1 | Keyboard: full app operable without mouse | Yes | whole app operable by keyboard |
| UIX-029 | P1 | Focus visible everywhere (violet ring) | Yes | focus ring visible everywhere |
| UIX-030 | P2 | Focus trapped in dialogs; returns to trigger on close | Yes | focus trapped in dialogs and returned to the trigger |
| UIX-034 | P2 | All inputs labelled (aria-label or label) | axe clean | all inputs labelled (axe clean) |
| UIX-058 | P2 | Dates `YYYY-MM-DD` in tables, friendly in top bar | Consistent | dates YYYY-MM-DD in tables, friendly in top bar |
| UIX-059 | P2 | Empty states have a next action | Yes | empty states offer a next action |
| UIX-060 | P2 | Error copy plain English, names the fix | Yes | error copy is plain English and names the fix |
| UIX-062 | P2 | Single radius scale 6/10/14/20 | No stray radii | computed radii follow 6/10/14/20 (legacy rules in globals.css still declare 5/7/9px) |
| UIX-071 | P2 | Zoom 200% desktop | No overlap | desktop zoom 200% without overlap |
| UIX-080 | P2 | Select elements styled consistently | Yes | select elements styled consistently |
| UIX-083 | P2 | Long names truncate with ellipsis where fixed width | Yes | long names truncate with ellipsis in fixed-width spots |
| UIX-084 | P2 | Urdu text rendering | Correct font fallback | Urdu text renders with a correct font fallback |
| UIX-085 | P2 | RTL text in LTR UI | No layout break | RTL text in the LTR UI does not break layout |
| UIX-087 | P2 | Loading spinners on busy buttons only | Yes | spinners appear only on busy buttons |
| UIX-089 | P2 | Toast/notice readable on phone | Yes | notices readable on phone |
| UIX-092 | P2 | axe-core no serious violations on every module | Yes | axe-core: no serious violations on every module |
| UIX-095 | P2 | Dialog title ids unique with nested dialogs | Yes | nested dialog title ids are unique |
| UIX-097 | P2 | Preset pills wrap on phone | Descriptions hidden | preset pills wrap on phone; descriptions hidden |
| UIX-098 | P2 | Module tiles single column on phone | Yes | module tiles single column on phone |
| UIX-099 | P2 | Setup card full-screen on phone | Yes | setup card full-screen on phone |

## Data integrity, concurrency, failure recovery, migrations (DAT)

| ID | P | Case | Expected | Note |
|---|---|---|---|---|
| DAT-051 | P2 | Page load with 10k docs | < 4 s | page load with 10k documents < 4 s |
| DAT-058 | P2 | Browser closed mid-command | Server completes; reload shows result | browser closed mid-command: server completes; reload shows the result |
| DAT-088 | P2 | Playwright suites independent of order | Pass in any order | Playwright suites pass in any order |
| DAT-089 | P2 | Playwright global warm-up prevents compile 500s | Yes | Playwright global warm-up prevents dev-compile 500s |

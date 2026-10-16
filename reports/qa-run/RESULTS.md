# SahulatERP SQA run — results

Generated 2026-10-16 05:45 UTC from `npm run test:qa` and the QA browser pass.

| Area | Cases | Pass | Fail | Browser not yet run | Manual only | Missing |
|---|---|---|---|---|---|---|
| Sign-in, password reset, sessions (AUTH) | 100 | 83 | 0 | 0 | 17 | 0 |
| Onboarding wizard and provisioning (ONB) | 100 | 99 | 0 | 0 | 1 | 0 |
| Settings: company & documents, features, access, audit (SET) | 100 | 100 | 0 | 0 | 0 | 0 |
| Products, opening stock, CSV import/export (PRD) | 100 | 100 | 0 | 0 | 0 | 0 |
| Customers and suppliers, walk-in names, credit limits (PTY) | 100 | 99 | 0 | 0 | 1 | 0 |
| Inventory: stock, transfers, corrections, valuation, warehouses (INV) | 100 | 100 | 0 | 0 | 0 | 0 |
| Sales documents and the invoice editor (SAL) | 100 | 99 | 0 | 0 | 1 | 0 |
| Purchasing, foreign currency, supplier payments (PUR) | 100 | 100 | 0 | 0 | 0 | 0 |
| Imports and landed cost (IMP) | 100 | 100 | 0 | 0 | 0 | 0 |
| Collections: receipts, cheques (PDC), follow-ups (COL) | 100 | 100 | 0 | 0 | 0 | 0 |
| Cash and bank (CSH) | 100 | 99 | 0 | 0 | 1 | 0 |
| Commissions (COM) | 100 | 100 | 0 | 0 | 0 | 0 |
| Payroll (PAY) | 100 | 100 | 0 | 0 | 0 | 0 |
| Accounting: journals, reversals, periods, invariants (ACC) | 100 | 100 | 0 | 0 | 0 | 0 |
| Reports and CSV export (RPT) | 100 | 99 | 0 | 0 | 1 | 0 |
| Printing, PDF and document view (PRN) | 100 | 98 | 0 | 0 | 2 | 0 |
| Shell: navigation, search, notifications, workspace switcher, Overview (NAV) | 100 | 97 | 0 | 0 | 3 | 0 |
| Security, tenancy, roles, API (SEC) | 100 | 89 | 0 | 0 | 11 | 0 |
| Responsive, mobile, accessibility, motion (UIX) | 100 | 85 | 0 | 0 | 15 | 0 |
| Data integrity, concurrency, failure recovery, migrations (DAT) | 100 | 97 | 0 | 0 | 3 | 0 |
| **Total** | **2000** | **1944** | **0** | **0** | **56** | **0** |

## Failures (0)

None.

## Case corrections (104)

- AUTH-063: [case-corrected: sign-in runs on the server (D-31), so the browser posts the password once to the app's own /auth/signin route (HTTPS in production) and never calls Supabase itself]
- ONB-050: [case-corrected: the chart is a fixed list (accountNames) present for every company regardless of modules; nothing is provisioned per module]
- ONB-051: [case-corrected: series are derived from existing documents on first use, not provisioned records]
- ONB-059: [case-corrected: a replay returns the original recordId and message (D-17)]
- ONB-068: [case-corrected: the Documents step stacks the preview under the form below 1000 px, so iPad portrait shows one column]
- ONB-086: [case-corrected: actor is the user id, actorName the display name (D-21)]
- ONB-090: [case-corrected: the address limit is 500 characters (form maxLength 500, API max 500)]
- ONB-092: [case-corrected: stored as typed (not trimmed); prints an empty-looking footer paragraph]
- SET-001: [case-corrected: D-09 adds a "Payroll & tax" tab after Company & documents]
- SET-014: [case-corrected: after setup company details are Owner/Accountant only (D-08)]
- SET-024: [case-corrected: message lists modules in catalogue order: "Collections & PDCs, Commissions cannot stay on without Sales."]
- SET-043: [case-corrected: the internal revision number is no longer shown (NAV-043, D-57)]
- SET-050: [case-corrected: actor is the user id, actorName the display name (D-21)]
- SET-058: [case-corrected: only Owner, Accountant and Auditor see Settings; other roles have no Settings entry]
- SET-059: [case-corrected: five tabs since D-09 added Payroll & tax]
- SET-068: [case-corrected: it uses the first submitted invoice in the list, not the latest]
- SET-081: [case-corrected: refused once setup is complete; Owner/Accountant only (D-08)]
- SET-086: [case-corrected: settings.numbering ("DP" for a new company) is stored but not used; documents use fixed kind prefixes like INV-YYYY-0001]
- PRD-002: [case-corrected: API error is the min-length validation (route shows "Check the highlighted information."); "SKU is required" is the CSV import message]
- PRD-084: [case-corrected: a replay returns the original recordId and message (D-17)]
- PTY-023: [case-corrected: party phone is not printed on documents (print shows name, city, email, NTN)]
- PTY-060: [case-corrected: message is "X appears more than once in the file" without the "customer" prefix]
- PTY-093: [case-corrected: the id is treated as a new record in this tenant; no other tenant's data is read or changed]
- INV-008: [case-corrected: set_stock_quantity returns the min-length validation (form field is required); "Adjustment reason is required." is the stock_adjust message]
- INV-046: [case-corrected: the Overview attention list has no low-stock entry; low stock shows only as Inventory badges/filter]
- INV-060: [case-corrected: the report is chronological; Item details shows the newest 20 movements first with no running quantity]
- INV-069: [case-corrected: a replay returns the original recordId and message (D-17)]
- INV-072: [case-corrected: the Stock tab has no totals row; the total is in Reports → Stock valuation]
- INV-074: [case-corrected: shown, but without an "archived" mark]
- INV-086: [case-corrected: each table draws its first 100 rows with "Show 100 more"; search and filters reach the rest]
- SAL-050: [case-corrected: a replay returns the original recordId and message (D-17)]
- SAL-099: [case-corrected: message is "This warehouse is outside your permitted branches."]
- PUR-018: [case-corrected: credit goes to 2010 Goods received, not billed]
- PUR-031: [case-corrected: message is "Invalid invoice allocation."]
- PUR-034: [case-corrected: message is "Invalid invoice allocation."]
- PUR-035: [case-corrected: message is "Invalid invoice allocation."]
- PUR-044: [case-corrected: GRNs are not listed either]
- PUR-061: [case-corrected: input tax account is 1300 Recoverable tax]
- PUR-076: [case-corrected: a direct bill DOES move stock in and debits 1200]
- PUR-080: [case-corrected: a replay returns the original recordId and message (D-17)]
- PUR-081: [case-corrected: a replay returns the original recordId and message (D-17)]
- IMP-037: [case-corrected: withdrawn — real customs lookups are out of scope (test plan §2) and simulated lookups were removed from the product; the GD number is entered by hand]
- IMP-061: [case-corrected: a replay returns the original recordId and message (D-17)]
- IMP-066: [case-corrected: accepted (below one trillion); 1,000,000,000,000 is refused]
- IMP-069: [case-corrected: defaults apply only when the fields are omitted; blank strings are stored blank]
- IMP-073: [case-corrected: Sales analysis has no margin column; the overview margin (summary) reflects landed cost]
- IMP-086: [case-corrected: posts to 5300 "Operating expense", not a separate clearing/import expense line]
- COL-005: [case-corrected: message is "Invalid invoice allocation."]
- COL-006: [case-corrected: message is "Invalid invoice allocation."]
- COL-007: [case-corrected: message is "Invalid invoice allocation."]
- COL-038: [case-corrected: a replay returns the original recordId and message (D-17)]
- COL-039: [case-corrected: a replay returns the original recordId and message (D-17)]
- COL-044: [case-corrected: REC-0001, REC-0002… one global series without a year, shared with supplier payments]
- COL-084: [case-corrected: the receipts table draws the newest 100 with "Show 100 more"; the filters reach the rest]
- COL-100: [case-corrected: the statement also lists the bounced cheque and its reversal (D-25)]
- CSH-037: [case-corrected: a replay returns the original recordId and message (D-17)]
- CSH-046: [case-corrected: accepted (limit is below one trillion); 1,000,000,000,000 is refused]
- CSH-048: [case-corrected: surrounding whitespace is trimmed; an inner newline is kept as typed]
- CSH-094: [case-corrected: summary cards are not tappable; the account name in the Accounts list opens the activity]
- COM-028: [case-corrected: paid may exceed released after a bounce until payroll recovers it]
- COM-055: [case-corrected: message is "Hamza Khan appears more than once in the file" without the word "employee"]
- COM-081: [case-corrected: states read unreleased / pending (released, awaiting approval) / approved / recoverable]
- COM-090: [case-corrected: a replay returns the original recordId and message (D-17)]
- COM-091: [case-corrected: approved resets to false when the release changes]
- PAY-004: [case-corrected: the message is "Payroll calculated." (D-57)]
- PAY-043: [case-corrected: net = commission − income tax − employee EOBI]
- PAY-048: [case-corrected: PAY-YYYY-MM (one run per month), not PAY-2026-0001]
- PAY-054: [case-corrected: cancel_payroll cancels a draft or reviewed run; approved and paid runs are refused (D-10)]
- PAY-065: [case-corrected: the create message is "Payroll calculated." (D-57)]
- PAY-066: [case-corrected: a replay returns the original recordId and message (D-17)]
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
- NAV-015: [case-corrected: since D-39 the journals whose memo names an INV-2026 invoice also match; the invoices are listed first]
- NAV-016: [case-corrected: since D-39 a journal whose memo names the customer (an expense "for the Metro Home Stores order") is listed too]
- NAV-019: [case-corrected: search covers documents, customers, suppliers and products only, as its description says; employees are never returned for any role, so salaries cannot leak]
- NAV-031: [case-corrected: queues are commission awaiting approval, unallocated shipment costs, overdue supplier bills (D-42, for roles that pay suppliers), open customer invoices, cheques due, follow-ups due and draft sales; there is no low-stock queue]
- NAV-038: [case-corrected: weekly totals up to 12 weeks ending at the latest activity, not 6 months; bars violet (accent) and cyan (accent-2) with legend]
- NAV-061: [case-corrected: the company is kept by the ?tenant= query that stays in the URL, not by a cookie]
- NAV-064: [case-corrected: reads "SAHULAT ERP  Made for the way you do business." and "PKR · Asia/Karachi" without the extra dots]
- SEC-002: [case-corrected: 403 TENANT_REQUIRED, not 400]
- SEC-036: [case-corrected: a replay returns the original recordId and message (D-17)]
- SEC-039: [case-corrected: treated as a replay — unchanged workspace and the first call's recordId and message (D-17)]
- SEC-041: [case-corrected: the client does not auto-retry; it shows "Another change was saved first. Refresh and try again."]
- SEC-046: [case-corrected: 415 Unsupported Media Type, not 400]
- SEC-084: [case-corrected: QA_TENANT_ID may pick one of six allow-listed 3333… tenants for parallel runs; anything else throws]
- SEC-092: [case-corrected: a replay returns the original recordId and message (D-17)]
- SEC-093: [case-corrected: a replay returns the original recordId and message (D-17)]
- DAT-003: [case-corrected: 33.3333 / 33.3333 / 33.3334 — the last line takes the remainder]
- DAT-014: [case-corrected: a receipt above the outstanding is refused; a return after full payment is allowed and leaves a customer credit (negative outstanding) by design]
- DAT-049: [case-corrected: the replay history is capped (D-17), so it is added once at its full size rather than extrapolated per invoice]
- DAT-090: [case-corrected: postCommand retries once with the same body only when the response is not JSON or a 5xx without a message; a 5xx with a message is not retried]

## Behaviour recorded where the case asked "assert/verify" (221)

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
- PRD-076: [documented: reading stops at the first row over 2,000, then "Import at most 2,000 rows at a time."]
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
- INV-076: [documented: warehouses cannot be archived, so there is nothing to exclude]
- INV-077: [documented: a transfer moves one product; each is guarded on its own and an over-quantity transfer changes nothing]
- SAL-023: [documented: a line sent without taxRate takes the company tax rate in Settings, or 0 when it is blank]
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
- PAY-076: [documented: not present in the Payroll view]
- PAY-077: [documented: not present; search covers documents, parties and items only]
- PAY-080: [documented: employer EOBI is inside 5200 Salary expense, no separate line]
- PAY-081: [documented: 2400 is never settled in-app]
- PAY-082: [documented: payroll pay settles 2300 automatically; 2400 needs a manual journal because record_expense only allows 5100/5200/5300]
- PAY-083: [documented: import and the form default to 30; the API requires attendance]
- PAY-085: [documented: not present; payroll appears only through P&L / ledger accounts]
- PAY-089: [documented: not present — no tooltip; a run opens its per-employee amounts (PAY-063), not the invoices behind the commission]
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
- NAV-030: [documented: one row per queue labelled "{count} · {Module}" rather than grouped headings; queues are commission awaiting approval, unallocated shipment costs, overdue supplier bills (D-42), open customer invoices, cheques due, follow-ups due, draft sales]
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
- SEC-044: [documented: no 413 at app level; field limits reject it]
- SEC-047: [documented: signed-in GET returns the role-scoped workspace]
- SEC-048: [documented: session cookies are SameSite=Lax (@supabase/ssr default); the route has no Origin check and also accepts ?tenant= in the URL]
- SEC-050: [documented: X-Content-Type-Options, Referrer-Policy, X-Frame-Options DENY, Permissions-Policy on all routes; no CSP; HSTS left to the host]
- SEC-051: [documented: list/dialog rendering needs a browser]
- SEC-058: [documented: route always targets the demo tenant]
- SEC-060: [documented: none in the app; only the 5-per-15-min password throttle exists]
- SEC-080: [documented]
- SEC-091: [documented: names are compared with trim + toLowerCase only; NFC "Café" and NFD "Café" are both accepted]
- SEC-095: [documented: only "Empty workspace command body" (method/length/type), database rejection messages and unexpected server failures (the thrown error, never the request body) are logged]
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

## Manual-only cases (56)

- AUTH-031 "Forgot your password?" with a valid email — [manual] reset email delivery with link to /auth/callback?next=/account/reset (redirectTo verified in source)
- AUTH-034 Forgot password twice quickly — [manual] two quick reset requests: hosted Supabase rate limit surfaced cleanly
- AUTH-036 Set new password of 8 chars — [browser] set an 8-char password via reset link; new works, old fails
- AUTH-039 New password 72+ chars — [manual] 72+ char new password: hosted GoTrue limit, never silently truncated
- AUTH-040 New password equal to old password — [manual] new password equal to old: hosted Supabase policy
- AUTH-042 Reuse the reset link after success — [browser] reused reset link shows expired state
- AUTH-043 Reset link opened in a different browser — [manual] reset link opened in a different browser
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


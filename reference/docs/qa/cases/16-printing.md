# 16 — Printing, PDF and document view (PRN)

Routes: `/print/<kind>/<id>?tenant=…`. Branded header (logo or letterhead, accent colour), party block, lines, totals, footer, "Computer-generated document" line. Print / Save as PDF button uses the browser print dialog.

| ID | P | T | Case | Expected |
|---|---|---|---|---|
| PRN-001 | P1 | F | Print a submitted sales invoice | Header company name/address/phone/email, "SALES INVOICE", number, date, due |
| PRN-002 | P1 | F | Logo uploaded | Logo at top-left, sized ≤ 80px high, aspect kept |
| PRN-003 | P1 | F | No logo | Company initial tile in accent colour |
| PRN-004 | P2 | F | Letterhead uploaded | Replaces whole header; no duplicate company name |
| PRN-005 | P1 | F | Accent colour applied to heading and table header | Yes |
| PRN-006 | P1 | F | Footer text printed | Yes; multi-line kept |
| PRN-007 | P1 | F | NTN / STRN line when set | "NTN / STRN: …" |
| PRN-008 | P2 | F | Bill-to block: customer name, city, email, tax id | Only present fields |
| PRN-009 | P1 | F | Walk-in invoice | Typed name; no address |
| PRN-010 | P2 | F | Terms line | "30 days" from customer terms; blank for walk-in? (assert) |
| PRN-011 | P2 | F | Salesperson line when set | Yes |
| PRN-012 | P1 | F | Lines: description, SKU small, qty + unit, rate, disc %, tax %, amount | Correct |
| PRN-013 | P2 | E | Unit blank | Qty only |
| PRN-014 | P2 | E | Unit "1000 pcs" | Printed verbatim (documented) |
| PRN-015 | P2 | E | Qty 0.5 | "0.5 kg" |
| PRN-016 | P2 | E | Qty 1,234,567 | Thousands separators |
| PRN-017 | P1 | F | Totals: subtotal, tax, total, paid, returns, balance due | Correct arithmetic |
| PRN-018 | P2 | F | Fully paid invoice | Balance due 0 |
| PRN-019 | P2 | F | Overpaid/credit | "Customer credit" line |
| PRN-020 | P2 | F | Draft invoice print | "DRAFT" status visible |
| PRN-021 | P2 | F | Cancelled invoice print | "CANCELLED" visible |
| PRN-022 | P2 | F | Credit note print | Title "Credit note", reference to invoice |
| PRN-023 | P2 | F | Quotation print | Title, validity? no due; no payment lines |
| PRN-024 | P2 | F | Sales order print | Correct title |
| PRN-025 | P2 | F | Delivery note print | Quantities; prices per design |
| PRN-026 | P2 | F | Purchase order print | Currency USD and rate; totals in both |
| PRN-027 | P2 | F | GRN print | Received quantities |
| PRN-028 | P2 | F | Supplier bill print | Due by terms |
| PRN-029 | P2 | F | Supplier return print | Title |
| PRN-030 | P2 | F | Receipt print | "Receipt", "Received from", method, cheque no, allocations |
| PRN-031 | P2 | F | Payment voucher print | "Payment voucher", "Paid to" |
| PRN-032 | P2 | F | Customer statement print | Period, running balance |
| PRN-033 | P1 | S | Print another tenant's document id | 401 / not found |
| PRN-034 | P1 | S | Print while signed out | Login/401 |
| PRN-035 | P2 | S | Salesperson prints another salesperson's invoice | Not found (scoped) |
| PRN-036 | P2 | S | Branch-limited user prints other branch document | Not found |
| PRN-037 | P2 | S | Logo URL signed and short-lived | Expired link fails cleanly |
| PRN-038 | P2 | F | "Print / Save as PDF" button | Opens browser print; button itself hidden in print output |
| PRN-039 | P2 | F | Print preview A4 portrait | Fits one page for 10 lines; page breaks for 60 lines without splitting a row |
| PRN-040 | P2 | F | Print preview Letter | Fits |
| PRN-041 | P2 | U | Print CSS: no sidebar, no top bar, no buttons | Correct |
| PRN-042 | P2 | U | Colours in print: accent preserved (print-color-adjust) | Yes |
| PRN-043 | P2 | U | Fonts: Geist loads in print; fallback OK offline | Yes |
| PRN-044 | P2 | E | 100-line invoice | Paginates; totals on last page |
| PRN-045 | P2 | E | Very long product name (120 chars) | Wraps within column |
| PRN-046 | P2 | E | Notes 2,000 chars | Wraps; not clipped |
| PRN-047 | P2 | E | Footer 500 chars | Wraps |
| PRN-048 | P2 | E | Company name 120 chars | Wraps; header intact |
| PRN-049 | P2 | E | Urdu/Arabic script names | Renders right-to-left glyphs correctly |
| PRN-050 | P2 | E | Emoji in notes | Renders or boxes; no crash |
| PRN-051 | P2 | E | Logo 1×1 px | Scales; no layout break |
| PRN-052 | P2 | E | Logo very wide (2000×100) | Constrained |
| PRN-053 | P2 | E | Logo transparent PNG on accent background | Readable |
| PRN-054 | P2 | F | Print on phone (iOS Share → Print) | Layout fits; no horizontal clipping |
| PRN-055 | P2 | U | Document view in-app (details) matches print content | Same numbers |
| PRN-056 | P2 | F | Document chain shown in details (QUO → SO → DN → INV) | Links work |
| PRN-057 | P2 | F | Details: payments list with cheque status | Yes |
| PRN-058 | P2 | F | Details: returns list | Yes |
| PRN-059 | P2 | F | Details: Submit/Return/Convert/Print buttons by state and role | Correct |
| PRN-060 | P2 | F | Details for walk-in invoice | Typed name |
| PRN-061 | P2 | F | Details for cancelled draft | Reason in notes |
| PRN-062 | P2 | U | Details dialog on phone | Bottom sheet; scroll |
| PRN-063 | P2 | F | Print URL with wrong tenant param but your own doc | Doc looked up in the given tenant → not found; with correct tenant works |
| PRN-064 | P2 | F | Print URL without tenant param | Falls back to member's company; works if doc there |
| PRN-065 | P2 | E | Print id of a receipt via document route | Not found; receipt route separate |
| PRN-066 | P2 | E | Unknown kind `/print/foo/<id>` | 404 |
| PRN-067 | P2 | F | Print in a company still in setup | Allowed? assert; sample doc only |
| PRN-068 | P2 | F | Branding changed after invoice | Reprint shows new branding (not snapshotted) — documented |
| PRN-069 | P2 | F | Tax snapshot shows registered status at invoice time | Yes |
| PRN-070 | P2 | F | Amount in words (if present) | Correct Pakistani style |
| PRN-071 | P2 | F | "amounts in PKR" footer | Yes; USD docs state currency |
| PRN-072 | P2 | F | Rate column formatting `Rs 2,400` / `$10.00` | Correct |
| PRN-073 | P2 | F | Discount column shows `10%` only when non-zero | Yes |
| PRN-074 | P2 | F | Tax column `0%` vs blank | Consistent |
| PRN-075 | P2 | F | Save as PDF filename suggestion | Document number (browser default acceptable) |
| PRN-076 | P2 | X | Print page load < 1.5 s | Yes |
| PRN-077 | P2 | F | Print page has no console errors | Yes |
| PRN-078 | P2 | F | Print page title = document number | Yes |
| PRN-079 | P2 | F | Back from print returns to app state | Yes |
| PRN-080 | P2 | U | Table header repeats on each printed page | `thead` repeat |
| PRN-081 | P2 | U | Page margins 15–20 mm | Yes |
| PRN-082 | P2 | U | Dark mode OS | Print stays light |
| PRN-083 | P2 | F | Print via keyboard Ctrl/Cmd+P | Same output |
| PRN-084 | P2 | F | Print a document while its module is hidden | Allowed? assert (document kept) |
| PRN-085 | P2 | F | Statement print for walk-in customer | Grouped |
| PRN-086 | P2 | F | Receipt print for cheque bounced | Status bounced |
| PRN-087 | P2 | F | Two tabs printing different docs | Independent |
| PRN-088 | P2 | F | Print of invoice from delivery shows chain | Yes |
| PRN-089 | P2 | F | Print of partially returned invoice | Returns line |
| PRN-090 | P2 | F | Invoice number barcode/QR (if present) | Encodes number |
| PRN-091 | P2 | F | Address with newlines in header | Line breaks |
| PRN-092 | P2 | F | Email/phone separators "·" | Only between present values |
| PRN-093 | P2 | F | Letterhead + NTN | NTN still printed below letterhead or omitted consistently |
| PRN-094 | P2 | E | Document with 0 total | Prints "Rs 0" |
| PRN-095 | P2 | E | Document with negative balance due | Credit wording |
| PRN-096 | P2 | S | Print page does not expose other documents in HTML | Only this doc's data |
| PRN-097 | P2 | S | Print page XSS via notes `<img onerror>` | Escaped |
| PRN-098 | P2 | F | Print page without JS | Static HTML renders |
| PRN-099 | P2 | F | Print page in Safari | Matches Chrome |
| PRN-100 | P1 | F | End to end: branded invoice with logo, NTN, footer, walk-in name, partial payment and return prints correctly on A4 | Pass |

Covered by automation: `onboarding.spec.ts` (print with branding), `documents.spec.ts` (print buttons).

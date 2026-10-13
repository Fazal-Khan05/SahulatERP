# Multi-line documents and sales / purchase cycles — QA record

**Date:** 15 October 2026 · **Scope:** backlog T02, T04, T05 (UI) and part of T06, [plan](../../docs/plans/2026-10-15-document-cycles.md)

## Result

| Check | Result |
| --- | --- |
| `npm run typecheck`, `npm run build` | Pass |
| `npm test` — 65 tests (7 new in `documents.test.ts`) | Pass |
| `documents.spec.ts` on the QA tenant | Pass |
| `onboarding.spec.ts`, `master-data.spec.ts`, `owner-workspace.spec.ts`, `qa-regression.spec.ts` | Pass; demo unchanged |

## Verified in the browser (documents.spec.ts)

- Two-line quotation in the editor: price prefilled from the product, due date from the customer's terms, per-line discount, live totals.
- Quotation → sales order → delivery of 6 of 10 panels (boards held back) → invoice from that delivery (stock moves once, at the delivery's cost); a second delivery for 5 is refused with "only 4 remaining".
- Invoice details show the document chain and balance.
- One receipt allocated across two invoices with "oldest first"; the second invoice gets the remainder.
- Partial return of one panel posts a credit note; the invoice then shows a customer credit.
- USD purchase order at 280 → goods receipt → supplier bill → payment of 57,000 PKR against 200 USD: payable cleared, exchange loss of 1,000 posted to 5400, every journal balanced.
- Supplier payments listed under Purchasing with print; customer receipts stay in Collections.

## Defects found and fixed during QA

1. **Any finishing command closed whatever dialog was open.** `command()` cleared the modal state on every success, so a Submit still in flight closed the receipt dialog opened a moment later. Auto-close is now limited to the follow-up and stock-transfer dialogs that rely on it; every other dialog closes itself.
2. Test-only: duplicate header/list buttons needed `.first()`; a new company has no default tax rate, so expected totals were corrected (nothing statutory is hard-coded).

## Deferred

Advances / on-account receipts, price lists, multi-currency sales, attachments, email sending.

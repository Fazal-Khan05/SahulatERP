# Plan: Multi-line documents and the full sales / purchase cycles (T02, T04, T05, T06 part)

Status: **built 15 October 2026** (branch `documents-cycle`); QA record in [reports/qa-2026-10-15/DOCUMENT_CYCLES_QA.md](../../reports/qa-2026-10-15/DOCUMENT_CYCLES_QA.md). Follows [2026-10-14-master-data.md](2026-10-14-master-data.md).

## Why

The engine already posts the whole chain (quotation → order → delivery → invoice → return; PO → GRN → bill → supplier return; receipts and supplier payments with allocations), but the UI exposes only a one-line sales invoice, a one-line purchase order and a one-invoice customer receipt. A real invoice has many lines; a real payment covers several invoices; an order is delivered in parts. This slice gives every engine capability a screen, which is the parity bar against FastAccounts' Sales and Purchases modules.

## What the user gets

- **Document editor** (one component for every kind): party, warehouse, dates (due date defaults from the party's terms), currency and exchange rate for purchases, notes, and a **lines table**: product search, quantity, unit price (prefilled from the product's price or cost), discount %, tax % (prefilled from company settings), per-line salesperson for sales kinds, line total, with add/remove rows and live net / tax / total. Save as draft, edit a draft, cancel a draft.
- **Document details** for every kind (not only sales invoices): header, lines, totals, the chain it belongs to (source and follow-on documents with status), receipts/payments against it, and the actions that apply: Edit draft, Submit, Convert to next step, Return, Print, Cancel draft.
- **Convert** dialog: shows remaining quantity per line (source less what earlier conversions used), lets the user deliver/receive/invoice a part, creates the next draft. Fully consumed lines are hidden; a fully converted document shows "Complete".
- **Return** dialog for submitted sales invoices and supplier bills: choose lines and quantities (capped at un-returned quantity), reason; posts the credit note / supplier return through the existing engine path.
- **Payments** dialog (customers and suppliers): choose the party, see every open invoice with its balance, allocate across several ("allocate oldest first" button), method, cheque number and date, note. Supplier payments get their own tab under Purchasing; customer receipts stay in Collections.
- **Lists**: Purchasing gets the same filtered list as Sales (search, type, status, supplier, dates) plus View / Convert / Submit / Print row actions; Sales rows gain Convert and Return.

## Engine additions

- `update_document { id, …same input as create }` — drafts only; renumbers nothing; keeps id and number; re-validates party/warehouse/lines; reconversion limits re-checked when `parentId` is set.
- `cancel_document { id, reason }` — drafts only; status `cancelled`; audited with reason. Posted documents still need returns/reversals.
- `convert_document` accepts `lines` with `lineId` + `quantity` (partial) and validates each against remaining quantity; existing engine already enforces totals via `createDocument`'s parent check.
- `create_receipt` unchanged (already supports several allocations, cheques, suppliers); UI now uses it fully. Advances/on-account receipts without an invoice are **deferred** (needs a customer-advance account and settlement flow).
- Due date defaulting lives in the UI; the engine keeps whatever date is sent.

## UI pieces

- `document-editor.tsx` (create/edit any kind), `document-details.tsx` (replaces `invoice-details.tsx` for all kinds, keeps the same dialog name for existing tests), `convert-dialog.tsx`, `return-dialog.tsx`, `payment-dialog.tsx`, `purchase-documents-view.tsx`; `sales-documents-view.tsx` gains the new actions. `TransactionDialog` keeps only the follow-up form.

## Tests

- Engine: draft update/cancel rules, partial conversion chain with remaining quantities and over-conversion refusal, invoice from delivery carries the delivery's cost, multi-invoice receipt allocation, supplier payment with FX variance, return caps.
- Browser (`documents.spec.ts`, QA tenant): two-line quotation → order → partial delivery → invoice → second delivery → invoice; receipt allocated across both invoices; PO in USD → GRN → bill → supplier payment; partial return on an invoice; purchasing filters; print of a PO.

## Out of scope

Advances and on-account receipts, credit limit UI beyond the existing owner override, price lists, multi-currency sales, document attachments, email sending.

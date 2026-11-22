# Step 46: the sales tax return's annexes

Built by the Builder (Fable) on 2026-11-22, track A. Migration `0038_sales_tax_return`. The
founder was away; one question was sent to him through the coordinator (the templates, below)
and everything else was decided here and is listed under "Decided for Fazal, to confirm".

## What was built

- **Sales tax return** (Reports, Sales tax; `/tax-return`), for a company registered for sales
  tax: a month, its five annexes with the number of rows in each, each as an Excel or CSV sheet
  for upload, what is missing for a clean file, and every annex set beside the ledger.
- **The annexes** are read each time from what posting stored; nothing is kept and no tax is
  worked out again (the plan: "Report code never recomputes tax"). Each is a database function
  (`drizzle/0038_sales_tax_return.sql`):
  - **Annex-C, domestic sales** (`app.annex_c_rows`): every line of the month's posted invoices
    and credit notes, with the buyer as written on the document, HS code, sale type, rate,
    quantity, value, sales tax, extra tax, further tax, and for a credit note the invoice it
    corrects. Counter sales are ordinary invoices and are in it.
  - **Annex-C1, payments received** (`app.annex_c1_rows`; S.R.O. 578(I)/2025): each part of a
    posted receipt set against an invoice in the month, with how it was paid.
  - **Annex-A, domestic purchases** (`app.annex_a_rows`): every line of the month's posted
    supplier bills and the billed lines of supplier returns (debit notes), with the input tax
    and the sales tax withheld from the supplier.
  - **Annex-B, imports** (`app.annex_b_rows`): shipments by goods declaration, with the sales
    tax and income tax paid at import.
  - **Annex-H1, stock statement** (`app.annex_h1_rows`; S.R.O. 55(I)/2025, for importers,
    distributors and wholesalers): by HS code, unit and rate, at cost: opening, imported,
    purchased, supplied, other and closing.
- **Beside the ledger** (`app.tax_return_ledger`): what the month's journals put on the output
  tax, further tax, input tax and sales-tax-withheld accounts, by the kind of document. The page
  shows, for each annex, its total, what its own documents' journals carry, and anything else on
  the account that month (a journal by hand, say). **The plan's test, "Annex-C total equals
  output tax in the ledger for the month", is the first test of
  `src/modules/tax-return/tax-return.test.ts`**, and the page shows the same comparison every
  time it is opened.
- **Who reads it**: the owner, an accountant, an auditor, and only one not limited to some
  branches. The return is the whole company's; the functions run with the table owner's rights
  so that they read every branch, and refuse anyone else themselves.
- **The province the company supplies from** (`tax_return_settings`, one row a company), which
  Annex-C names on every line and the company had never been asked. Set on the return's page by
  the owner or an accountant; audited.
- No new library: the sheets are written with `write-excel-file`, which the reports already use.
  (`exceljs` was approved but is not needed.)

## The one open question: the exact layouts

FBR gives the exact upload templates only to a signed-in registered taxpayer, in IRIS. None is
in this repository, and none could be found published: FBR's own filing guide shows the screens
as pictures. What is known for certain, and built to:

- Annex-A and Annex-B are **not uploaded** in IRIS. Supplier invoices appear there once the
  supplier declares them, and goods declarations come from Customs; the taxpayer claims them. So
  our A and B are lists to tick off against what IRIS shows.
- Sales invoices and debit and credit notes are entered or uploaded under Invoice Management and
  load into Annex-C.
- Annex-C1 asks for "specific details in respect of buyer, invoice reference, and payment
  received" (S.R.O. 578(I)/2025). Annex-H1 asks for "itemized/product-wise (HS code-based)
  quantity and stock details", at "the cost or purchase price" (S.R.O. 55(I)/2025).

The column headings and their order in `src/modules/tax-return/rules.ts` are the best reading
of those sources and of the older annex forms. **They must be checked against the templates
downloaded from IRIS before the first return is filed from these files.** Every sheet's note
says so. Each annex's columns are one list in that file, so a heading or its place is one line.
Sent to the founder: can he, or a registered company's tax adviser, download the current
templates for Annex-C, C1 and H1 (and a screenshot of A and B) and put them in the repository?

## Decided for Fazal, to confirm

1. **A month is by the document's date** for C and A; by the day a payment was set against an
   invoice for C1 (so money received ahead is listed when it is used); by the day a shipment's
   charges were spread for B (when the tax paid at import reached the books; the goods
   declaration's own date is shown beside it).
2. **Credit notes and debit notes** are rows of their own, in their own month, with positive
   amounts, and are taken away in the totals.
3. **The buyer on Annex-C is the copy the invoice kept**; the supplier on Annex-A is the
   supplier's record as it stands today, because a bill keeps no copy of the supplier's numbers.
4. **Annex-A leaves out** what a bill pays to Customs for a shipment (sales tax at import, income
   tax at import, a deposit): those are Annex-B's. Freight and clearing charges stay in A as
   purchases of services.
5. **Annex-H1 groups items by HS code, unit and rate**; items with no HS code share a row and
   are counted in a note. "Imported" is goods received on a shipment plus the charges spread
   onto them; "purchased" is the rest, less returns to suppliers; "supplied" is deliveries and
   invoices less customers' returns; "other" is counts and adjustments.
6. **A member limited to some branches does not see the return at all**, not a part of it.
7. **The return is shown only to a company registered for sales tax.**
8. Dates are written DD-MM-YYYY and rates as "18%", as FBR's files do.

## Known gaps

- **Sales tax withheld by a buyer who is a withholding agent is not recorded** anywhere yet (a
  receipt has no field for it), so that column of Annex-C is empty and said to be.
- **Extra tax is always nil** (docs/LATER.md) and **HS code, FBR unit and sale type are free
  text** on an item, not FBR's lists. The return says how many lines lack each; it cannot say a
  code is wrong.
- **Provincial sales tax on services** on a bill is not on Annex-A (it belongs to the provincial
  return, not FBR's).
- **Exports (Annex-D)** are not built: there are no export sales yet.
- **Shipments' goods are not listed line by line on Annex-B**: a shipment has no value for each
  goods declaration item, only its customs value and the HS codes of its goods.
- The return does not work out the **tax payable** (STR-7's own figures): IRIS does that from
  the annexes. "Beside the ledger" gives the figures to check it against.
- A debit note for goods that were **not yet billed** carries no tax and is not on Annex-A.
- The activity log shows `tax_return.province` by its name until Step 47 (which moves the list of
  labels) is merged; a label is added then.

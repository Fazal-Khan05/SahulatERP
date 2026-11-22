# Step 46: the sales tax return's annexes

Built by the Builder (Fable) on 2026-11-22, track A. Migration `0039_sales_tax_return`. The
founder was away; one question was sent to him through the coordinator (the templates, below)
and everything else was decided here and is listed under "Decided for Fazal, to confirm".

## What was built

- **Sales tax return** (Reports, Sales tax; `/tax-return`), for a company registered for sales
  tax: a month, its five annexes with the number of rows in each, each as an Excel or CSV sheet
  for upload, what is missing for a clean file, and every annex set beside the ledger.
- **The annexes** are read each time from what posting stored; nothing is kept and no tax is
  worked out again (the plan: "Report code never recomputes tax"). Each is a database function
  (`drizzle/0039_sales_tax_return.sql`):
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
**Still to be checked: the IRIS templates for Annex-A, B, C, C1 and H1.** The founder was asked
(2026-11-22) and answered "Build now, templates later." So the annexes are built to the
published filing guide and the 2025 S.R.O.s, and every export is marked to be checked against
the IRIS template before the first filing. When he, or a registered company's tax adviser,
downloads the current templates for C, C1 and H1 (and a screenshot of A and B) and puts them in
the repository, the column lists in `rules.ts` are set to match and this note is closed.

## The independent review (2026-11-22)

A reviewer who had not seen the work attacked the functions as a signed-in member running any
SQL as the app's role, and posted three months of trade through the app's own commands to set
the annexes beside the ledger. **Nothing critical or high; access held everywhere** (every role
but the three, a branch-limited accountant, another company's owner, nobody signed in). Three
medium and five low findings, all put right and tested:

- **Medium: sales tax withheld was lost from Annex-A** when a bill's first line was a charge paid
  to Customs (the withholding was pinned to a line that was then left out), and a bill of nothing
  but such charges vanished with its withholding. It now sits on the first line that is listed,
  and such a bill gets a row for the withholding alone.
- **Medium: the retail value of Third Schedule goods sold in a pack was wrong** (the price of one
  piece times the number of cartons). It is the price of one piece times the pieces.
- **Medium: Annex-H1 left the rate empty** for an item with no tax category of its own, and split
  one HS code into two rows. Such an item is stated at the standard rate, as it is sold.
- **Low: a taxed line put on a shipment as a deposit dropped out of Annex-A with its input tax.**
  A line that carries sales tax is always listed.
- **Low: a month like 0001-02 was read by the database as another span of years** (the member's
  own data only). Only this century's months are taken.
- **Low: "other entries" on the input tax account were shown beside both Annex-A and Annex-B.**
  Shown once now.
- **Low: the first spreading of a shipment was chosen by its date**, so a later one dated back
  took the customs value from it. It is the first one made.
- **Low: an accountant limited to a branch could read and set the province**, and whoever could
  write the row could write its time. The province is the whole company's, like the return; the
  database stamps the times.

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

- **A month already filed can read differently later.** Nothing is kept: a cheque that bounces
  next month leaves this month's Annex-C1, and a bill line put on a shipment later leaves an
  earlier month's Annex-A. Download the files when the return is filed and keep them. Keeping a
  copy of each filed return in the product is a step of its own.
- **Annex-H1 can show a negative** supplied or purchased figure in a month in which more came
  back than went out; IRIS may not take one. Opening stock entered in a month is under "other".
- **Goods received in one month and billed in the next** are in that month's stock statement and
  the next month's Annex-A, as the books have them.
- **Open the Excel file, not the CSV, in Excel**: Excel reads a bare HS code or CNIC in a CSV as a
  number and spoils it. The Excel file writes them as text.

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
- The activity log shows `tax_return.province` by its name, like every action added since the
  tracks began: the list of labels (`src/modules/tenant/activity-labels.ts`) is shared, and a
  track does not edit it (docs/PARALLEL.md). Labels for all of them are one joint change.

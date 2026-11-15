# Step 25: supplier bills

Built in track B (stock and buying) by the Builder, on Step 24's purchase orders and goods
received. Migration `0030_supplier_bills`.

## Decided by the founder (2026-11-15, in the Builder's chat)

- **Tax is withheld from suppliers only by a company that switches it on.** It is off to start
  with. A small business that is not a withholding agent never sees it; one that must deduct
  switches it on under Purchases, Withholding tax.
- **When the supplier's bill is at a different price from the order, the difference goes to an
  account of its own, Purchase price differences (5120).** The stock value is not changed.
- **The migration may be applied to the shared development database** once it has passed its
  independent review and the local tests (the same yes covers Steps 24, 25 and 26).
- For Step 26: a foreign-currency advance to a supplier is kept at the rupees actually paid; it
  is not revalued at month end.

## What was built

- **Supplier bills** (`/purchases/bills`). A bill is for one supplier and one branch, and
  carries the supplier's own invoice number and date. Its lines are of two kinds:
  - **goods already received**: so much of one line of a posted goods received note, at the
    supplier's price for one. Never more than arrived and is not yet billed;
  - **a service or an expense**: an amount charged to an expense or asset account.
  It is a draft until it is posted; posting gives it its number (PB-2627-00001).
- **Posting is one act of the database.** What the billed goods came into stock at leaves Goods
  received not invoiced; the difference from the bill's price goes to Purchase price
  differences; services go to their accounts; input tax to Sales tax receivable; what is
  withheld to the three withholding payable accounts; and the rest is owed to the supplier in
  Trade payables, with the supplier named.
- **Input tax** is claimed only where the company is registered for sales tax and the supplier
  is registered with an STRN, at the rate in force on the bill's date for the tax category
  chosen on the line.
- **Withholding** (`withholding_entries`). For a company that withholds, a bill names the line
  of the withholding tables that applies, for each of income tax (section 153), sales tax
  (Eleventh Schedule) and the province's sales tax on services. The database reads the rate in
  force on the bill's date, at the rate for a supplier who is or is not on the Active Taxpayers
  List as recorded on the supplier that day, and writes one entry for each: the line, the law
  it cites, the amount it was worked on, the rate and the amount. Nothing about a rate is ever
  typed, and the app cannot write or change an entry.
- **The draft shows what posting will do**: the totals, each amount withheld with its rate, and
  what will be owed to the supplier, worked out from the same tables.
- **Goods received, not yet billed** now leaves out what has been billed, line by line.
- **Every command writes an audit row**, including switching withholding on or off.

**The acceptance test**, "A Rs 100,000 goods bill from a non-ATL company withholds 10% and posts
to the withholding payable account": in `src/modules/supplier-bills/bills.test.ts`, and on
screen in `e2e/supplier-bills.spec.ts`. The journal is debit Goods received not invoiced
100,000; credit Income tax withheld payable 10,000; credit Trade payables 90,000.

## Decided for Fazal, to confirm

Nobody was asked these while building. Each is the option I would recommend; say if any should
change.

1. **Who does what.** The owner and an accountant write and post bills and switch withholding on
   or off. The auditor reads. Nobody else sees a bill: it shows what things cost.
2. **Tax withheld is recorded when the bill is posted**, not when it is paid, and the supplier
   is then owed the rest. This is what the plan's test asks for, and it keeps what is owed to a
   supplier and what is owed to the government apart from the first day. The law itself deducts
   at the time of payment; see "For a tax adviser".
3. **The person entering the bill chooses the withholding lines**, from the lines in force. The
   income tax line for the supplier's kind (company, or individual or AOP) is offered already
   chosen on a bill of goods. The product does not decide by itself whether a bill is under the
   yearly limits (Rs 75,000 of goods, Rs 30,000 of services from one supplier): the form says
   what the limits are, and "Nothing withheld" is chosen for such a bill.
4. **Whether a supplier is on the Active Taxpayers List is what is recorded on the supplier** on
   the day the bill is posted. Nobody checks FBR's list automatically yet.
5. **The province's sales tax on a service bill is charged on the services billed, added to the
   cost of the service, and withheld whole.** Only a company that withholds enters it; one that
   does not simply enters what the supplier charges. Withholding a part of it (a fifth, a half:
   the rule differs by province and by whether the provider is registered) is not built: see
   "For a tax adviser".
6. **Input tax is the line's amount at the rate in the tax tables.** If the supplier's invoice
   shows a different tax (rounding, a special rate), the bill cannot be made to match it to the
   rupee yet. Goods taxed on their printed retail price (the Third Schedule) cannot carry input
   tax on a bill yet at all.
7. **A bill belongs to one branch**, and bills goods received into that branch's warehouses.
8. **A supplier's invoice number is billed once.** The same number from the same supplier,
   whatever the capitals or spaces, is refused when the second bill is posted.
9. **A posted bill is never changed or cancelled.** A wrong bill is put right with a supplier
   return or debit note (Step 27). Until then there is no way on screen to undo one, so a bill
   is saved as a draft first, the draft shows what posting will do, and posting is a separate
   button.
10. **A bill is in rupees.** Bills in a foreign currency come with Step 26 and imports.
11. **A bill cannot be dated in the future**, in a locked period, or before the books opened.
12. **An archived supplier can still be billed** for goods already received from it.

## For a tax adviser

No accountant or tax adviser has checked any of this. The second, independent working of the
worked example (`docs/examples/step-25.md`) agreed with every figure, and raised these doubts
about the policies themselves:

- **Timing.** Section 153 has tax deducted when the supplier is paid. Recording it at the bill
  means the withholding payable accounts hold tax that is not yet due to the government until
  the bill is paid, and an advance paid before any bill withholds nothing here. Step 26
  (payments, challans) must decide when the amount becomes due and deal with advances.
- **The yearly limits** (Rs 75,000 goods, Rs 30,000 services from one supplier) are left to the
  person entering the bill. The product could add up the year's bills and warn.
- **Which line a service falls under.** Freight, courier, security and the other listed sectors
  are on the lower "listed" line, not "any other service". The form lists the sectors under the
  income tax choice (as `docs/RATES-REVIEW.md` asked), but the choice is the person's.
- **Purchase price differences as an expense.** Accounting standards want stock at what it
  actually cost; a large difference on goods still in stock belongs in the stock value. The
  founder chose the separate account, and Step 28 (landed cost) is where differences can be
  spread over stock.
- **Sales tax withholding** is offered only when there is sales tax on the bill or the line is
  worked on the gross amount; who must withhold from an unregistered supplier, and the
  exclusions of the Eleventh Schedule, are not enforced. The sales tax active-taxpayer list and
  the income tax one are treated as the same record on the supplier.
- **Provincial sales tax.** Withholding the whole tax fits Punjab and an unregistered provider
  elsewhere; other cases withhold a part. Treating it as part of the expense is the cautious
  choice; it may be adjustable against output tax in some cases.

## Later

- **Supplier payments, advances and challans (Step 26).** A posted bill's "owed to the
  supplier" is what Step 26 pays. `withholding_entries` has no challan yet.
- **Supplier returns and debit notes (Step 27)**: the only way to undo a posted bill.
- **Aged payables, the supplier statement, the withholding register and the section 165
  statement (Step 29).** The entries hold what those need: kind, line, law, base, rate, amount,
  supplier, date.
- **A tax amount that differs from the table's by the supplier's own rounding**, and Third
  Schedule goods (point 6).
- **A bill for goods with no purchase order** (bought over the counter and brought straight in).
  Today goods reach stock only through an order and a goods received note.
- **Checking FBR's Active Taxpayers List** when a bill is written (point 4).
- **Lists show the newest 200 bills**; no search, paging or export yet.

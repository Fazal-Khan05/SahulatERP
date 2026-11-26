# Moving a company in from its old system

A checklist for bringing a company's books into SahulatERP from what it used before (Fast
Accounts, Tally, another program, or Excel). Everything below is done by the company's owner or
accountant under **Settings, Import data**. Each file is checked row by row before anything is
kept, and goes in whole or not at all; the same rows never go in twice.

## Before you start

1. **Pick the day the books open here.** Usually the first day of a month, or of the year. Every
   balance you bring in is the balance at the end of the day before it. Agree it with whoever keeps
   the books, and stop entering things in the old system for that period once you have taken the
   figures out.
2. **Finish setting up the company**: its branches and warehouses (Settings, Branches), its chart
   of accounts (Settings, Accounts), and the fiscal year that holds the opening day (Settings,
   Fiscal periods). Add to the chart every account of the old trial balance that the standard chart
   does not have, such as each bank account, each loan, each fixed asset, with the code you want it
   to have here.
3. **Add the units and the item categories** the items will use (Items, Units and categories).
   The item import names any it cannot find.
4. **Take the files out of the old system**, as Excel (.xlsx) or CSV: the customer list, the
   supplier list, the item list, the stock on hand by warehouse with what each item cost, the
   unpaid invoices of every customer, the unpaid bills of every supplier, and the trial balance on
   the day before the opening day. An older Excel file (.xls) has to be saved again as .xlsx first.
   Keep these files somewhere safe: they hold your customers' details.

## Bringing it in, in this order

Each kind of file has a template with our headings (Excel or CSV) under Settings, Import data, but
the old system's own file will do: after you choose the file, match each of our columns to one of
its columns (the screen guesses, and remembers your choices for the next file of that kind). Rows
the old system adds, such as a total at the bottom, are left out by their row number. **Check the
file** shows every row that is wrong and what is wrong with it, and keeps nothing; **Import** then
brings in every row, or none.

1. **Customers.** One row each: name (needed), code, tax numbers, credit limit and days, phone,
   email, address.
2. **Suppliers.** The same, for suppliers.
3. **Items.** Code, name and unit are needed; category, prices, a second unit it comes in (such as
   a carton of 12) and the rest as far as the old system has them.
4. **Start the opening entry** under Settings, Opening balances, with the opening day. Steps 5 to 7
   go onto it.
5. **Opening stock.** Item code, quantity and what one cost, for each warehouse: either one file
   with a Warehouse column naming each row's warehouse, or one file per warehouse chosen on the
   screen. It comes in as a draft for each warehouse, dated on the opening day: open it under
   Stock, Adjustments, look it over and post it. Its value goes against Opening balance equity.
6. **What customers owe**, invoice by invoice: customer (by code or exact name), invoice number,
   invoice date, due date if there is one, and what is still unpaid on it. Recovery, receipts and
   the ageing then treat each one like an invoice made here. **What you owe suppliers**, bill by
   bill, the same way: Aged payables shows each by its date. (A payment to a supplier cannot yet be
   set against one of these bills: it stands as paid ahead to that supplier and is netted against
   what is owed to them.)
7. **The trial balance**, by this company's account codes, with debits and credits. Leave out
   stock, trade receivables and trade payables: they come from steps 5 and 6. Anything the lines do
   not balance by goes to Opening balance equity by itself.
8. **Post the opening balances** under Settings, Opening balances, once every line is right. From
   then on they are only corrected by reversing them, which brings them back as a draft.

## Checking it

9. **Check what came in** (Settings, Import data, step 8): it lists anything still to do (a draft
   not posted), shows whether stock, what customers owe and what is owed to suppliers each agree
   with their account in the books, and shows the trial balance.
10. **Compare that trial balance with the old system's**, account by account, on the day before the
    opening day. Opening balance equity first takes the stock left out of step 7, and posting the
    opening stock gives it back, so once everything is in and posted it should stand at nil. Whatever
    is left in it is a difference between the files: unpaid invoices that do not add up to the old
    system's debtors, stock valued differently from its stock account, or a trial balance that did
    not balance. Find it, correct it, and it goes.
11. **Compare the ageing** (Recovery, Ageing; and the Aged payables report) with the old system's
    list of what customers owe and what is owed to suppliers.
12. Keep running the old system beside this one for the first month if you can, and compare the
    month's closing trial balance in both.

## If something is wrong

- A file with mistakes is never half imported: correct the file, or leave the wrong rows out, and
  check it again.
- A customer, supplier or item that came in wrongly is corrected on its own page.
- Opening stock: a draft is changed or thrown away before it is posted; once posted, it is
  corrected with a stock adjustment.
- Opening balances: reverse them under Settings, Opening balances; they come back as a draft to
  correct and post again.

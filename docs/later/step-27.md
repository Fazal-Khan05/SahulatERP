# Step 27: supplier returns (debit notes)

Built in track B (stock and buying) by the Builder, on Step 26's supplier payments. Migration
`0033_supplier_returns`. Built while the founder was away (2026-11-17): nothing here was asked
of him, and **the migration is not on the shared development database** (his yes of 2026-11-15
covered Steps 24 to 26 only).

## What was built

- **Supplier returns** (`/purchases/returns`). Goods are sent back against one posted goods
  received note. The page lists what can still go back from it: for each line, the goods no
  bill has billed yet, and the goods each posted bill billed. The return says how much of each
  goes back, on which day and why. It is a draft until it is posted; posting gives it its
  number (DB-2627-00001, a debit note).
- **What posting does**, in one act of the database (`app.post_supplier_return`). The goods
  leave the warehouse at what the stock is carried at that day, and:

  | Account | Debit | Credit |
  | --- | ---: | ---: |
  | 2120 Goods received not invoiced | goods not billed: what they came into stock at | |
  | 2110 Trade payables | goods billed: what the bill charged for them, with its sales tax | |
  | 1400 Sales tax receivable (input tax) | | the sales tax on those billed goods |
  | 1300 Stock in trade | | what the goods left stock at |
  | 5120 Purchase price differences | whatever is left between the two, either side | |

- **What the supplier owes back** for billed goods comes off the bill the goods were billed
  on, as far as that bill is still owed. If the bill was already paid, the rest stays a credit
  with the supplier, shown on the return, and is set against another bill of the same supplier
  later on the return's page. Nothing is posted for that: the debit note already took the whole
  amount off what is owed to the supplier.
- **Goods sent back before they were billed can no longer be billed**, and "Goods received, not
  yet billed" leaves them out. Paying a bill counts what returns took off it.
- A goods received note has a link "Send goods from this note back to the supplier".
- **Every command writes an audit row.**

**The acceptance test**, "Reverses GRNI or AP as appropriate": in
`src/modules/supplier-returns/returns.test.ts` (two tests, one for each half) and on screen in
`e2e/supplier-returns.spec.ts`. Ten helmets arrive at Rs 600; four go back unbilled, and Rs
2,400 comes off Goods received not invoiced. Ten pairs of gloves billed at Rs 220 with 18% tax;
three go back, and Rs 778.80 comes off what is owed to the supplier, Rs 118.80 of it input tax.

## Two functions of earlier steps, written out again

Both are this track's own, so `docs/PARALLEL.md` allows it; each is changed in one place.

- `app.post_supplier_bill` (Step 25): goods sent back unbilled count against what can be
  billed, and against what a bill clears from Goods received not invoiced. The migration's
  build script takes the text of `0030_supplier_bills.sql` and changes those lines only.
- `app.bill_owed` (Step 26): what is owed on a bill is also less what returns took off it.

## Decided for Fazal, to confirm

Nobody was asked these. Each is the option I would recommend; say if any should change.

1. **Who does what.** The owner and an accountant write and post returns; the auditor reads.
   The warehouse does not: a return carries what goods cost and what a supplier owes. (If you
   want the warehouse to record the goods leaving and the office to finish the debit note, that
   is a second step on the same document, to add later.)
2. **A return is against one goods received note.** Goods from two notes are two returns.
3. **Goods go back out of the warehouse they came into, and only if it still holds them.**
   Goods that were sold, moved to another warehouse or written off cannot be sent back from
   here.
4. **Goods leave stock at what the stock is carried at** (the average cost that day), like
   every other move out. Where that differs from what comes off Goods received not invoiced or
   off the supplier, the difference goes to Purchase price differences, the account you chose
   for bills at a different price from the order. With one purchase price and nothing else in
   stock there is no difference.
5. **Billed goods go back at the bill's price**, with the sales tax the bill charged on them,
   and the input tax claimed on them is given up.
6. **Tax withheld on the bill is not given back by a return.** It was the supplier's tax, paid
   over (or to be paid over) on its behalf, so the supplier owes back the whole value of the
   goods. (For a tax adviser, below.)
7. **The debit note comes off its own bill first, by itself.** What is left over (the bill was
   already paid) is set against another bill by hand, on the return's page. A refund of that
   credit in money is not built yet.
8. **Goods sent back do not reopen the purchase order.** If the supplier sends replacements,
   they are received on a new order.
9. **A posted return is never changed or cancelled.** One entered by mistake is put right by
   receiving the goods again (a new order) or, for a wrong quantity, by a second return.
10. **No approval step**, as with payments.
11. **Only goods are returned here.** A supplier's credit note for a service or an expense, or
    a price reduction with no goods going back, is not built yet.

## The independent review

To be written when the review is back.

## For a tax adviser

No accountant or tax adviser has checked any of this. The second, independent working of the
worked example (`docs/examples/step-27.md`) agreed with every entry, and raised these doubts.
The section and rule numbers are from the reviewer's memory and need confirming.

- **Goods go back at the average, not at their own purchase price.** Accounting standards do
  not say which. Many books take a return out at what that purchase cost. Here it leaves at the
  average, so a return can post a price difference where the supplier changed no price (15.00
  in part 4 of the example, only because a dearer lot was in stock too). The other way would
  need stock moves out at a named value, which the stock function does not do today.
- **Price differences are kept out of stock** (your decision for bills, Step 25). At a year
  end, differences on goods still unsold may need moving into stock if they are large.
- **The debit note and input tax** (Sales Tax Act 1990, section 9; Sales Tax Rules 2006,
  Chapter III). Whether input tax can be reduced without the supplier's matching credit note;
  what to do where the input tax was never claimed or was capped; and the time limit (recalled
  as 180 days from the supply, which the Commissioner can extend). Nothing here checks a time
  limit or asks for the supplier's credit note before posting.
- **"Not yet billed" from a registered supplier.** A registered supplier must issue its tax
  invoice when it supplies, so goods with no bill in the books may already carry one. A debit
  note may then be needed even though this product treats the goods as unbilled.
- **Income tax withheld (section 153).** On goods returned before payment, tax should be
  withheld only on what is finally paid. Here it is recorded at the bill (the open question of
  Steps 25 and 26), so a return after the bill leaves the tax withheld on the whole bill, and
  the supplier owing the whole value back. Whether that tax can be adjusted against later
  payments to the same supplier, and how the section 165 statement is corrected, needs an
  adviser.
- **A supplier that owes money back** should be shown as a receivable at a year end, not
  netted against what is owed to other suppliers. Step 29's reports should show it apart.
- **Back-dating.** The average "on that day" is the average when the return is posted. A
  return dated before later purchases is still valued at today's average.
- **FBR digital invoicing.** If the company or the supplier must invoice through FBR's system,
  the debit note may have to go through it too (out of scope with FBR invoicing, for now).

## Later

- **A refund in money** of a credit a supplier owes back, and a **supplier's credit note with
  no goods** (a price reduction, a service).
- **Cancelling a return** posted by mistake.
- **Reopening the order** for replacements, if you want that.
- **Returns from another warehouse** than the one the goods came into.
- **The warehouse's part**: a goods-out note the warehouse writes, which the office turns into
  the debit note.
- **Aged payables and the supplier statement (Step 29)** will show debit notes and unused
  credits.
- **Lists show the newest 200 returns**; no search, paging or export yet.

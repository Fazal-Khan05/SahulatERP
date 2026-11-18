# Step 28: shipments, import charges and landed cost

Built in track B (stock and buying) by the Builder, on Step 27's supplier returns. Migration
`0035_shipments` (renumbered from 0034 on 2026-11-18, after the joint line-guards fix). Built
while the founder was away (2026-11-17): nothing here was asked of him. He said yes on
2026-11-18 (in the coordinator's chat) to every finished step going on the shared development
database after its review and tests; the coordinator applies it.

## What was built

- **Shipments** (`/purchases/shipments`, shown when Imports is switched on). A shipment is one
  consignment from a supplier. It takes its number as it is opened (SH-2627-00001) and carries
  what identifies it: where it was shipped from, the port, the container, bill of lading, letter
  of credit and goods declaration (GD) numbers, the GD date, the customs value, and the day it
  is expected. **How far it has come** is one of ordered, shipped, at the port, cleared customs,
  received, and is changed by hand.
- **Its goods** are the goods received notes it brought: posted notes from its supplier into
  its branch, each on one shipment.
- **Its charges.** The freight, duty, clearing, tax paid at import and deposits are entered as
  ordinary supplier bills (from the clearing agent, the shipping line, or customs set up as a
  supplier), with **Goods in transit** chosen as the account of each line. So they are owed,
  paid and, where it applies, have tax withheld like any other bill. Each such line is then put
  on the shipment with what kind of charge it is. **The five kinds:**

  | Kind | Where it goes when the shipment is closed |
  | --- | --- |
  | Part of what the goods cost | Spread over the goods, by value, quantity, weight or volume |
  | Sales tax paid at import, claimed back | 1400 Sales tax receivable (input tax) |
  | Income tax paid at import | 1410 Advance income tax |
  | Deposit that comes back | An asset account you choose (1220 Deposits and prepayments) |
  | Expense, not part of what the goods cost | An expense account you choose |

- **Closing the shipment** spreads every charge that is waiting, in one journal, and credits
  Goods in transit with all of them. A charge that is part of what the goods cost is shared
  over the lines of the goods to the paisa. Then, item by item, the part of what the shipment
  brought that the company **still holds** takes its share into stock (each unit is then
  carried at more), and the part that has **already gone** takes its share to cost of goods
  sold. The page shows all of this before it is done, and the landed cost of one of each item
  after.
- **A charge that comes late** is put on the closed shipment and spread the same way, on its
  own: it adjusts the stock still held and the cost of the units already sold.
- **Goods in transit** on the shipments list: what the account holds, beside the charges that
  explain it (on shipments and not yet spread; billed and not yet on a shipment).
- The stock movement report shows these changes of value, with no quantity.
- **Every command writes an audit row.**

**The acceptance test**, "Port the old allocation tests; a late freight bill adjusts remaining
stock and COGS of sold units": the allocation cases of the old engine
(`reference/tests/qa/09-imports.test.ts`, IMP-017 to IMP-028 and those around them) are carried
over in `src/modules/shipments/rules.test.ts` and, against the database, in
`src/modules/shipments/shipments.test.ts`, to the paisa instead of to four decimals. The late
freight bill: ten arrive at Rs 100, four are sold, duty of Rs 1,000 is spread (600 to stock,
400 to cost of goods sold); a freight bill of Rs 500 comes after the shipment is closed, and
300 goes to the six still held and 200 to the cost of the four sold. On screen:
`e2e/shipments.spec.ts`.

What the old tests covered that is different here, on purpose: a shipment is opened on its
own and goods are put on it (the old one was made from a document); charges are bill lines,
not amounts typed on the shipment, so they are owed to someone and paid; there is no charge in
a foreign currency; allocation happens when the shipment is closed.

## Two things of earlier steps, changed

- `app.check_supplier_bill_line` is written out again, on the joint migration's version of it
  (`0033_line_guards`): a bill line may be charged to Goods in transit, the one locked account a
  bill can name. Nothing else in it changes.
- Two checks on `stock_moves` (stock is this track's) no longer ask every move for a quantity:
  a move may now carry a value and no quantity. Only `app.revalue_stock`, which the app cannot
  call, writes one.

## Decided for Fazal, to confirm

Nobody was asked these. Each is the option I would recommend; say if any should change.

1. **Charges are supplier bills charged to Goods in transit, not amounts typed on the
   shipment.** It means every charge is owed to someone and paid through the same screens as
   any bill, and a charge cannot be put on a shipment twice or at a different amount from its
   bill. Duty paid at the bank is entered as a bill from customs (a supplier called, say,
   "Collector of Customs") and paid with a supplier payment. Once payments out of the bank
   without a bill exist (Phase 5), duty could go straight to Goods in transit.
2. **Spread by value unless you say otherwise.** The form starts on "by value"; quantity,
   weight and volume are one click away. Weight and volume come from the item's card.
3. **What the goods cost is fixed when the shipment is closed.** Until then nothing is added
   to stock, however many bills have come. After that, goods cannot be put on it or taken off.
4. **A late charge is spread on its own, on the day it is spread**, over the same goods. It
   does not go back and change earlier months.
5. **What of a shipment is "still held" is counted in its own branch, item by item, taking the
   newest goods as the ones still on the shelf** (as the stock ageing report does): what the
   branch holds of the item, less what came into the branch after the shipment's goods (other
   purchases, found stock; not moves between its warehouses, nor goods customers sent back),
   never below nothing and never more than the shipment brought. If the shipment brought ten,
   nothing came after, and the branch holds six, six tenths of the charge goes into stock and
   four tenths to cost of goods sold. Two shipments of one item no longer both claim the same
   units: the older one's charge goes to the cost of what was sold first. Goods moved to another
   warehouse of the branch still count as held, and take their share where they are; another
   branch's stock is never touched.
6. **Who does what.** The owner and an accountant work on shipments; the auditor reads. The
   warehouse does not see them (they carry cost). It goes on receiving goods as before.
7. **How far a shipment has come is changed by hand**, in any order. Nothing follows from it.
8. **A shipment is one supplier's, in one branch.** A container shared by two suppliers is two
   shipments.
9. **A shipment is never deleted.** One opened by mistake, with nothing on it, is cancelled
   with a reason and keeps its number.
10. **Spreading cannot be undone.** A charge spread wrongly is put right by a journal an
    accountant writes, or by the supplier's credit note when those exist.
11. **Charges and goods are in rupees.** A bill in a foreign currency is not built yet.
12. **Value-addition tax at import** has no kind of its own: where the company can claim it,
    enter it as sales tax paid at import; where it cannot, as part of what the goods cost.
    (For a tax adviser, below.)

## The independent review (2026-11-17, fixed 2026-11-18)

A reviewer who had not seen the work attacked the migration as a signed-in member running any
SQL as the app's database role, with sessions racing each other, about sixty spreadings, and a
check of the books after each. **Nothing critical or high.** Two medium and four low findings,
all put right:

- **Medium: the spreading reached another branch.** "Still held" was counted in every
  warehouse of the company, so a main-branch shipment could revalue stock in a north-branch
  warehouse, in a main-branch journal, by a member who cannot read that stock. Now only the
  shipment's own branch counts and is revalued.
- **Medium: the same units were claimed twice.** Two shipments of one item (or a shipment and
  another purchase) each counted every unit held as their own, so both charges went wholly to
  stock when half the goods had been sold. Now the newest goods are taken as the ones still
  held (point 5 above).
- **Low: a stock balance made while the spreading waited for its locks was not held.** It now
  holds the branch's balances again until no new one appears, before it reads anything.
- **Low: shipment numbers could be skipped** (`insert ... on conflict do nothing` with a taken
  id still took a number). A row whose id is taken is now refused before a number is taken. Two
  sessions inserting the same new id at the same moment could still skip one; a number of a
  shipment is never reused, and a gap carries no tax meaning.
- **Low: sales tax paid at import could be claimed by a company not registered for sales tax.**
  Refused now, when the charge is put on and again when it is spread.
- **Low: a member could tell a shipment of another branch from no shipment** by the words of
  the refusal. Both are refused in the policy's words now.

Notes, not changed: a delivery cancelled after a charge's share went to cost of goods sold comes
back at the old cost; units sent back to the supplier count as gone; a spreading dated in the
past uses today's holdings. The reverse file now also removes the shipments' number series.

What held: charges and goods put on twice, on two shipments, from another branch, supplier or
company, a draft bill, a line not charged to Goods in transit; taking off or spreading again
after spreading; two spreadings of one shipment, and of two that share items, at once; spreading
against adding or removing a charge or goods; the arithmetic to the paisa (tiny charges over ten
lines, lines with none of the measure, four-decimal quantities, very large amounts); what each
bill line charged against the bill's journal, provincial tax included; the rewritten bill-line
guard; writing anything of the spreading past the functions; reading as another role, branch or
company; dates; no deadlock in 48 parallel stock documents; the reverse file.

## For a tax adviser

No accountant or tax adviser has checked any of this. The second, independent working of the
worked example (`docs/examples/step-28.md`) agreed with every entry, and raised these doubts.
They are from the reviewer's memory of the law, not checked against it.

- **What is part of the goods' cost.** Accounting standards put duties, taxes that cannot be
  claimed back, freight, handling and the clearing agent's own fee for the consignment into
  the cost of the goods. Only delays (demurrage, detention), penalties and general overheads
  are expenses. The product lets you choose the kind of each charge; the example's agent fee
  as an expense is the old tests' choice, not advice.
- **Duty spread over items that pay different rates.** Customs works duty out line by line of
  the goods declaration, at each line's own rate. One duty amount spread by value or quantity
  over items with different rates costs them wrongly. To be exact, enter the duty as one bill
  line for each item's rate and put each on a shipment of its own goods, or wait for the goods
  declaration's lines to be kept (Later).
- **Sales tax at import** is claimed only where the goods go into taxable sales and the goods
  declaration is in the company's name. Tax that cannot be claimed should be entered as part
  of what the goods cost.
- **Value-addition tax** paid at import by a commercial importer (recalled as 3%) has no kind
  of its own here. Whether it is claimed against output tax, and how the cap on input tax
  applies to a commercial importer, needs an adviser before it is entered either way.
- **When input tax is claimed.** Here the tax paid at import stays in Goods in transit until
  the shipment is closed. The law puts it in the tax month of the goods declaration. A
  shipment left open over a month end will make the books disagree with the return. Close
  shipments promptly, or ask for tax lines to be released as soon as they are put on (Later).
- **Advance income tax at import (section 148)** for a commercial importer is recalled as a
  minimum tax: what cannot be set against the year's tax is not refunded and becomes a cost of
  the year. The product only holds it in Advance income tax.
- **A late charge is split by how many are held now**, not by following the particular units.
  With stock kept at the average that is the usual approximation. It is wrong where the units
  held came from other purchases of the same item, and it treats units written off or sent
  back as sold. The part for units already sold lands in the month the charge is spread, not
  the month of the sale.
- **The province's tax on the agent's services.** Withholding all of it suggests an agent not
  registered with the province; for a registered one a part is withheld. Where the agent is
  registered and invoices properly the tax may be claimable against output tax, not a cost.
  The product adds it to the cost of the line (Step 25's rule for every service bill).
- **Income tax withheld from the agent (section 153)** is on its fee, not on what it only
  passes on. The bill's withholding line is chosen by hand, on the whole bill.
- **A container deposit** is an asset only for what comes back; what the shipping line keeps
  is a cost when the refund is settled.
- **Goods bought in a foreign currency** should come into the books at the rate on the day
  they became the company's (often when shipped). Bills here are in rupees only.

## Later

- **Bills and charges in a foreign currency**, and the exchange difference on paying them.
- **Duty and tax paid straight from the bank**, without a bill from customs (needs payments
  out of the bank without a bill, Phase 5).
- **A refund of a container deposit**: today a journal an accountant writes, from the bank to
  the deposit account.
- **A supplier's credit note for a charge**, and undoing a spreading.
- **Item profit** (Step 31's report) takes the cost of what was sold from the deliveries. The
  part of a charge that went to cost of goods sold for units already sold is in the books but
  not in that report's cost of the item.
- **Letter of credit tracking** (margin, charges, retirement) is in the plan's backlog.
- **The goods declaration's own lines** (duty and taxes per HS code) are not kept; only the
  number, the date and the customs value.
- **Lists show the newest 200 shipments**; no search, paging or export yet.

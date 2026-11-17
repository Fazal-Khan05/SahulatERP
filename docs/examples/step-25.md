# Step 25 worked example: supplier bills and tax withheld

Checked by Claude, not by an accountant (the founder has none; decided 2026-11-13). The expected
journals were worked out from standard double-entry practice, worked out a second time by an
independent reviewer who was given only the events below and the company's policies, not the
first answer or the software, and both were compared with what the software posts. All three
agree line for line on every entry and every closing balance. The tests in
`src/modules/supplier-bills/bills.test.ts` enter these bills and fail if the software ever posts
anything else.

The second working also questioned some of the policies themselves as tax practice. Those
doubts are not about the arithmetic; they are listed in `docs/later/step-25.md` under "For a tax
adviser", and none has been settled.

## The company

Lahore Bike Parts is registered for sales tax and has switched withholding on: it deducts tax
from what it pays its suppliers. It keeps its books in rupees, to the paisa. Every rate below
is read from the dated tax tables for the bill's date; none is typed on a bill.

How it treats a supplier's bill (the founder's decisions of 2026-11-15, and the choices made for
him in `docs/later/step-25.md`):

- Goods came into stock, at the purchase order's cost, when they were received (debit Stock in
  trade, credit Goods received not invoiced). The bill comes later.
- A bill for goods clears from Goods received not invoiced what the billed goods came into
  stock at. Where a line is billed in parts, each bill brings what has been cleared of the line
  up to its exact share for all that has been billed so far, rounded to the paisa.
- If the supplier bills a different price, the difference goes to **Purchase price
  differences**. The stock value is not changed.
- Input tax (18%) is claimed only on a bill from a supplier registered for sales tax with an
  STRN.
- What is withheld is recorded when the bill is posted, and only the rest is owed to the
  supplier. Income tax under section 153 is worked on the bill's gross amount, sales tax and
  provincial tax included.
- The province's sales tax on services is charged by the supplier on the bill, added to the
  cost of the service, and withheld whole.

The rates used (from 1 July 2026): goods from a company 5%, or 10% if it is not on the Active
Taxpayers List; goods from an individual or AOP 5.5%, or 11%; any other service 14%, or 28%;
sales tax withheld from an active taxpayer one fifth of the tax; Punjab sales tax on services
16%.

## 1. A bill at the order's price

Ten helmets from Lahore Parts (an AOP, not registered, not on the list) came in at 600.00 each:
6,000.00. The first bill is for four of them at 600.00. Nothing is withheld on this bill.

| Account | Debit | Credit |
| --- | ---: | ---: |
| 2120 Goods received not invoiced | 2,400.00 | |
| 2110 Trade payables (Lahore Parts) | | 2,400.00 |

Six helmets, 3,600.00, are still received and not billed.

## 2. A bill at a higher price

The other six helmets are billed at 650.00 each: 3,900.00. They came in at 3,600.00.

| Account | Debit | Credit |
| --- | ---: | ---: |
| 2120 Goods received not invoiced | 3,600.00 | |
| 5120 Purchase price differences | 300.00 | |
| 2110 Trade payables (Lahore Parts) | | 3,900.00 |

## 3. A line billed in two parts, at lower prices

Seven grips came in at 33.3333 each: 233.33 for the seven. Three are billed at 30.00 (90.00).
Three sevenths of 233.33 is 99.9986, so 100.00 is cleared.

| Account | Debit | Credit |
| --- | ---: | ---: |
| 2120 Goods received not invoiced | 100.00 | |
| 5120 Purchase price differences | | 10.00 |
| 2110 Trade payables (Lahore Parts) | | 90.00 |

The other four are billed at 33.00 (132.00). All seven are now billed, so the rest of what the
line came in at is cleared: 233.33 less 100.00.

| Account | Debit | Credit |
| --- | ---: | ---: |
| 2120 Goods received not invoiced | 133.33 | |
| 5120 Purchase price differences | | 1.33 |
| 2110 Trade payables (Lahore Parts) | | 132.00 |

## 4. The plan's test: Rs 100,000 of goods from a company that is not on the list

A hundred helmets from Karachi Motors (Pvt) Ltd (a company, not registered for sales tax, not on
the Active Taxpayers List) came in at 1,000.00 each. The bill is for all of them: 100,000.00.
Income tax is withheld at 10%.

| Account | Debit | Credit |
| --- | ---: | ---: |
| 2120 Goods received not invoiced | 100,000.00 | |
| 2210 Income tax withheld payable | | 10,000.00 |
| 2110 Trade payables (Karachi Motors) | | 90,000.00 |

Karachi Motors then comes onto the list. The same bill again, for another hundred helmets,
withholds 5%:

| Account | Debit | Credit |
| --- | ---: | ---: |
| 2120 Goods received not invoiced | 100,000.00 | |
| 2210 Income tax withheld payable | | 5,000.00 |
| 2110 Trade payables (Karachi Motors) | | 95,000.00 |

And ten grips from Lahore Parts (an AOP, not on the list) at 40.00, 400.00 in all, withhold 11%:

| Account | Debit | Credit |
| --- | ---: | ---: |
| 2120 Goods received not invoiced | 400.00 | |
| 2210 Income tax withheld payable | | 44.00 |
| 2110 Trade payables (Lahore Parts) | | 356.00 |

## 5. Input tax, and sales tax withheld

Ten helmets from Sialkot Sports Ltd (a company registered for sales tax with an STRN, on the
list) came in at 1,000.00 each. The bill: 10,000.00 and 18% sales tax, 1,800.00: 11,800.00.
One fifth of the tax is withheld (360.00), and 5% income tax of the 11,800.00 (590.00).

| Account | Debit | Credit |
| --- | ---: | ---: |
| 2120 Goods received not invoiced | 10,000.00 | |
| 1400 Sales tax receivable (input tax) | 1,800.00 | |
| 2210 Income tax withheld payable | | 590.00 |
| 2220 Sales tax withheld payable | | 360.00 |
| 2110 Trade payables (Sialkot Sports) | | 10,850.00 |

## 6. A service, with the province's tax

Lahore Parts (not on the list) bills repairs to the shop front, 30,000.00, and painting,
20,000.00, both charged to Repairs and maintenance. Punjab's 16% on the 50,000.00 is 8,000.00,
so the bill is 58,000.00. The province's tax is withheld whole, and income tax at 28% of the
58,000.00 (16,240.00). The 8,000.00 is added to the two expense lines in proportion: 4,800.00
and 3,200.00.

| Account | Debit | Credit |
| --- | ---: | ---: |
| 5270 Repairs and maintenance (shop front) | 34,800.00 | |
| 5270 Repairs and maintenance (painting) | 23,200.00 | |
| 2210 Income tax withheld payable | | 16,240.00 |
| 2230 Provincial sales tax withheld payable | | 8,000.00 |
| 2110 Trade payables (Lahore Parts) | | 33,760.00 |

## Where it ends

| Bill | Total | Withheld | Owed to the supplier |
| --- | ---: | ---: | ---: |
| 4 helmets | 2,400.00 | | 2,400.00 |
| 6 helmets | 3,900.00 | | 3,900.00 |
| 3 grips | 90.00 | | 90.00 |
| 4 grips | 132.00 | | 132.00 |
| 100 helmets, not on the list | 100,000.00 | 10,000.00 | 90,000.00 |
| 100 helmets, on the list | 100,000.00 | 5,000.00 | 95,000.00 |
| 10 grips | 400.00 | 44.00 | 356.00 |
| 10 helmets with sales tax | 11,800.00 | 950.00 | 10,850.00 |
| Repairs and painting | 58,000.00 | 24,240.00 | 33,760.00 |
| | 276,722.00 | 40,234.00 | 236,488.00 |

| Account | Balance |
| --- | ---: |
| 2110 Trade payables | 236,488.00 credit: Lahore Parts 40,638.00, Karachi Motors 185,000.00, Sialkot Sports 10,850.00 |
| 2120 Goods received not invoiced | nil: 216,633.33 credited as the goods arrived, 216,633.33 cleared by the bills |
| 2210 Income tax withheld payable | 31,874.00 credit |
| 2220 Sales tax withheld payable | 360.00 credit |
| 2230 Provincial sales tax withheld payable | 8,000.00 credit |
| 1400 Sales tax receivable (input tax) | 1,800.00 debit |
| 5120 Purchase price differences | 288.67 debit (300.00 less 10.00 less 1.33) |
| 5270 Repairs and maintenance | 58,000.00 debit |

Each withholding account holds exactly the sum of the withholding entries of its kind, and
Trade payables exactly the sum of what the bills leave owed. The tests check both after every
run.

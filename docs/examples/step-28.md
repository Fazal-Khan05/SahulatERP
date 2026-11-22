# Step 28 worked example: import charges and landed cost

Checked by Claude, not by an accountant (the founder has none; decided 2026-11-13). The expected
journals were worked out from standard double-entry practice, worked out a second time by an
independent reviewer who was given only the events below and the company's policies, not the
first answer or the software, and both were compared with what the software posts. All three
agree line for line on every entry. The tests in `src/modules/shipments/shipments.test.ts` enter
these shipments and fail if the software ever posts anything else.

The second working also questioned some of the policies as accounting and as tax practice.
Those doubts are listed in `docs/later/step-28.md` under "For a tax adviser"; none has been
settled.

## The company

Lahore Bike Parts keeps its books in rupees, to the paisa, is registered for sales tax, and
keeps its stock at the average cost of what it holds. How it treats the charges of importing
(the choices made for the founder in `docs/later/step-28.md`):

- Charges are billed on supplier bills charged to 1310 Goods in transit, and wait there.
- Closing the shipment credits Goods in transit with all of them, in one journal.
- A charge that is part of what the goods cost is shared over the lines of the goods by value,
  quantity, weight or volume, to the paisa, the last line taking what is left.
- Item by item, the part of what the shipment brought that is still held takes its share into
  stock; the part already sold takes its share to cost of goods sold.
- Sales tax paid at import goes to input tax, income tax paid at import to Advance income tax,
  a deposit to an asset account, an expense to an expense account.
- A charge that comes after the shipment was closed is spread the same way, on its own.

## 1. A shipment with all five kinds of charge

A shipment brings 7 of product A and 3 of product B, received at 1,000.00 each. Nothing has
been sold. The clearing agent's bill has five lines, each charged to Goods in transit:

| Account | Debit | Credit |
| --- | ---: | ---: |
| 1310 Goods in transit (freight) | 50,000.00 | |
| 1310 Goods in transit (customs duty) | 80,000.00 | |
| 1310 Goods in transit (sales tax at import) | 30,000.00 | |
| 1310 Goods in transit (container deposit) | 20,000.00 | |
| 1310 Goods in transit (agent's fee) | 5,000.00 | |
| 2110 Trade payables (Karachi Clearing) | | 185,000.00 |

Freight is spread by value (7,000 to 3,000): 35,000.00 on A, 15,000.00 on B. Duty is spread by
quantity (7 to 3): 56,000.00 on A, 24,000.00 on B. Closing the shipment:

| Account | Debit | Credit |
| --- | ---: | ---: |
| 1300 Stock in trade | 130,000.00 | |
| 1400 Sales tax receivable (input tax) | 30,000.00 | |
| 1220 Deposits and prepayments | 20,000.00 | |
| 5310 Legal and professional fees | 5,000.00 | |
| 1310 Goods in transit | | 185,000.00 |

A is now 7 at 98,000.00 and B 3 at 42,000.00: 14,000.00 each. Goods in transit is nil.

## 2. The four ways of spreading

The same goods, one charge each time:

| Charge | Spread by | On A | On B |
| --- | --- | ---: | ---: |
| Freight 50,000.00 | value, 7,000 to 3,000 | 35,000.00 | 15,000.00 |
| Duty 1,000.00 | quantity, 7 to 3 | 700.00 | 300.00 |
| Freight 1,700.00 | weight, 7 × 2 to 3 × 1 | 1,400.00 | 300.00 |
| Freight 2,400.00 | volume, 7 × 3 to 3 × 1 | 2,100.00 | 300.00 |

Three items of 10.00 each share 100.00 as 33.33, 33.33 and 33.34: the paisa that is left goes
to the last line. A charge of 0.01 lands whole on the first line. A product with no weight on
its card takes nothing of a charge spread by weight; if none of the goods has a weight, the
charge cannot be spread that way and the shipment is not closed.

## 3. The plan's test: goods partly sold, and a late freight bill

10 of product D arrive at 100.00. 4 are sold and delivered: 400.00 to cost of goods sold, and
6 are left at 600.00. Customs duty of 1,000.00 is billed and the shipment is closed. Six tenths
belongs to the units still held, four tenths to the units sold:

| Account | Debit | Credit |
| --- | ---: | ---: |
| 1300 Stock in trade | 600.00 | |
| 5100 Cost of goods sold | 400.00 | |
| 1310 Goods in transit | | 1,000.00 |

The six are now carried at 1,200.00, 200.00 each. Then a freight bill of 500.00 comes for the
same shipment, after it was closed. It is spread on its own, the same way:

| Account | Debit | Credit |
| --- | ---: | ---: |
| 1300 Stock in trade | 300.00 | |
| 5100 Cost of goods sold | 200.00 | |
| 1310 Goods in transit | | 500.00 |

The six are now at 1,500.00, 250.00 each, which is the full landed cost of one (100.00 +
100.00 + 50.00). Two more are sold: 500.00 to cost of goods sold. In all, 2,500.00 was spent on
the ten; 1,500.00 is the cost of the six sold and 1,000.00 is the four still held.

If all ten had been sold before the duty came, all 1,000.00 of it would go to cost of goods
sold and nothing to stock.

## 4. Goods moved to another store

10 of product F arrive at 100.00 into the main store; 4 are moved to the city store. Duty of
1,000.00 is spread. All ten are still held, so all of it goes into stock, 600.00 where six are
and 400.00 where four are: the main store holds 6 at 1,200.00 and the city store 4 at 800.00.

## 5. A bill with the province's tax on services

The agent bills terminal handling 2,000.00 and its fee 1,000.00, with Sindh's 15% on both
(450.00), which the company withholds in full. The tax is part of what each line cost: 300.00
and 150.00.

| Account | Debit | Credit |
| --- | ---: | ---: |
| 1310 Goods in transit (terminal handling) | 2,300.00 | |
| 1310 Goods in transit (agent's fee) | 1,150.00 | |
| 2230 Provincial sales tax withheld payable | | 450.00 |
| 2110 Trade payables (Karachi Clearing) | | 3,000.00 |

On the shipment the handling is part of what the goods cost and the fee is an expense:

| Account | Debit | Credit |
| --- | ---: | ---: |
| 1300 Stock in trade | 2,300.00 | |
| 5310 Legal and professional fees | 1,150.00 | |
| 1310 Goods in transit | | 3,450.00 |

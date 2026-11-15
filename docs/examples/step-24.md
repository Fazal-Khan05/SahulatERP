# Step 24 worked example: purchase orders and goods received

Checked by Claude, not by an accountant (the founder has none; decided 2026-11-13). The expected
journals were worked out from standard double-entry practice, worked out a second time by an
independent reviewer who was given only the events below and the company's policies, not the
first answer or the software, and both were compared with what the software posts. All three
agree line for line on every entry, every stock value and both closing balances. The tests in
`src/modules/purchasing/purchasing.test.ts` enter these orders and goods received and fail if
the software ever posts anything else.

## The company

Lahore Bike Parts keeps its books in rupees, to the paisa, and its stock at weighted-average
cost. Its stock starts empty. No supplier bill arrives during these events, so nothing reaches
Trade payables, and there is no tax: tax comes with the supplier's bill (Step 25).

How it treats buying (the choices made for the founder in `docs/later/step-24.md`):

- A purchase order is a promise. It posts nothing and moves no stock. Cancelling an order
  nothing has arrived against posts nothing either.
- When goods arrive against an order, a goods received note is posted. The goods come into
  stock at the order's cost: each line is worth the quantity received, in the unit it was
  ordered in, times the order's cost of one of that unit, rounded to the paisa, half up.
- Each note posts one entry for the total of its lines: debit 1300 Stock in trade, credit 2120
  Goods received not invoiced (goods that have arrived and are not billed yet).

## 1. An order: nothing is posted

10 November: PO-2627-00001 to Lahore Parts, into the Main store.

| Line | Quantity | Cost of one | Amount |
| --- | ---: | ---: | ---: |
| HL-1 Helmet | 10 pieces | 600.00 | 6,000.00 |
| CH-2 Chain | 5 cartons of 12 | 3,000.00 a carton | 15,000.00 |
| | | Total before tax | 21,000.00 |

No entry. No stock.

## 2. Part of it arrives

12 November: GR-2627-00001. 4 helmets and 2 cartons of chains.

| Line | Arithmetic | Value |
| --- | --- | ---: |
| Helmets | 4 × 600.00 | 2,400.00 |
| Chains | 2 cartons × 3,000.00 (24 chains) | 6,000.00 |

| Account | Debit | Credit |
| --- | ---: | ---: |
| 1300 Stock in trade | 8,400.00 | |
| 2120 Goods received not invoiced | | 8,400.00 |

Stock held: 4 helmets worth 2,400.00; 24 chains worth 6,000.00.

## 3. The rest arrives

13 November: GR-2627-00002. The other 6 helmets and 3 cartons. More than is left of the order
would have been refused.

| Line | Arithmetic | Value |
| --- | --- | ---: |
| Helmets | 6 × 600.00 | 3,600.00 |
| Chains | 3 cartons × 3,000.00 (36 chains) | 9,000.00 |

| Account | Debit | Credit |
| --- | ---: | ---: |
| 1300 Stock in trade | 12,600.00 | |
| 2120 Goods received not invoiced | | 12,600.00 |

Stock held: 10 helmets worth 6,000.00; 60 chains worth 15,000.00. Both accounts hold 21,000.00:
the whole order.

## 4. A cost that does not divide to the paisa, and an item already in stock

A second order to Lahore Parts: 7 grips at 33.3333 each (233.33) and 5 helmets at 700.00 each
(3,500.00). Total 3,733.33. No entry.

The first note against it brings 3 grips:

| Line | Arithmetic | Value |
| --- | --- | ---: |
| Grips | 3 × 33.3333 = 99.9999, to the paisa | 100.00 |

| Account | Debit | Credit |
| --- | ---: | ---: |
| 1300 Stock in trade | 100.00 | |
| 2120 Goods received not invoiced | | 100.00 |

The second brings the other 4 grips and the 5 helmets:

| Line | Arithmetic | Value |
| --- | --- | ---: |
| Grips | 4 × 33.3333 = 133.3332, to the paisa | 133.33 |
| Helmets | 5 × 700.00 | 3,500.00 |

| Account | Debit | Credit |
| --- | ---: | ---: |
| 1300 Stock in trade | 3,633.33 | |
| 2120 Goods received not invoiced | | 3,633.33 |

Stock held: 7 grips worth 233.33. The helmets average: 10 held at 600.00 and 5 more at 700.00
are 15 worth 9,500.00, so a helmet now costs 633.33 on average.

Here the two lots of grips (100.00 and 133.33) come to exactly the order's line (233.33). That
is not always so: each lot is rounded on its own, so lots can differ from the order's line by a
paisa. What is in the books is always the sum of what was received, and Stock in trade and
Goods received not invoiced always move by the same amount.

## 5. An order cancelled before anything arrives

A third order, 2 helmets at 650.00, is cancelled the same day ("not needed"). No entry. It
keeps its number and stays on the list, marked cancelled, with the reason.

## Where it ends

| Account | Balance |
| --- | ---: |
| 1300 Stock in trade | 24,733.33 debit |
| 2120 Goods received not invoiced | 24,733.33 credit |
| 2100 Trade payables | nil |

| Item | Quantity | Value | Average cost |
| --- | ---: | ---: | ---: |
| Helmets | 15 | 9,500.00 | 633.33 |
| Chains | 60 | 15,000.00 | 250.00 |
| Grips | 7 | 233.33 | 33.33 |
| | | 24,733.33 | |

The report "Goods received, not yet billed" lists the seven lines above, note by note, and
comes to 24,733.33: what the account Goods received not invoiced holds.

| Note | Line | Value |
| --- | --- | ---: |
| GR-2627-00001 | 4 helmets | 2,400.00 |
| GR-2627-00001 | 2 cartons of chains | 6,000.00 |
| GR-2627-00002 | 6 helmets | 3,600.00 |
| GR-2627-00002 | 3 cartons of chains | 9,000.00 |
| third note | 3 grips | 100.00 |
| fourth note | 4 grips | 133.33 |
| fourth note | 5 helmets | 3,500.00 |
| | Total | 24,733.33 |

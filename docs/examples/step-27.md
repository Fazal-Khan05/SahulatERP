# Step 27 worked example: goods sent back to suppliers

Checked by Claude, not by an accountant (the founder has none; decided 2026-11-13). The expected
journals were worked out from standard double-entry practice, worked out a second time by an
independent reviewer who was given only the events below and the company's policies, not the
first answer or the software, and both were compared with what the software posts. All three
agree line for line on every entry. The tests in
`src/modules/supplier-returns/returns.test.ts` enter these returns and fail if the software ever
posts anything else.

The second working also questioned some of the policies as accounting and as tax practice.
Those doubts are listed in `docs/later/step-27.md` under "For a tax adviser"; none has been
settled.

## The company

Lahore Bike Parts keeps its books in rupees, to the paisa, is registered for sales tax, and
keeps its stock at the average cost of what it holds. How it treats goods going back (the
choices made for the founder in `docs/later/step-27.md`):

- Goods leave stock at what the stock is carried at that day, like every other move out.
- Goods **not yet billed** come off Goods received not invoiced at what they came into stock at.
- Goods **already billed** are a debit note: what the bill charged for them, with its sales
  tax, comes off Trade payables, and the input tax claimed on them is given up.
- Whatever is left between the two sides goes to Purchase price differences.
- The debit note comes off the bill the goods were billed on, as far as that bill is unpaid.
  The rest stays a credit with the supplier until it is set against another of its bills.
- No income tax is withheld from suppliers in this example.

## 1. The plan's test, first half: goods not yet billed

3 November: 10 helmets arrive from Lahore Parts at 600.00 each, 6,000.00 in stock and in Goods
received not invoiced. 6 November: 4 are cracked and go back. No bill has come.

| Account | Debit | Credit |
| --- | ---: | ---: |
| 2120 Goods received not invoiced | 2,400.00 | |
| 1300 Stock in trade | | 2,400.00 |

Six helmets are left, at 3,600.00, and 3,600.00 is waiting for a bill. The supplier then bills
the six at 600.00: 3,600.00 leaves Goods received not invoiced, which is then nil, and is owed
to the supplier. A bill for seven is refused: four went back.

## 2. The plan's test, second half: goods already billed

3 November: 10 pairs of gloves arrive from Sialkot Sports Ltd at 200.00. 4 November: the bill
comes at 220.00 each with 18% sales tax: 2,200.00 + 396.00 = 2,596.00 owed (2,000.00 off Goods
received not invoiced, 200.00 to Purchase price differences, 396.00 input tax).
6 November: 3 pairs go back. Three tenths of the bill line is 660.00 of goods and 118.80 of
tax; the gloves are carried at 200.00 each.

| Account | Debit | Credit |
| --- | ---: | ---: |
| 2110 Trade payables (Sialkot Sports) | 778.80 | |
| 5120 Purchase price differences | | 60.00 |
| 1400 Sales tax receivable (input tax) | | 118.80 |
| 1300 Stock in trade | | 600.00 |

The debit note comes off the bill: 1,817.20 is still owed on it. Later the other 7 go back:

| Account | Debit | Credit |
| --- | ---: | ---: |
| 2110 Trade payables (Sialkot Sports) | 1,817.20 | |
| 5120 Purchase price differences | | 140.00 |
| 1400 Sales tax receivable (input tax) | | 277.20 |
| 1300 Stock in trade | | 1,400.00 |

Nothing is owed, no gloves are held, the input tax is nil again, and the 200.00 price
difference of the bill has come back in full. The two parts add up to the bill exactly.

## 3. A bill that was already paid

3 November: 5 visors arrive from Multan Traders at 100.00; billed 500.00 and paid from the bank
on 4 November. 6 November: 2 go back.

| Account | Debit | Credit |
| --- | ---: | ---: |
| 2110 Trade payables (Multan Traders) | 200.00 | |
| 1300 Stock in trade | | 200.00 |

Nothing is owed on the bill, so the 200.00 is a credit with the supplier: the books show
Multan Traders owing 200.00. Four more visors arrive and are billed, 400.00. On 7 November
150.00 of the credit, then the other 50.00, is set against that bill. **Nothing is entered in
the books for this**: both sides are what is owed to the same supplier. 200.00 is left to pay
on the bill, and is paid on 8 November. In all 700.00 left the bank, for the 7 visors kept.

## 4. One return for goods partly billed, with two purchase prices in stock

3 November: 10 grips arrive from Lahore Parts at 40.00 (400.00). 4 November: 6 of them are
billed at 45.00 (270.00: 240.00 off Goods received not invoiced, 30.00 price difference). Then
10 more arrive at 50.00: twenty are held at 900.00, 45.00 each on average.
6 November: one return sends back 3 of the unbilled grips and 2 of the billed ones.

- The 3 unbilled: 400.00 × 9 ÷ 10, less the 240.00 already cleared, is 120.00 off Goods
  received not invoiced. They leave stock at 3 × 45.00 = 135.00.
- The 2 billed: 270.00 × 2 ÷ 6 = 90.00 off the supplier. They leave stock at 2 × 45.00 = 90.00.

| Account | Debit | Credit |
| --- | ---: | ---: |
| 2120 Goods received not invoiced | 120.00 | |
| 2110 Trade payables (Lahore Parts) | 90.00 | |
| 5120 Purchase price differences | 15.00 | |
| 1300 Stock in trade | | 225.00 |

Fifteen grips are left at 675.00. One grip of the first note is still unbilled, with exactly
40.00 left for it in Goods received not invoiced; billing it at 40.00 clears that to nil.

The 15.00 is not a price the supplier changed: the grips went back at the average of two
purchase prices (45.00), while the first note's own cost was 40.00. This is the first doubt
listed for an adviser.

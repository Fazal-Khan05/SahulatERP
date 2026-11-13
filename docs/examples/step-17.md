# Step 17 worked example: the tax engine

Checked by Claude, not by an accountant (the founder has none; decided 2026-11-13). Each case
was worked by hand from the Sales Tax Act 1990, worked again by an independent reviewer who did
not see the first answers, and compared with what the engine gives. All three agree on every
case. `src/modules/tax/engine.test.ts` holds these cases and more, and fails if the engine ever
gives anything else.

## The rates used

| | Rate | Further tax | Law |
| --- | ---: | ---: | --- |
| Standard rate | 18% of the value | 4% | s.3(1); further tax s.3(1A) |
| Reduced rate (an Eighth Schedule item) | 5% of the value | 4% | s.3(2)(aa), Eighth Schedule |
| Third Schedule goods | 18% of the retail price | none | s.3(2)(a); SRO 648(I)/2013 |
| Zero-rated | 0% | none | s.4 |
| Exempt | none | none | s.13 |

Before 1 July 2026, for the case that needs it: 17% and 3%.

Ten of an item at Rs 1,000 each, with the tax added on top, unless a case says otherwise. Every
amount is rounded to the paisa, halves up.

## The cases

| | Case | Value | Sales tax | Further tax | Buyer pays |
| --- | --- | ---: | ---: | ---: | ---: |
| A | Standard rate; buyer registered and an active taxpayer | 10,000.00 | 1,800.00 | 0.00 | 11,800.00 |
| B | Standard rate; buyer not registered | 10,000.00 | 1,800.00 | 400.00 | 12,200.00 |
| C | Standard rate; buyer registered but not an active taxpayer | 10,000.00 | 1,800.00 | 400.00 | 12,200.00 |
| D | Reduced rate; buyer not registered | 10,000.00 | 500.00 | 400.00 | 10,900.00 |
| E | Third Schedule, sold at 800 each with a retail price of 1,000 each; buyer not registered | 8,000.00 | 1,800.00 | 0.00 | 9,800.00 |
| F | Exempt; buyer not registered | 10,000.00 | 0.00 | 0.00 | 10,000.00 |
| G | Standard rate with a discount of 500 on the line; buyer not registered | 9,500.00 | 1,710.00 | 380.00 | 11,590.00 |
| H | Price includes tax, 1,180 each; buyer registered and active | 10,000.00 | 1,800.00 | 0.00 | 11,800.00 |
| I | Price includes every tax, 1,220 each; buyer not registered | 10,000.00 | 1,800.00 | 400.00 | 12,200.00 |
| J | Price includes tax, 3 at 999.99 each; buyer registered and active | 2,542.35 | 457.62 | 0.00 | 2,999.97 |
| K | Dated 30 June 2026, when the rates were 17% and 3%; buyer not registered | 10,000.00 | 1,700.00 | 300.00 | 12,000.00 |

How each is worked:

- **A to D, F, G, K:** the value is the quantity times the price, less the discount. Sales tax
  is the rate times the value; further tax is its rate times the same value.
- **E:** a Third Schedule item is taxed on its retail price, whatever it sells for: 10 at 1,000
  is 10,000, and 18% of that is 1,800. It carries no further tax. The retail price here is the
  one the Act defines, before sales tax (see the open points below).
- **H:** the price is what the buyer pays. The tax inside it is 18 parts in 118:
  11,800 x 18 / 118 = 1,800.
- **I:** the price holds both taxes: 18 and 4 parts in 122. 12,200 x 18 / 122 = 1,800 and
  12,200 x 4 / 122 = 400.
- **J:** 3 at 999.99 is 2,999.97. 2,999.97 x 18 / 118 = 457.6225, rounded to 457.62; the value
  is what is left, 2,542.35.

## What the engine decides, and why

- **A company not registered for sales tax charges none.** No rate is looked up and nothing is
  refused; the line is its price.
- **Further tax is added when the buyer has no sales tax registration, or is registered but not
  an active taxpayer** (s.3(1A)). It is also added when a registered buyer's status has never
  been checked: the seller answers for further tax it did not charge, with surcharge and
  penalty, and the status is a moment's work to check. The line says which of the three reasons
  applied, so the screen can tell the user to check the customer.
- **Further tax is worked on the value before sales tax**, never on the tax.
- **A supply the law takes out of further tax** (SRO 648(I)/2013: sales to end consumers, Third
  Schedule goods and others) carries none. Third Schedule goods are handled by their category's
  rate of nil; anything else needs the buyer or the sale to be marked, which the sales documents
  will do.
- **An item with no tax category is charged the standard rate** (the founder's decision).
- **The rate is the one in force on the document's date.** No rate in force is a refusal, never
  a guess.
- **A discount on the line comes off before tax** (s.2(46)).
- **With prices that include tax, the buyer pays exactly the price.** The taxes are worked out
  of it and the value is what is left, so the three always add up to the price.

## Points the independent check raised, kept open

- **The retail price of a Third Schedule item.** The Act defines it as the price before sales
  tax (s.2(27)), and the engine multiplies it by the rate. Many packs print one price that
  already includes the tax. The item's retail price must be entered as the Act means it (the
  printed price divided by 1.18 where the print includes tax). The item screen says so.
- **The date that decides the rate** is, in law, the time of supply (when the goods are
  delivered or made available), which is usually but not always the invoice date. The engine
  uses the date it is given; the sales invoice (Step 20) decides which date that is.
- **Further tax cannot be set against input tax** and is paid over in full, so it is kept as
  its own figure on every line and must be its own figure in the return.
- **What a seller collects as tax must be paid to the government** even if it was not due
  (s.3B). Over-charging further tax to a buyer who turns out to be active is therefore not
  free; it is still the smaller risk.
- **"End consumer" is not defined in the SRO**, and tax offices question the exclusion when the
  seller cannot show who the buyer was.

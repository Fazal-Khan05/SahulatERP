# Step 46 worked example: one November's sales tax return

Checked by Claude, not by an accountant (the founder has none). Every figure is asserted by
`src/modules/tax-return/tax-return.test.ts`, which posts this month through the app's own
commands and reads the return back. The company is registered for sales tax, charges 18%, and
adds 4% further tax to a sale to an unregistered buyer.

## What happened

| Day | What | Amounts |
| --- | --- | --- |
| 15 Oct | 20 chains already on the shelf | worth 4,000 |
| 3 Nov | 10 helmets received from Sialkot Sports (registered), billed on the 4th | 6,000 + 1,080 sales tax |
| 3 Nov | 10 gloves received from Ningbo Exports on a shipment | 10,000 |
| 4 Nov | The clearing agent's bill: freight, and sales tax paid at the port | 5,000 and 3,000 |
| 6 Nov | The shipment's charges spread | freight onto the gloves; the 3,000 to input tax |
| 5 Nov | 4 helmets to a registered dealer | 4,000 + 720 |
| 5 Nov | 2 helmets to an unregistered rider | 2,000 + 360 + 80 further tax |
| 8 Nov | 1 helmet back from the dealer (credit note) | 1,000 + 180 |
| 9 Nov | The dealer pays into the bank | 3,000 |
| 10 Nov | 2 helmets back to Sialkot Sports (debit note) | 1,200 + 216 |
| 1 Dec | 1 helmet to the dealer | December's, not November's |

## The annexes for November

**Annex-C, domestic sales.** Three rows: the two invoices and the credit note.

| | Value | Sales tax | Further tax |
| --- | ---: | ---: | ---: |
| Invoice to the dealer | 4,000 | 720 | 0 |
| Invoice to the rider | 2,000 | 360 | 80 |
| Credit note to the dealer | 1,000 | 180 | 0 |
| **Total (credit note taken away)** | **5,000** | **900** | **80** |

**Annex-C1, payments received.** One row: 3,000 by bank transfer on 9 November against the
dealer's invoice of 4,720.

**Annex-A, domestic purchases.** Three rows: the helmets' bill (6,000 + 1,080), the freight on
the agent's bill (5,000, no tax), and the debit note (1,200 + 216). The 3,000 of sales tax paid
at the port is on the agent's bill too, but it is not a purchase and is left to Annex-B.
Input tax: 1,080 - 216 = **864**.

**Annex-B, imports.** One row: the shipment's goods declaration, customs value 10,000, sales tax
paid at import **3,000**, taken into the books on 6 November.

**Annex-H1, stock at cost.**

| HS code | Opening | Imported | Purchased | Supplied | Closing |
| --- | ---: | ---: | ---: | ---: | ---: |
| 4203.2100 (gloves) | 0 | 10 for 15,000 | 0 | 0 | 10 for 15,000 |
| 6506.1000 (helmets) | 0 | 0 | 8 for 4,800 | 5 for 3,000 | 3 for 1,800 |
| none (chains) | 20 for 4,000 | 0 | 0 | 0 | 20 for 4,000 |

The gloves' 15,000 is their 10,000 and the 5,000 of freight spread onto them. The helmets:
ten bought less two sent back; six sold less one returned, each at the 600 they cost. The
closing total, 20,800, is what the stock moves to the end of November add up to.

## Beside the ledger

| | Annex | Ledger | Agrees |
| --- | ---: | ---: | --- |
| Output tax (2200), from invoices and credit notes | 900 | 900 | Yes |
| Further tax (2205) | 80 | 80 | Yes |
| Input tax (1400), from bills and debit notes | 864 | 864 | Yes |
| Input tax (1400), from the shipment's spreading | 3,000 | 3,000 | Yes |
| Sales tax withheld from suppliers (2220) | 0 | 0 | Yes |

The first line is the plan's test: Annex-C's total equals the output tax in the ledger for
the month.

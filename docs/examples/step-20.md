# Step 20 worked example: sales invoices

Checked by Claude, not by an accountant (the founder has none; decided 2026-11-13). The expected
journals were worked out from the Sales Tax Act 1990 and standard double-entry practice, worked
out a second time by an independent reviewer who did not see the first answer or the software,
and both were compared with what the software posts. All three agree, line for line. The test
"posts the worked example: a registered buyer from a delivery note, an unregistered one straight
from an order" in `src/modules/sales/invoice.test.ts` enters these documents and fails if the
software ever posts anything else.

## The company

Lahore Bike Parts is registered for sales tax. Its prices are before sales tax: the tax is added
on top. Stock is valued at weighted-average cost, item by item, in its one warehouse.

Stock on hand before any sale:

| Item | Tax | In stock | Cost | Value |
| --- | --- | ---: | --- | ---: |
| HL-1 Helmet | standard, 18% | 10 | 600.00 each | 6,000.00 |
| CH-2 Chain | standard, 18% | 20 | 12 bought at 250.00, then 8 at 300.00 | 5,400.00 |

A chain therefore costs (3,000 + 2,400) / 20 = 270.00 on average.

Customers:

| Customer | Sales tax | Active Taxpayers List | Credit days |
| --- | --- | --- | ---: |
| Registered Dealer | registered | active | 30 |
| Walk-in Rider | not registered | (does not apply) | none |

## 1. Delivery note DN-2627-00001, 10 November 2026

Delivered to Registered Dealer against their sales order: 2 helmets and 5 chains. No invoice
yet, so no tax and nothing owed yet. The goods leave stock at their cost.

| Item | Quantity | Cost each | Cost |
| --- | ---: | ---: | ---: |
| Helmet | 2 | 600.00 | 1,200.00 |
| Chain | 5 | 270.00 | 1,350.00 |

| Account | Debit | Credit |
| --- | ---: | ---: |
| 5100 Cost of goods sold | 2,550.00 | |
| 1300 Stock in trade | | 2,550.00 |

## 2. Sales invoice SI-2627-00001, 12 November 2026

To Registered Dealer, made from the delivery note: it bills exactly what was delivered. The
chains carry a 5% discount. The buyer is registered and an active taxpayer, so there is no
further tax. The invoice falls due on 12 December 2026 (30 days).

| Item | Quantity | Price | Discount | Value before tax | Sales tax 18% | Further tax | Total |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Helmet | 2 | 1,000.00 | | 2,000.00 | 360.00 | 0.00 | 2,360.00 |
| Chain | 5 | 400.00 | 5% (100.00) | 1,900.00 | 342.00 | 0.00 | 2,242.00 |
| | | | | **3,900.00** | **702.00** | **0.00** | **4,602.00** |

| Account | Debit | Credit |
| --- | ---: | ---: |
| 1200 Trade receivables (Registered Dealer) | 4,602.00 | |
| 4100 Sales | | 3,900.00 |
| 2200 Sales tax payable (output tax) | | 702.00 |

Nothing leaves stock and no cost is posted here: the delivery note did both two days earlier.

## 3. Sales invoice SI-2627-00002, 13 November 2026

To Walk-in Rider, made straight from a sales order with no delivery note: the goods leave stock
with the invoice. The buyer is not registered, so 4% further tax is charged on the value before
tax (section 3(1A)). No credit days, so it is due the same day.

| Item | Quantity | Price | Value before tax | Sales tax 18% | Further tax 4% | Total |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Helmet | 1 | 1,000.00 | 1,000.00 | 180.00 | 40.00 | 1,220.00 |
| Chain | 3 | 400.00 | 1,200.00 | 216.00 | 48.00 | 1,464.00 |
| | | | **2,200.00** | **396.00** | **88.00** | **2,684.00** |

Cost of the goods: 1 helmet at 600.00 and 3 chains at 270.00 = 600.00 + 810.00 = 1,410.00.

| Account | Debit | Credit |
| --- | ---: | ---: |
| 1200 Trade receivables (Walk-in Rider) | 2,684.00 | |
| 4100 Sales | | 2,200.00 |
| 2200 Sales tax payable (output tax) | | 396.00 |
| 2205 Further tax payable | | 88.00 |
| 5100 Cost of goods sold | 1,410.00 | |
| 1300 Stock in trade | | 1,410.00 |

## Where it leaves the books

| | Figure |
| --- | ---: |
| Helmets in stock | 7, worth 4,200.00 |
| Chains in stock | 12, worth 3,240.00 |
| Stock in trade | 11,400.00 - 2,550.00 - 1,410.00 = 7,440.00 |
| Trade receivables | 4,602.00 + 2,684.00 = 7,286.00 |
| Sales | 3,900.00 + 2,200.00 = 6,100.00 |
| Cost of goods sold | 2,550.00 + 1,410.00 = 3,960.00 |
| Gross profit | 6,100.00 - 3,960.00 = 2,140.00 |
| Sales tax payable (output tax) | 702.00 + 396.00 = 1,098.00 |
| Further tax payable | 88.00 |

In the test, the opening stock is put into the warehouse without an entry in the books (the
app cannot receive stock yet), so the test's stock account shows only what left: 3,960.00
credit. Every other figure is as above.

## Two judgements, and why

1. **Cost of goods sold is posted on the day the goods are delivered (10 November), not the day
   they are invoiced (12 November).** Stock leaves the warehouse on the 10th, so the stock
   account must fall that day or it will not agree with a count. Both ways of working it out
   reached this. What to watch: a delivery in one month invoiced in the next shows its cost a
   month before its revenue, and a delivery that is never invoiced sits in cost of goods sold
   with no sale against it. A list of goods delivered and not invoiced is needed at each month
   end (noted in `docs/LATER.md` for the stock reports).
2. **Further tax has its own account (2205), apart from ordinary output tax (2200).** Input tax
   cannot be set against further tax, and the monthly return shows it on its own line. Kept in
   one account with output tax, the 88.00 would have to be dug out of the invoices each month.

## Questions this raised

Recorded in `docs/RATES-REVIEW.md` under "Questions for the accountant", numbers 8 to 11: the
date of supply when the invoice follows the delivery, whether bike parts sold in retail packing
fall under the Third Schedule, the buyer's status on the day of supply, and advance income tax
on sales to dealers.

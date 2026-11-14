# Step 21 worked example: credit notes and sales returns

Checked by Claude, not by an accountant (the founder has none; decided 2026-11-13). The expected
journals were worked out from standard double-entry practice, worked out a second time by an
independent reviewer who was given only the events below and the company's policies, not the
first answer or the software, and both were compared with what the software posts. All three
agree line for line, to the paisa, on every entry and every closing balance. The tests in
`src/modules/credit-notes/credit-notes.test.ts` enter these returns and fail if the software
ever posts anything else.

## The company

Lahore Bike Parts is registered for sales tax; its prices are before tax. The standard rate is
18%. A buyer who is not registered is also charged further tax of 4% (Sales Tax Act 1990,
section 3(1A)), kept in an account of its own. Stock is kept at weighted-average cost.

How it treats goods that come back (the founder's decisions, 2026-11-14, and the choices made
for him in `docs/later/step-21.md`):

- A credit note is made against one invoice and takes back part of it, line by line: the
  invoice line's own value and tax, in the proportion of the quantity. The last return of a
  line takes whatever is left of the line's figures.
- What it takes off the customer's account first settles whatever is still unpaid on its own
  invoice. Anything beyond that is the customer's **credit**, held in Advances from customers
  until it is set against another invoice.
- Goods fit to sell again go back into stock **at the cost they left at**. Damaged goods are
  **written off at once** to Stock adjustments; they never go back on the shelf.

What had happened before any goods came back:

| Date | Document | Customer | Lines | Total |
| --- | --- | --- | --- | ---: |
| 12 Oct | SI-2627-00001 | Registered Dealer (registered) | 2 helmets: 2,000 + 360 tax; 5 chains, 5% off: 1,900 + 342; 7 bolts, 5% off: 66.57 + 11.98 | 4,680.55 |
| 13 Oct | SI-2627-00002 | Walk-in Rider (not registered) | 1 helmet: 1,000 + 180 + 40 further tax; 3 chains: 1,200 + 216 + 48 | 2,684.00 |
| 14 Oct | cash receipt | Walk-in Rider | pays SI-2627-00002 in full | 2,684.00 |

What the goods cost when they left: a helmet 600; a chain 270 (the five on the first invoice
1,350); the seven bolts 35.04 in all.

## 1. A return on a paid invoice: all of it becomes the customer's credit

18 October: Walk-in Rider sends back the helmet of SI-2627-00002, fit to sell. The invoice is
paid, so nothing of it is left to settle.

| Account | Debit | Credit |
| --- | ---: | ---: |
| 4100 Sales | 1,000.00 | |
| 2200 Sales tax payable (output tax) | 180.00 | |
| 2205 Further tax payable | 40.00 | |
| 2130 Advances from customers (Walk-in Rider) | | 1,220.00 |
| 1300 Stock in trade | 600.00 | |
| 5100 Cost of goods sold | | 600.00 |

19 October: the rider buys 2 chains, SI-2627-00003: 800 + 144 + 32 = 976.00.

20 October: 976 of the credit is set against that invoice. An entry of its own, which only
moves the amount from advances to the customer's account:

| Account | Debit | Credit |
| --- | ---: | ---: |
| 2130 Advances from customers (Walk-in Rider) | 976.00 | |
| 1200 Trade receivables (Walk-in Rider) | | 976.00 |

244.00 of the credit is left. Asking for 300 more of it is refused.

## 2. A partial return, one of the goods damaged

20 October: Registered Dealer sends back 2 of the 5 chains of SI-2627-00001; one has a bent
link. Two fifths of what the line billed: 1,900 x 2/5 = 760.00, and 342 x 2/5 = 136.80 of tax.
Two fifths of what the five cost: 540.00, half of it for the chain that goes back on the shelf
and half for the one written off.

| Account | Debit | Credit |
| --- | ---: | ---: |
| 4100 Sales | 760.00 | |
| 2200 Sales tax payable (output tax) | 136.80 | |
| 1200 Trade receivables (Registered Dealer) | | 896.80 |
| 1300 Stock in trade | 270.00 | |
| 5110 Stock adjustments | 270.00 | |
| 5100 Cost of goods sold | | 540.00 |

SI-2627-00001 now has 4,680.55 - 896.80 = 3,783.75 unpaid.

## 3. The rest of the line; more than was invoiced is refused

21 October: the dealer asks to return 4 more chains. Refused: 5 were invoiced and 2 have come
back, so only 3 more can. The 3 come back, all fit to sell. They take what is left of the line:
1,900 - 760 = 1,140.00 and 342 - 136.80 = 205.20; cost 810.00.

| Account | Debit | Credit |
| --- | ---: | ---: |
| 4100 Sales | 1,140.00 | |
| 2200 Sales tax payable (output tax) | 205.20 | |
| 1200 Trade receivables (Registered Dealer) | | 1,345.20 |
| 1300 Stock in trade | 810.00 | |
| 5100 Cost of goods sold | | 810.00 |

SI-2627-00001 has 2,438.55 unpaid.

## 4. To the paisa

22 October: the 7 bolts (66.57 + 11.98 of tax) come back on three credit notes, 2, 2 and 3.

| Credit note | Bolts | Value | Sales tax | How |
| --- | ---: | ---: | ---: | --- |
| first | 2 | 19.02 | 3.42 | 66.57 x 2/7 = 19.02; 11.98 x 2/7 = 3.4229 |
| second | 2 | 19.02 | 3.42 | the same |
| third | 3 | 28.53 | 5.14 | what is left: 66.57 - 38.04; 11.98 - 6.84 |
| | 7 | 66.57 | 11.98 | exactly what the line billed |

Three sevenths of the tax would be 5.13, a paisa short. The third credit note had been saved
as a draft before the other two were posted, when 5.13 was right; posting it then is refused,
and it is saved again at 5.14. SI-2627-00001 has 2,360.00 unpaid: the two helmets.

## 5. A part-paid invoice: some settles the invoice, the rest is credit

23 October: Registered Dealer pays 2,000 in cash against SI-2627-00001. 360.00 is still unpaid.

24 October: one of the two helmets comes back cracked. 1,000 + 180 = 1,180: 360 settles the
invoice and 820 is the dealer's credit. The helmet cost 600 and is written off.

| Account | Debit | Credit |
| --- | ---: | ---: |
| 4100 Sales | 1,000.00 | |
| 2200 Sales tax payable (output tax) | 180.00 | |
| 1200 Trade receivables (Registered Dealer) | | 360.00 |
| 2130 Advances from customers (Registered Dealer) | | 820.00 |
| 5110 Stock adjustments | 600.00 | |
| 5100 Cost of goods sold | | 600.00 |

## Where it stands

| Invoice | Still unpaid |
| --- | ---: |
| SI-2627-00001 | nil |
| SI-2627-00002 | nil |
| SI-2627-00003 | nil |

| Account | Registered Dealer | Walk-in Rider |
| --- | ---: | ---: |
| 1200 Trade receivables | nil | nil |
| 2130 Advances from customers | 820.00 credit | 244.00 credit |

What each customer's account stands at in the books is exactly what their unpaid invoices come
to, and the goods on hand are what their moves add up to. The tests check both after every
scenario.

## Judgements, and why

1. **A return is debited to Sales**, not to a sales-returns account of its own: the chart has
   none. The independent reviewer's caution is fair: how much comes back is then not visible
   as a figure in the accounts. It is visible as the list of credit notes, and can be a report.
2. **Goods come back at the cost they left at**, and the warehouse's average cost is worked
   out afresh from what it then holds, as for any goods coming in.
3. **A return's cost is its share of what the line's goods cost, rounded to the paisa.** Over
   several part returns of one line the costs taken back can differ from the cost that left by
   a paisa. The stock and its account still agree with each other exactly.
4. **Damaged goods are written off in full at once** (the founder's decision). The reviewer
   notes that goods with some salvage value would be carried at that value under IAS 2, and
   that a loss recoverable from a carrier or a supplier is not tracked. The reason is typed on
   the credit note.
5. **Credit left over is kept with advances from customers**, apart from the receivable, until
   it is set against an invoice. Until then a customer can show as owing on one invoice while
   in credit on another; the customer's balance against the credit limit counts both.
6. **The last return of a line takes what is left**, so one credit note's tax can be a paisa
   away from 18% of its own value (5.14 on 28.53 above). The credit notes of a line together
   are exactly the line.

## Questions this raised (for a tax adviser; not decided here)

These come from the independent reviewer's reading of the Sales Tax Act 1990, section 9, and
the Sales Tax Rules 2006 (the rules on debit and credit notes). The reviewer was not sure of
every rule number, and nobody here has checked them against the text.

- **A registered buyer's debit note.** The rules are understood to require the buyer to issue
  a debit note for a return and reverse the input tax. The credit note has a place for the
  customer's debit note number; the software does not insist on it.
- **180 days.** The supplier's reduction of output tax through a credit note is understood to
  be allowed only within 180 days of the supply (longer with the Commissioner's leave). The
  software posts a credit note for an invoice of any age and brings output tax down. A credit
  note for an invoice older than that should be shown to a tax adviser before the month's
  return is filed.
- **Input tax on goods written off.** Output tax rightly comes down when a sale is taken
  back. Whether input tax claimed on goods that are then destroyed can stand is a question for
  the adviser.
- **Further tax on a return by an unregistered buyer** comes down with the sale it was
  charged on. Whether the monthly return has a place to show that is to be confirmed when the
  return is built.

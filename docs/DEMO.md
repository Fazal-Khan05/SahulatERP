# The demo, in ten minutes

For showing SahulatERP to an importer who works out commission by hand today.

## Before the meeting

- The demo company is **Shaheen Bike Parts (Demo)**, an invented motorcycle-parts importer
  with a branch in Karachi and one in Lahore. Every name in it is made up.
- It is made by `npm run demo:seed` (and removed by `npm run demo:reset`). The seed writes the
  four logins and their passwords into `.env.demo-accounts.local` in the working copy. Open that
  file to read them; never paste them anywhere.
- **Log in as the owner** (`DEMO_OWNER_EMAIL`) for the walk below. The sales manager
  (`DEMO_MANAGER_…`, Imran) and the salespeople (`DEMO_ALI_…`, `DEMO_SANA_…`) show what a
  member of the team sees, if they ask.
- The company has two months of trading: last month and this month so far.

## The walk (about ten minutes)

1. **Needs attention** (1 minute). Start where the owner starts each morning: what is waiting.
   Say: "One list of what needs you today, instead of checking five registers."

2. **Sales → an invoice** (2 minutes). Open *Sales*, then *Sales invoices*, and open one made
   from a delivery note. Show:
   - the customer, the lines and the total, and **In the books**: the receivable, the sale, and
     the cost of the goods that left stock, posted the moment the invoice was posted;
   - **Print** and **Download PDF**: the invoice on the company's letterhead, total in words;
   - **What happened**: who wrote it, when it was posted, the order it came from.
   Say: "Nobody types a journal. The invoice puts itself into the books."
   If they ask about returns: *Sales*, *Credit notes* has one, five brake shoes sent back (one
   damaged); it took the goods back into stock and the amount off what the customer owes.

3. **Commissions** (2 minutes). Open *Commissions*. Show the plans:
   - a standard plan with a higher rate on lighting and a lower one on tyres;
   - Ali on slabs: 2% up to 3 lakh of sales in the month, 3% above it;
   - Sana with a monthly target: from the sale that reaches 1.5 lakh, her commission is 1.5×;
   - Imran, the manager, earns 0.5% of what his team sells; *Who reports to whom* shows Ali
     and Sana under him.
   Say: "This is the sheet you keep by hand every month. Here it is set once, and the app works
   it out on every invoice." (The amounts each person has earned appear once commission
   accrual is switched on; see "What is not in the demo yet".)

4. **Collections** (2 minutes). Open *Collections*.
   - **Overdue customers**: who owes what past its due date, most overdue first.
   - Open the customer whose **cheque bounced**: the invoice is unpaid again, there is a
     follow-up note ("they will pay by bank transfer next week") and a **promise to pay**.
   - **Customer statements**: the running balance for the customer, from the books, ready to
     print or save as a PDF.
   - **Cheques**: one cheque still in hand, one cleared, one bounced.
   - **Aged receivables**: the same overdue amounts, by how late they are.
   Say: "Your recovery officer works from this list; the overdue list and the ageing always
   agree, because they come from the same place."

5. **Stock** (2 minutes). Open *Stock* for what each warehouse holds, then *Reports*:
   - **Stock valuation**: the stock is worth exactly what the stock account in the books says;
   - **Item profit**: what each part sold for, what it cost, and the margin;
   - **Low stock**: parts at or below their reorder level, after what open orders still need.
   Say: "The stock report and the books cannot drift apart; there is one source for both."

6. **Close** (1 minute). Back to *Needs attention*. Ask what they spend most time on each
   month; most will say commission and chasing payments, which is where to go deeper.

## If they ask

- **Can a salesperson see other people's sales or costs?** No. Log in as Ali: his own
  customers and orders only, no costs, no commission plans.
- **Can the price list be by customer type?** Yes: price lists, class prices and customer
  prices are set under *Price lists*.
- **Does it file with FBR?** Not in this version.

## What is not in the demo yet

- **Commission earned and paid** (accrual on invoices, release on collection, statements per
  salesperson) arrives with Steps 38 and 39. Once Step 38 is live, the demo company is made
  again, so the commission is earned by the real posting.
- **Email** of invoices and statements waits for an email service to be chosen; for now the
  PDF is downloaded and sent by hand.
- **Purchases and imports** are not built yet: stock came in as opening stock.

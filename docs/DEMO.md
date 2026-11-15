# The demo, in ten minutes

For showing SahulatERP to an importer who works out commission by hand today.

## Opening it on this Mac

The demo runs from the Finisher's working copy on this Mac, against the test database (dev2),
not the live site: commission (Steps 38 and 39) is not on the live site yet.

1. Open Terminal and run this one command. Leave the window open while you show the demo.

   ```bash
   cd /Users/fazalkhan/Desktop/ERP/.claude/worktrees/magical-blackwell-79cd67 && npm run start -- --port 3001
   ```

2. When it says **Ready**, open <http://localhost:3001> in the browser.
3. The logins and their passwords are in
   `/Users/fazalkhan/Desktop/ERP/.claude/worktrees/magical-blackwell-79cd67/.env.demo-accounts.local`.
   Open that file to read them; never paste them anywhere.
4. To stop it afterwards, press Ctrl+C in that Terminal window.

The build is already made. If the command says it cannot find a build, run `npm run build` in
the same folder first (two minutes), then the command again.

## The company

- **Shaheen Bike Parts (Demo)**, an invented motorcycle-parts importer with a branch in
  Karachi and one in Lahore. Every name in it is made up.
- Two months of trading: last month and this month so far.
- **Log in as the owner** (`DEMO_OWNER_EMAIL`) for the walk. The sales manager
  (`DEMO_MANAGER_…`, Imran) and the salespeople (`DEMO_ALI_…`, `DEMO_SANA_…`) show what a
  member of the team sees, if they ask.
- It is made by `npm run demo:seed` and removed by `npm run demo:reset`, in the working copy
  above. The seed writes the four logins into the file above.

## The walk (about ten minutes)

1. **Needs attention** (1 minute). Start where the owner starts each morning: what is waiting.
   Say: "One list of what needs you today, instead of checking five registers."

2. **Sales → an invoice** (1½ minutes). Open *Sales*, then *Sales invoices*, and open
   **SI-2627-00004**. Show:
   - the customer, the lines and the total, and **In the books**: the receivable, the sale,
     the cost of the goods that left stock, and the commission, posted the moment the invoice
     was posted;
   - **Print** and **Download PDF**: the invoice on the company's letterhead, total in words;
   - **What happened**: who wrote it, when it was posted, the order it came from.
   Say: "Nobody types a journal. The invoice puts itself into the books." Stay on this invoice:
   step 5 starts here.

3. **Collections** (1½ minutes). Open *Collections*.
   - **Overdue customers**: who owes what past its due date, most overdue first.
   - Open the customer whose **cheque bounced**: the invoice is unpaid again, there is a
     follow-up note ("they will pay by bank transfer next week") and a **promise to pay**.
   - **Customer statements**: the running balance for the customer, ready to print or save.
   - **Cheques**: one cheque still in hand, one cleared, one bounced.
   Say: "Your recovery officer works from this list; the overdue list and the ageing always
   agree, because they come from the same place."

4. **Stock** (1 minute). Open *Reports*:
   - **Stock valuation**: the stock is worth exactly what the stock account in the books says;
   - **Item profit**: what each part sold for, what it cost, and the margin, returns taken off.
   Say: "The stock report and the books cannot drift apart; there is one source for both."

5. **Commission** (4 minutes). This is the part they do by hand today.
   1. **The plans.** Open *Commissions*: a standard plan with a higher rate on lighting and a
      lower one on tyres; Ali on slabs (2% up to 3 lakh of sales in the month, 3% above it);
      Sana with a monthly target (from the sale that reaches 1.5 lakh, 1.5×); Imran, the
      manager, earning 0.5% of what his team sells. *Who reports to whom*: Ali and Sana under
      Imran. Say: "This is the sheet you keep by hand. Here it is set once."
   2. **An invoice's commission.** Back on **SI-2627-00004**, split 60/40 between Ali and
      Sana: the card **Commission on this invoice** shows what each earned on their share, and
      Imran's 0.5% on each as their manager, and how much the customer's money has released.
      Say: "Worked out on every invoice, the moment it is posted."
   3. **Earned and released.** Open *Reports*, *Commission earned*: for each person, what is
      earned, what is still waiting for the customers to pay, what their payments have
      released, what has been paid and what is owed back. Commission is released as the
      customer pays, a cheque only when it clears; a bounced cheque releases nothing.
   4. **A statement.** Click **demo-ali** in the table, then **demo-ali…'s statement** above
      it, and choose **Last month**: 12,308.40 earned on his October sales, 1,976.00 released
      when Faisal Motors paid in cash. Then **This month**: that 1,976.00 paid on the 1st
      (**CP-2627-00001**); more released as November's money came in; then five brake shoes
      came back from a sale he had already been paid on (**CN-2627-00001**), so 45.00 of his
      commission is taken back, and comes off his next payment. 3,501.40 is owed to him at the
      end. **Print** or **Download PDF** to hand it to him.
      Say: "Every salesperson gets this each month, and it always agrees with the books."
   5. **A payment.** Back on *Commission earned*, Ali: tick what this month's money has
      released, **Approve the ticked for payment**, then **Pay commission**: the 45.00 he owes
      back from the return comes off first, and 3,501.40 is paid from cash, with its journal.
      The payment appears under **Payments** at the bottom as CP-2627-00002. (The "paid"
      message above the button does not show yet; the Builder is fixing it. This really pays
      it in the demo company; to show it again, the demo is made afresh.)

6. **Close** (1 minute). Back to *Needs attention*. Ask what they spend most time on each
   month; most will say commission and chasing payments, which is where to go deeper.

## If they ask

- **Can a salesperson see other people's commission?** No. Log in as Ali: *My commission*
  and *My statement* show his own only. Log in as Imran: his own and his team's (Ali's and
  Sana's), but nobody else's. The owner and an accountant see everyone's, and only they
  approve and pay.
- **Can a salesperson see costs?** No: his own customers and orders, no costs.
- **Can the price list be by customer type?** Yes: price lists, class prices and customer
  prices are set under *Price lists*.
- **Does it file with FBR?** Not in this version.

## What is not in the demo yet

- **Email** of invoices and statements waits for an email service to be chosen; for now the
  PDF is downloaded and sent by hand.
- **Purchases and imports** are not built yet: stock came in as opening stock.
- **Payroll**: commission is paid on its own; paying it with the salary comes with payroll.

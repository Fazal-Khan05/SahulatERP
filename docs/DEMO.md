# The demo company

For showing SahulatERP to an importer who works out commission by hand today, and for seeing
every feature that is built with something real on its screen.

## Opening it

**On the live site** (<https://sahulaterp.vercel.app>), once the demo company has been seeded
there. Seeding it afresh removes the old demo company and its sign-ins first, so it is done only
with the founder's yes to the two commands, from the working copy whose `.env.local` points at
that database:

```bash
npm run demo:reset
```

```bash
npm run demo:seed
```

The sign-ins and their passwords are then in `.env.demo-accounts.local` in that working copy.
Open that file to read them; never paste them anywhere. The seed prints what it made and, at
the end, that the books agree; it stops with an error instead if they do not.

**On this Mac, against a database of its own** (`npm run db:local -- <a name>` prints the two
addresses to put in front of the commands): the same two commands. Seeded this way the demo
gets sign-ins of its own (`demo-...@demo-local.sahulaterp.test`) and a passwords file of its own
(`.env.demo-accounts-localdb.local`), so trying it here never touches the live demo's sign-ins.

The numbers below (SI-2627-00004, CP-2627-00001 and the amounts) are those of a demo company
seeded on 26 November 2026. Seeded in the middle of another month they should come out the same,
with "last month" and "this month" moved; seeded in the first days of a month, this month's
dates are squeezed up to yesterday and the figures can differ, so check them before the meeting
(the seed prints them under "For docs/DEMO.md").

## The company

- **Shaheen Bike Parts (Demo)**, an invented motorcycle-parts importer with a branch in
  Karachi and one in Lahore. Every name in it is made up: people, customers, suppliers, banks'
  references and numbers.
- Two months of trading: last month and this month so far. Every module that is built is
  switched on. It is not registered for sales tax, as the first customer is not.
- It is made by `npm run demo:seed` through the app's own commands, exactly as people would
  through the screens, and removed by `npm run demo:reset`.
- **Nine sign-ins**, one for each role. In the passwords file each has two lines,
  `DEMO_<NAME>_EMAIL` and `DEMO_<NAME>_PASSWORD`:

  | Name in the file | Who | What they see |
  | --- | --- | --- |
  | `OWNER` | The owner | Everything. Use this one for the walk. |
  | `ACCOUNTANT` | Nadia, the accountant | The books, bills and payments, cash and bank, payroll approval, reports |
  | `MANAGER` | Imran, the sales manager | Sales, customers, prices, collections, his own and his team's commission |
  | `ALI` | Ali, a salesperson | His customers, his orders, his own commission |
  | `SANA` | Sana, a salesperson | The same, for hers |
  | `RECOVERY` | Kamran, the recovery officer | Cheques, overdue customers, follow-ups, receipts, statements |
  | `WAREHOUSE` | Bilal, the warehouse manager | Receiving goods, deliveries, transfers, stock and counts; never a cost |
  | `PAYROLL` | Hina, the payroll administrator | Employees, payroll runs, payslips; nothing else |
  | `AUDITOR` | The auditor | Reads everything, changes nothing |

## The walk (about ten minutes)

1. **Needs attention** (1 minute). Start where the owner starts each morning: what is waiting.
   Three things are: an order over its customer's credit limit to approve, a cheque to deposit,
   and a stock count to post.
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
   - **Cheques**: one cheque still in hand; tick *Show cleared, bounced and cancelled cheques
     too* for the one that cleared and the one that bounced.
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
      The card then says what was paid, and the payment appears under **Payments** at the
      bottom as CP-2627-00002. (This really pays it in the demo company; to show it again, the
      demo is made afresh.) Sana's commission is not paid this way: she is on the payroll with
      her sign-in, so what is approved for her is paid with her salary (*Payroll*, *Payroll
      runs*, PR-2627-00001 shows 928.00 of it).

6. **Close** (1 minute). Back to *Needs attention*. Ask what they spend most time on each
   month; most will say commission and chasing payments, which is where to go deeper.

## Every feature, and where to see it

Each line was checked by opening the screen in the browser, as that sign-in, against a company
seeded on 26 November 2026: the number or figure it names was on the screen. The menu's words
are the owner's unless another sign-in is named.

### Start

| Sign in as | Click | On the screen |
| --- | --- | --- |
| Owner | Home | The business this month: cash and bank 27,45,256.00, sales 10,55,792.00, profit 96,070.83, customers owe 16,23,150.00, owed to suppliers 5,78,222.00 |
| Owner | Needs attention | Three things waiting: an order over its credit limit to approve, a cheque to deposit, a stock count to post |

### Selling

| Sign in as | Click | On the screen |
| --- | --- | --- |
| Owner | Sales, Quotations | Two quotations waiting for the customer and one the customer turned down (Cancelled) |
| Owner | Sales, Sales orders | Twenty-eight orders, SO-2627-00001 to 00028, and one waiting for approval; SO-2627-00025 is the one that was short of stock |
| Owner | Needs attention, the sales order for Orangi Auto Corner | An order over the customer's credit limit, written by Ali, waiting for the owner: approve it with a reason, or send it back |
| Owner | Sales, Delivery notes | Delivery notes DN-2627-00001 to 00014, and one draft that is short of stock |
| Owner | Sales, Sales invoices | Twenty-four invoices, SI-2627-00001 to 00024 |
| Owner | Sales, Sales invoices, SI-2627-00004 | An invoice split 60/40 between Ali and Sana: its lines, In the books, Commission on this invoice, Print and Download PDF |
| Owner | Sales, Credit notes | CN-2627-00001: five brake shoes returned, one written off as damaged |
| Owner | Sales, Sales invoices, SI-2627-00023 | A counter sale to a walk-in buyer, Usman Tariq, paid in cash as he bought: 5,280.00 |
| Owner | Sales, Sales invoices, New counter sale | New counter sale: the one screen that sells, bills and takes the money in one step |
| Owner | Customers | Eleven customers in three classes, and the walk-in customer of counter sales |
| Owner | Price lists | Two lists: Dealer price list (the default, 3 prices) and Eid offer |
| Owner | Price lists, Dealer price list | Its prices for BR-130, AC-510 and TY-420 |

### A delivery short of stock

| Sign in as | Click | On the screen |
| --- | --- | --- |
| Owner | Sales, Sales invoices, SI-2627-00022 | Fifty LED headlights for Saddar Cycle House; Karachi held 37, so 13 were bought in the market first |
| Owner | Purchases, PO-2627-00007 | The quick market purchase: 13 LED headlights from Ejaz Lighting, Bolton Market, paid in cash, 35,750.00 |
| Owner | Sales, Delivery notes, the draft for Rehman Autos | A delivery left short: 30 carburettors needed, 21 in stock, 9 short, with the button Buy the missing goods from the market |

### Collections

| Sign in as | Click | On the screen |
| --- | --- | --- |
| Owner | Collections (it opens on Overdue customers) | Customers past their due dates, most overdue first; Gujranwala Parts Centre heads it with an invoice from before the books were opened |
| Owner | Collections, Follow-ups and promises | Model Town Motors to call today; Anarkali Auto Store promised 48,700.00 |
| Owner | Collections, Overdue customers, Anarkali Auto Store | The customer whose cheque bounced: what they owe, the follow-up note and the promise to pay |
| Owner | Collections, Customer statements | A statement for any customer and period, to print or save |
| Owner | Collections, Aged receivables | What each customer owes by age; the total, 16,23,150.00, is set beside Trade receivables in the books, with a difference of 0.00 |
| Owner | Collections, Receipts | Twelve receipts, RC-2627-00001 to 00012: cash, bank transfers, cheques and one advance |
| Owner | Collections, Cheques | Cheque 00117345 from Korangi Workshop, 38,400.00, still in hand; tick Show cleared, bounced and cancelled cheques too for the one that cleared and the one that bounced |

### Buying

| Sign in as | Click | On the screen |
| --- | --- | --- |
| Owner | Purchases and imports | Purchase orders PO-2627-00001 to 00007: received, received in part, cancelled, and one still a draft |
| Owner | Purchases and imports, PO-2627-00002 | Tyres from Ravi Tyre Traders: 40 of 60 have arrived, 20 are still to come |
| Owner | Purchases and imports, Receive goods | The orders with goods still to arrive: PO-2627-00002 and PO-2627-00004 |
| Owner | Purchases and imports, PO-2627-00004, its goods received note GR-2627-00004 | A goods received note: 25 front tyres into Lahore, not billed yet |
| Owner | Purchases and imports, Supplier bills | Seven bills, PB-2627-00001 to 00007; PB-2627-00002 is unpaid and overdue, PB-2627-00003 is half paid |
| Owner | Purchases and imports, Supplier bills, PB-2627-00003 | A bill for goods with income tax withheld from it, part paid, and four helmets returned against it |
| Owner | Purchases and imports, Supplier bills, PB-2627-00004 | A bill for a service: guards, with Sindh's sales tax on services and income tax withheld |
| Owner | Purchases and imports, Supplier payments | Five payments to suppliers, PV-2627-00001 to 00005 |
| Owner | Purchases and imports, Supplier payments, PV-2627-00003 | An advance of 2,50,000.00 sent to Guangzhou (noted as USD 897.99), later set against their bill |
| Owner | Purchases and imports, Supplier returns | DB-2627-00001: four helmets with cracked shells sent back to Indus Auto Parts |
| Owner | Purchases and imports, Withholding tax | Everything withheld and not yet paid over, 25,221.00 in all, and the challans: WC-2627-00001 for last month's tax withheld from suppliers, WC-2627-00002 for the 320.00 deducted from October's salaries |
| Owner | Reports, Goods received, not yet billed | 25 front tyres received and not billed: 71,250.00, the same as the account in the books |
| Owner | Purchases and imports, Quick market purchase | The one screen that buys, receives, bills and pays in one step |
| Owner | Suppliers | Five suppliers and the market seller that stands for sellers not on the list |

### Imports

| Sign in as | Click | On the screen |
| --- | --- | --- |
| Owner | Purchases and imports, Shipments | SH-2627-00001 from Guangzhou, closed, with what is in transit |
| Owner | Purchases and imports, Shipments, SH-2627-00001 | The shipment from Guangzhou, closed: how far it came, its goods, and the freight, duty and handling added to what they cost, the deposit and the agent's fee kept apart |

### Stock

| Sign in as | Click | On the screen |
| --- | --- | --- |
| Owner | Stock | What each warehouse holds of each item: Karachi, Lahore and the shop counter |
| Owner | Stock, Transfers | ST-2627-00001: five items moved from the Karachi warehouse to the shop counter |
| Owner | Stock, Adjustments and opening stock | The opening stock of both warehouses and SA-2627-00003, two tail lights written off as damaged |
| Owner | Stock, Stock counts | SC-2627-00001, Lahore's count, posted; the shop counter's count, finished and waiting to be posted |
| Owner | Needs attention, the stock count of Karachi shop counter | The count sheet: five items counted, one handle grip pair short; Post or send back |
| Owner | Items | Thirty parts in five categories with their prices and reorder levels |
| Owner | Reports, Low stock | The LED headlight and the carburettor are below their reorder levels |
| Owner | Reports, Stock valuation | Stock worth 43,53,814.80, the same as the stock account in the books |
| Owner | Reports, Stock movement | What came in and went out of each item over the period |
| Owner | Reports, Stock ageing | How long each item has been held |
| Owner | Reports, Item profit | What each part sold for, what it cost, and the margin, returns taken off |

### Cash and bank

| Sign in as | Click | On the screen |
| --- | --- | --- |
| Owner | Daily expenses | Today's three expenses, 4,650.00 spent today, and the earlier days each with its total |
| Owner | Daily expenses, Upload a sheet of expenses | The template to download and the names to use in it |
| Owner | Cash and bank | Cash in hand, Petty cash and the Meezan Bank account, each with what it holds |
| Owner | Cash and bank, Transfers | TR-2627-00001 to 00003: petty cash topped up twice from the bank, and cash banked |
| Owner | Cash and bank, Expenses | Every expense, the daily ones among them, EX-2627-00001 to 00032 |
| Owner | Cash and bank, Expenses, EX-2627-00031 | An expense on the full form: two lines paid to Shahrah Printers from the bank, with its journal and the place to add a receipt |
| Owner | Cash and bank, Reconcile, Meezan Bank current account | The bank's statement matched with the books: 25 lines matched, one deposit only the bank knows of, two cheques not yet presented |

### Commission

| Sign in as | Click | On the screen |
| --- | --- | --- |
| Owner | Commissions | The four plans and who reports to whom |
| Owner | Reports, Commission earned | What each person earned, what is released, paid and owed back; approve and pay here |
| Owner | Reports, Commission statements, demo-ali | Ali's statement: CP-2627-00001 paid on the 1st, 45.00 taken back for CN-2627-00001, 3,501.40 owed to him |

### Payroll

| Sign in as | Click | On the screen |
| --- | --- | --- |
| Owner | Payroll | Five employees, four paid by the month and one by the day |
| Owner | Payroll, Ali Raza | One employee: his pay, and the loan he is paying back |
| Owner | Payroll, Attendance | The days the daily-paid helper worked, entered from a file |
| Owner | Payroll, Payroll runs | Last month's run PR-2627-00001, paid; this month's, a draft |
| Owner | Payroll, Payroll runs, PR-2627-00001 | The run: each person's pay, tax, EOBI, Ali's loan instalment, Sana's commission paid with her salary, 2,34,773.00 to the staff, and its journal |
| Owner | Payroll, Payslips | Each person's payslip for a month, to print or download |
| Owner | Payroll, Loans | SL-2627-00001: 60,000.00 lent to Ali Raza, what has come back and what is still owed |
| Owner | Payroll, Year's statement | The year's pay and the income tax deducted for each person (s.149) |
| Owner | Payroll, Statutory rates | The salary tax slabs, EOBI and the other rates the runs use |

### The books

| Sign in as | Click | On the screen |
| --- | --- | --- |
| Owner | Journals | Journals written by hand: JV-2627-00001 the owner's capital, 00002 depreciation, 00003 entered and reversed, and one draft |
| Owner | Reports, Trial balance | Every account; both sides come to 1,34,54,874.75 |
| Owner | Reports, General ledger | Any account's entries, one by one |
| Owner | Reports, Balance sheet | What the company owns and owes today |
| Owner | Reports, Profit and loss | Sales, cost of the goods sold and the expenses for the period |
| Owner | Reports, Cash flow | Where the money came from and went |
| Owner | Reports, Aged payables | What is owed to each supplier by age; the total, 5,78,222.00, is what the books say |
| Owner | Reports, Supplier statement | A statement for any supplier and period |
| Owner | Reports, Withholding register | Tax withheld from suppliers, bill by bill, and the 320.00 of income tax deducted from October's salaries in a section of its own, each with the challan that paid it; 25,221.00 is still to be paid, the same as the accounts in the books |
| Owner | Reports, Statement of tax withheld (section 165) | The quarter's income tax withheld, payee by payee, with the challan's number |
| Owner | Reports, Sales tax return | One sentence: the company is not registered for sales tax, so it files no return |

### Settings

| Sign in as | Click | On the screen |
| --- | --- | --- |
| Owner | Settings | The company's name and letterhead |
| Owner | Settings, Modules | Every module switched on except FBR filing, which is not built |
| Owner | Settings, Currencies | Rupees as the base currency, and the dollar and yuan rates kept for the record |
| Owner | Settings, Tax | The sales tax categories and the withholding rates, each with its date and law |
| Owner | Settings, Accounts | The chart of accounts |
| Owner | Settings, Opening balances | What the company held and owed when it started here, posted: INV-0388 owed by a customer, RTT-INV-2101 owed to a supplier |
| Owner | Settings, Fiscal periods | The year's months; September 2026 is locked |
| Owner | Settings, Branches | Karachi and Lahore, and their warehouses |
| Owner | Settings, Members | The nine sign-ins and their roles |
| Owner | Settings, Activity | Who did what and when: every command leaves a line |
| Owner | Settings, Sign-ins | Who signed in, when, and from what device |
| Owner | Settings, Files | Empty: see what the demo cannot show |

### Other sign-ins

| Sign in as | Click | On the screen |
| --- | --- | --- |
| Accountant | Home | The accountant's own menu: Bills and payments, Daily expenses, Bank and cash, Chart of accounts, Journals, Payroll, Reports |
| Accountant | Bills and payments | The supplier bills, with New supplier bill and Quick market purchase |
| Payroll administrator | Payroll runs | The runs, which the payroll administrator works out and reviews; she does not approve or pay them |
| Payroll administrator | (typing /sales in the address bar) | Nothing of sales: the screen says her role does not include sales documents |
| Warehouse manager | Receive goods | The orders with goods still to arrive, by quantity: no cost is shown to the warehouse |
| Warehouse manager | Deliveries, the draft for Rehman Autos | The same short delivery as the warehouse sees it: quantities only, and who can buy the missing goods |
| Warehouse manager | Stock count | The counts, and Start a count |
| Recovery officer | Cheques | The cheques in hand, cleared and bounced |
| Recovery officer | Overdue customers | Who to chase, most overdue first |
| Auditor | Daily expenses | The auditor reads the lists and totals; there is no form to add anything |
| Auditor | Settings, Activity | Everything every member did |
| Sales manager | Commissions, earned | Imran sees his own commission and his team's, Ali's and Sana's |
| Salesperson (Ali) | My commission | Ali sees his own commission only |
| Salesperson (Ali) | Orders | His own orders and customers, with no costs |

## What the demo cannot honestly show

- **Sales tax.** The company is not registered, so there is no sales tax on its invoices, no
  input tax on its bills, no sales tax withheld, none paid at import, and the sales tax return
  is one sentence. A second, registered company would be needed to show these.
- **Filing with FBR.** Not built.
- **A receipt kept with an expense, and Settings, Files.** A file is stored by the person
  signed in, so the seed cannot keep one. Add one live: *Daily expenses*, any expense, *Add a
  receipt*; it then shows there and under *Settings*, *Files*.
- **A transfer from Karachi to Lahore.** A transfer stays inside one branch for now, so the
  demo's transfer is from the Karachi warehouse to the Karachi shop counter.
- **Money given back to a customer or a supplier, and a debt written off.** Not built.
- **A broken promise to pay.** A promise is always made for today or later. Anarkali Auto
  Store's, for 3 December 2026, shows as broken by itself after that day if nothing arrives.
- **Employees' bank accounts and the bank's file of salaries.** Left empty, so that no number
  that could be a real account is invented.
- **Period close.** The accountant's menu names it; it is not built.
- **Emailing an invoice or a statement.** Not there; the PDF is downloaded and sent by hand.
- **Importing customers, suppliers, items or attendance from a file.** The screens are there
  (*Customers*, *Import*, and so on) and show nothing until a file is chosen.
- **Two-step sign-in.** Switched off on the live site for the demo; it is switched back on
  before real customers.

## If they ask

- **Can a salesperson see other people's commission?** No. Log in as Ali: *My commission*
  and *My statement* show his own only. Log in as Imran: his own and his team's (Ali's and
  Sana's), but nobody else's. The owner and an accountant see everyone's, and only they
  approve and pay.
- **Can a salesperson see costs?** No: his own customers and orders, no costs.
- **Can the price list be by customer type?** Yes: price lists, class prices and customer
  prices are set under *Price lists*.
- **Does it file with FBR?** Not in this version.
- **What happens when we are short of stock?** Stock never goes below zero. The delivery says
  how many are short, and the owner or an accountant buys them with *Quick market purchase*,
  which brings them into stock at what they cost; the delivery then goes through.
- **Can the warehouse see what things cost?** No. Sign in as the warehouse manager: quantities
  only, on every screen.

# The fuller demo company (after Daily expenses; not a numbered step of the plan)

The founder signed in to the demo of 15 November on 2026-11-26, found it thin (a trading
bundle, nothing after Step 23), and asked: "rebuild the demo company with everything switched
on", then: "i want you to show me every feature in the demo company".

## What the seed makes now

`npm run demo:seed` (scripts/demo) still builds everything through the app's own commands,
called as the screens call them; nothing writes a document, a stock move or a journal itself.
The first two months of selling, collecting and commission are exactly as before, in the same
order, so the walk's numbers did not move. After them, each in a file of its own under
`scripts/demo/parts`:

- **buying.ts**: five suppliers; purchase orders received in full, in part, cancelled and left
  as a draft; bills with income tax withheld (one overdue, one half paid), a service bill with
  the province's tax withheld; payments, an advance abroad noted in dollars; four helmets sent
  back; last month's withheld tax paid over with its challan; one import shipment from
  Guangzhou with freight, duty and handling spread over the goods, a deposit and the agent's
  fee kept apart.
- **money.ts**: opening balances (with an unpaid invoice and an unpaid bill from before);
  the owner's capital paid into the bank; petty cash; transfers; thirty daily expenses over the
  two months, three of them today; one expense on the full form; journals by hand, one reversed
  and one left as a draft; the month before the books were opened, locked.
- **stock.ts**: a second Karachi warehouse (the shop counter) and a transfer to it; two tail
  lights written off; Lahore's count posted with small differences; the shop's count finished
  and waiting.
- **selling-more.ts**: the owner's own larger sales with no commission; two price lists, a
  class price and a customer's price; an order held for the owner's approval; a quotation
  cancelled; an order delivered in part; a delivery short of stock finished with a quick market
  purchase, and another left short; two counter sales; a bank receipt with the bank's charges,
  and an advance from a customer.
- **payroll.ts**: five employees; last month's run approved and paid, this month's a draft; a
  loan with its instalment and a repayment in cash; Sana's commission paid with her salary.
- **reconcile.ts**: the bank's statement for the two months, made from the bank account's real
  entries, imported and matched; two entries left as not yet presented, one deposit only the
  bank knows of, the bank's charges matched by hand.
- **checks.ts**: the seed does not call itself done unless the trial balance balances, the
  stock valuation equals the stock account, aged receivables equal the receivables account,
  aged payables equal the payables accounts and goods received not billed equal theirs. It then
  prints the numbers and figures docs/DEMO.md quotes.

Seeded on 2026-11-26 on a local database: trial balance 1,34,55,194.75 each side; stock
43,53,814.80; customers owe 16,23,150.00; suppliers are owed 5,78,222.00; goods received and
not billed 71,250.00; October's profit 16,283 and November's 96,071. Ali's statement is as the
walk says: 12,308.40 earned in October, 1,976.00 released and paid (CP-2627-00001), 45.00 taken
back (CN-2627-00001), 3,501.40 owed. The whole seed takes 16 to 18 seconds there.

## Decided for Fazal, to confirm

1. **Not registered for sales tax**, as the first customer is not. So nothing of sales tax can
   be shown (docs/DEMO.md lists it under what the demo cannot show). A second, registered demo
   company would show it.
2. **Nine sign-ins, one for each role.** The coordinator asked for an accountant and a payroll
   administrator; a warehouse manager, a recovery officer and an auditor were added because each
   has a menu of its own, and "every feature" includes what each role sees. `demo:reset` removes
   all nine.
3. **The company withholds income tax from its suppliers** (section 153) and the province's tax
   on services, so the withholding register, the section 165 statement and a challan have real
   rows. With that on, a quick market purchase is from a seller in the market, not from a
   supplier on the list (the app's own rule).
4. **One salary is above the tax threshold**, so a payslip and the year's statement show income
   tax. The price is a difference of 320.00 on the withholding register (see "Found").
5. **Ali's commission is paid on its own, Sana's with her salary.** Both are employees; only
   Sana's sign-in is tied to her employee record. So the walk's "Pay commission" for Ali is
   still true, and payroll shows commission in a run.
6. **The owner's own sales were added, and costs sized for a small importer**, so that both
   months show a profit (16 thousand and 96 thousand). Without them the company the first
   seed described would have lost money once rent, salaries and the rest were entered. Those
   six invoices carry no commission.
7. **The stock transfer is inside Karachi** (warehouse to shop counter): a transfer between
   branches is not built.
8. **Price lists start the day before the seed**, on items no open order holds, so no existing
   document changes its price.
9. **No receipt file, no employee's bank account, no CNIC.** A file is stored by the person
   signed in, which a seed is not; an invented IBAN or CNIC could be a real one.
10. **Seeded into a local database, the demo has sign-ins and a passwords file of its own**
    (`demo-...@demo-local.sahulaterp.test`, `.env.demo-accounts-localdb.local`). The sign-in
    service is the hosted one either way, since a local database has none; the live demo's
    sign-ins are never touched from a local run. To allow this the seed now finds its sign-ins
    at the sign-in service by their exact addresses, where it read the database's own table.
11. **Amounts in docs/DEMO.md are grouped as the app shows them** (16,23,150.00).

## Found while seeding (reported, not worked around)

- **The withholding register does not read salary tax.** A payroll run credits its tax to the
  same account (2210) the register compares itself with, so the register shows a "Difference"
  equal to it (320.00 here). docs/later/step-41.md already lists it as still to do, with tax
  withheld on an expense. The seed says so in a note at its end and does not hide it.
- **`npm run demo:seed` and `demo:reset` printed nothing.** The runner logged what it did, and
  the test runner keeps a passing run's log to itself. `scripts/demo/demo.run.ts` now writes it
  straight to the terminal.
- **Aged receivables has no line comparing it with the books**, as aged payables and stock
  valuation have. The two agree (the seed checks it); the screen does not say so.

## Could not verify

- **The seed against the hosted database.** It was not run there (it removes the live demo and
  its sign-ins, which waits for the founder's yes). On a local database it takes 16 to 18
  seconds; over the network every command is several round trips, so expect minutes. No single
  statement is heavy; the longest transactions are one document each.
- **Seeded in the first days of a month.** This month's dates are then squeezed up to
  yesterday, as before; the parts added here follow the same rule but were run only on the
  26th.
- **The walk's last step, live.** Approving and paying Ali's commission (CP-2627-00002) was not
  pressed after this seed; the figures it would use are the ones the seed prints (3,546.40
  payable, 45.00 owed back).
- **Print and PDF.** The screens were opened and read; no PDF was downloaded.

## How the list in docs/DEMO.md was checked

Every line of "Every feature, and where to see it" names a sign-in, a screen and a number or
words. A throwaway script signed in as each of the nine sign-ins on a local server against the
locally seeded company, opened 172 screens and saved the text of each; a second one checked
that the words each line names were on its screen (107 lines, all found). The script is not
kept: it holds nothing but addresses.

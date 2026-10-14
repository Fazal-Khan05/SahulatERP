# SahulatERP — demo walkthrough (first-time, non-technical audience)

Live site: https://sahulaterp.vercel.app · Use Chrome on a laptop; zoom the browser to 110–125% for a room.

Demo account: `khanfazal3368@gmail.com` (password you set). It owns an empty company called **My Company** (so the audience sees the setup wizard) and also has access to the sample company **Sahulat Trading Co.** (populated; use it for dashboards and reports).

## Before you start (5 minutes)
- Have a PNG logo ready on the desktop (any image under 1 MB).
- Have a small CSV ready to import products (headers: `sku,name,category,unit,price,cost`) — 5–10 rows. Or use "Download template" inside the import dialog and fill it.
- Keep the storyline simple: **buy goods → stock them → sell them → get paid → see the numbers**.
- Things that will bite you if you forget them (all by design):
  - A new company has **no default sales-tax rate** and **no credit limits**. When you create a customer, set the credit limit to a big number (e.g. 10,000,000) or the invoice will refuse to submit without an owner override reason. Type the tax % on invoice lines (e.g. 18) if you want tax shown.
  - **Payroll won't run until EOBI/tax rates are entered** in Payroll settings. Don't open Payroll in the empty company; show it in the sample company.
  - **Cheques only post when cleared.** Record → Deposit → Cleared is the story.

## Part 1 — Signing in and setting up a company (≈4 min)
1. Open the site. Say: "This is a web app — nothing to install, works on a phone too."
2. Sign in. You land in the **setup wizard** because this company is new.
3. **Step 1 Company:** type the company name, address, phone, email. Say: "Whatever you type here appears on every invoice you print."
4. **Step 2 Documents:** upload the logo, click a colour, type a footer line like "Bank: HBL · Account 1234". Point at the live invoice preview on the right updating as you type.
5. **Step 3 Features:** click **Importer-distributor**. Say: "You switch on only what you need. Turn off Commissions — see how it asks nothing now; later we'll see turning things off needs your password so nobody hides data by accident." Turn it back on.
6. **Step 4 Review** → **Create my workspace**. You're on the Overview; it's empty because there's no data yet. Say: "Everything you see from here on is built from the transactions we enter."

## Part 2 — Products and customers (≈4 min)
7. **Inventory → Products → Import CSV.** Choose your CSV. Point out the column matching ("it recognised 'Item Code' as the SKU"). Click Import. Say: "If one row were wrong, nothing would import and it would tell me exactly which row."
8. Open **Products → New product** to show the form quickly (SKU, name, unit, price, cost, reorder level). Cancel.
9. **Inventory → Warehouses:** show the branch and warehouse; add a second warehouse ("Lahore godown"). Say: "Stock is tracked per warehouse."
10. **Sales → Customers → New customer:** name, city, phone, terms 30 days, **credit limit 10,000,000**. Save. Say: "The credit limit stops staff over-selling to a customer who owes too much; the owner can override with a reason."
11. **Purchasing → Suppliers → New supplier:** a Chinese supplier, terms 60 days.

## Part 3 — Buying stock (≈4 min)
12. **Purchasing → New purchase order:** supplier, currency **USD**, exchange rate 280, two lines (quantities and unit cost in dollars). Point at the totals: USD total and the PKR equivalent. **Save draft** → in the list press **Submit**.
13. Press **Receive** on the order. Say: "The goods arrived — but say only part of the order came." Reduce one line's quantity, create the **goods receipt note**, submit it. Open **Inventory → Stock** and show the quantity arrived in the warehouse.
14. Back in Purchasing, press **Receive** again on the order to show the remaining quantity is remembered ("it knows 40 are still to come"). Cancel.
15. Press **Invoice** on the goods receipt → supplier bill → submit. Say: "Now the supplier is owed money, in dollars, at the rate on the day."
16. **Purchasing → Supplier payments → Record payment:** choose the supplier, type the USD amount in "Amount received" (it allocates to the bill), then in **PKR actually paid** type a slightly higher figure (rate moved). Save. Say: "The difference is booked automatically as an exchange loss — nobody has to work it out."

## Part 4 — Selling (≈5 min)
17. **Sales → New quotation:** customer, two products (prices prefill from the product), quantity, a 10% discount on one line, tax 18 on both. Watch totals update. Save draft, **Submit**.
18. Press **Convert** → sales order → submit. Press **Deliver** → deliver only part of one line → submit the delivery note. Say: "Stock leaves the warehouse now, at today's average cost; the invoice comes next."
19. Press **Invoice** on the delivery → submit. Open the invoice (**View**): show the **document chain** (quotation → order → delivery → invoice), the lines and totals. Click **Print / PDF**: the branded invoice opens with the logo and footer you set in the wizard. Say: "Save as PDF and WhatsApp it."
20. Back on the invoice, press **Return**: return 1 unit, reason "damaged" → **Post return**. Show the credit note in the list and the invoice balance dropping.

## Part 5 — Getting paid (≈4 min)
21. **Collections → Record receipt:** customer, type an amount in "Amount received" — it spreads across the open invoices oldest first. Method **Cash**, into **Cash in hand**. Save.
22. **Record receipt** again: method **Cheque**, cheque number, cheque date next week. Save. Say: "A post-dated cheque is not money yet."
23. In **Cheques in hand**: choose the bank account, press **Deposit**; then press **Cleared**. Say: "Only now is it counted as collected — and only now does the salesperson's commission on it release."
24. Press **Log follow-up** to show recovery notes ("Promised payment Friday") — the Overview will remind you when it's due.

## Part 6 — Money, stock and the books (≈5 min)
25. **Cash & bank:** balances per account; click an account → activity with running balance. **Transfer** 10,000 from bank to cash; **Record expense** "Fuel" 2,000 from cash. Balances update instantly. Say: "This is the cash book — without a separate spreadsheet."
26. **Inventory → Stock:** quantities and values per warehouse; **Transfer stock** between warehouses; **View** a product → stock by warehouse and its movement history.
27. **Reports:** run **Aged receivables** ("who owes me, and how old is it"), a **Customer statement** (choose the customer — every invoice, return and receipt with a running balance; print it), **Sales analysis** by salesperson, **Profit & loss**, **Balance sheet** (point at "Assets − liabilities − equity = 0: the books balance"), **Control reconciliation** (all "reconciled"). Press **Export CSV** on one to show Excel works.
28. **Accounting:** show that every action above created a numbered journal entry automatically; the trial balance balances. Say: "Your accountant gets proper books without anyone doing double entry."

## Part 7 — Commissions and payroll (use the sample company) (≈4 min)
29. Open the company switcher (top-left) → **Sahulat Trading Co.** Say: "This is a sample company with a month of activity so you can see it populated."
30. **Overview:** the real chart, the "needs attention" queues (cheques due, approvals, follow-ups), recent sales.
31. **Commissions:** entitlements per salesperson — earned, released (as customers paid), paid. Point at an invoice that was partly collected: commission released in proportion. Point at a bounced cheque: release reversed. **Plans:** show the plan types (flat, by category, by customer class, tiered, targets).
32. **Payroll:** runs with salary, attendance, commission settlement, EOBI and tax, approve → paid; note "Commission recovered" for a cheque that bounced after payout. **Employees** tab for the staff list.
33. **Settings → Features:** turn off Payroll — it asks for your password; cancel. Say: "Nothing is ever deleted; it's hidden and comes back exactly as it was." **Company & documents:** change the accent colour and watch the invoice preview.
34. **Settings → Access → View as role:** pick **Salesperson** — the sidebar shrinks and the data narrows to that person's own sales; press **Exit preview**. Say: "Each user only sees what their job needs; salaries never leave the server for a salesperson."

## Closing line
"Every number you saw came from the transactions we entered in the last twenty minutes — the invoice, the cheque, the stock, the exchange loss, the commission. One system, and it never lets the books go out of balance."

## If something goes wrong on stage
- A form refuses to save: read the message out loud — it says what to fix (e.g. credit limit, archived product, locked period).
- Page looks stale: press the browser refresh; nothing is lost, everything is saved as you go.
- You cannot remember the account you deposited a cheque into: **Cash & bank → Cheques in hand** shows it.

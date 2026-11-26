# Batch B: sales analysis and registers

Added (version 1.7): sales by customer, item, salesperson, city and month; the sales register;
purchases by supplier, purchases by item; the purchase register. They are in the Reports page
(under "Sales analysis" and "Purchases"), download to Excel and CSV, and print. No migration.

How they are worked out: the lines of posted invoices less the lines of posted credit notes,
before sales tax, by each document's date. Each sales report ends with the Sales account in the
books for the same days and branch and the difference, which must be nil (a hand-made journal
entry to the Sales account would show up there). Costs are read the way Item profit reads them.

## Decided for Fazal, to confirm

1. **Who reads the sales reports:** the owner, an accountant, an auditor and the sales manager.
   The sales manager sees the sales but never cost, profit or the books comparison. A salesperson
   sees none of them. (A new permission, `sales_report.read`, in `src/tracks/selling.ts`.)
2. **Who reads the purchase reports:** the same people as the other buying reports (owner,
   accountant, auditor).
3. **Sales by month is largest month first,** as asked for all five. Say if you would rather have
   calendar order for this one.
4. **A shared line:** each salesperson gets their share of the line's amount and cost. A credit
   note takes back from the same people as its invoice. A sale with nobody named shows under
   "No salesperson"; someone who has left the company shows as "A member who has left".
5. **City** is the city on the customer's main address; none shows as "No city recorded".
6. **Purchases** are bills before tax less goods sent back that a bill had already taken. Goods
   sent back before any bill (still "received, not billed") are not purchases and are left out.
   Charges on a bill that are not for an item are one line, "Other", in purchases by item.
7. **Purchase reports have no comparison with the books** (only the sales reports were asked to).

## Later

- The cost columns for sales by customer, salesperson, city and month read the stock moves of
  every line sold in the period, through row-level security. Item profit needed a database
  function (`app.item_profit`, migration 0043) once a company had thousands of invoices. If these
  reports are slow for a big customer, the same kind of function, one pass in the database, is the
  fix; it needs a migration, so it was not done here.
- Sales by salesperson rounds each person's share to four decimals; a share like 33.3333% can
  leave the total a hundredth of a paisa off the books' figure. Shares that come to whole
  percentages (the usual) are exact.

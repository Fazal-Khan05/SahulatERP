# Step 26: supplier payments, advances and withholding challans

Built in track B (stock and buying) by the Builder, on Step 25's supplier bills. Migration
`0031_supplier_payments`.

## Decided by the founder (2026-11-15, in the Builder's chat)

- **A foreign-currency advance to a supplier is kept at the rupees actually paid.** It is not
  revalued at month end, whatever the exchange rate does. (The plan's row says "with
  revaluation"; this is the founder's decision against it. Money paid ahead for goods is what
  the goods cost, and accounting standards treat it the same way.)
- **The migration may be applied to the shared development database** once it has passed its
  independent review and the local tests (the same yes covers Steps 24, 25 and 26).

## A dependency that changed

`docs/PARALLEL.md` says the exchange gain or loss rule is built by track A in Step 22 and used
by track B in Step 26. It no longer is: the founder told the Finisher that foreign-currency
sales are not needed now, so Step 22 builds counter sales only (coordinator's note,
2026-11-15). **Step 26 needs no exchange difference**: supplier bills are in rupees (Step 25),
and an advance is kept at the rupees paid, so setting an advance against a bill is rupees
against rupees. PARALLEL.md should be corrected at the merge. When bills in a foreign currency
are built, the difference on settlement goes to Exchange gain or loss (5830), which is already
in the chart.

## What was built

- **Supplier payments** (`/purchases/payments`). A payment is to one supplier, out of a cash or
  bank account, on a day, for an amount in rupees. It names what it settles of which of the
  supplier's unpaid bills. It is a draft until it is posted; posting gives it its number
  (PV-2627-00001). What a bill is owed is what Step 25 left owed to the supplier after tax was
  withheld, so **the payment is net of the tax withheld**.

  | Account | Debit | Credit |
  | --- | ---: | ---: |
  | 2110 Trade payables | what it settles of bills | |
  | 1210 Advances to suppliers | whatever is left over | |
  | the cash or bank account | | the rupees paid |

- **Advances.** Money paid with no bill to set it against, or more than the bills named, is an
  advance to the supplier. On the payment's page it is later set against a bill (debit Trade
  payables, credit Advances to suppliers). A bill is never settled past what is owed on it.
- **Paid abroad.** A payment can record the currency and how much of it the rupees bought. The
  page shows what one unit cost. It is for the record only.
- **Cancelling a payment** entered by mistake, with a reason and a date: the opposite of
  everything it posted is posted, the bills it settled are owed again, and it keeps its number,
  marked cancelled.
- **Challans** (on Purchases, Withholding tax). The page lists every amount withheld on bills
  that has not been paid to the government. Ticking amounts of one kind of tax and entering the
  challan's number, date and the account it was paid from records the challan (WC-2627-00001):
  debit the withholding payable account, credit the cash or bank account. An amount withheld
  is paid once, whole.
- **Every command writes an audit row.**

**The acceptance test**, "Payment of a bill with an advance applied nets correctly": in
`src/modules/supplier-payments/payments.test.ts` and on screen in
`e2e/supplier-payments.spec.ts`. Rs 50,000 is sent ahead (USD 178.57); the bill comes for
Rs 100,000 with Rs 10,000 withheld, so Rs 90,000 is owed; the advance is set against it and
Rs 40,000 is paid; nothing is then owed on the bill, no advance is left, and the supplier's
balance across Trade payables and Advances to suppliers is nil.

## Decided for Fazal, to confirm

Nobody was asked these while building. Each is the option I would recommend; say if any should
change.

1. **Who does what.** The owner and an accountant pay suppliers, set advances against bills,
   cancel payments and record challans. The auditor reads. Nobody else sees any of it.
2. **No approval step.** Whoever may pay may post the payment. A second person's approval for
   payments above an amount can be added later if you want it.
3. **A payment says which bills it settles; nothing is matched automatically.** "Pay all that
   is owed" fills in every unpaid bill with one press.
4. **Money paid before a bill's date is an advance.** It is set against the bill on or after
   the bill's own day, never earlier.
5. **An advance is set against bills by hand**, on the payment's page. A new bill does not take
   up an old advance by itself.
6. **Nothing is withheld on an advance.** Tax is withheld when the bill is posted (Step 25), on
   the whole bill, so the supplier is then owed the bill less the tax, whatever was sent ahead.
   If the advance was for more than that, the rest stays an advance.
7. **A payment is in rupees, out of one cash or bank account.** Cheques given to suppliers are
   not tracked through clearing as customers' cheques are: the payment is in the books on its
   date. The cheque number goes in the reference.
8. **A challan pays whole amounts withheld**, of one kind of tax, and is not cancelled once
   recorded. It belongs to the whole company, so someone who works in only some branches
   cannot record one.
9. **Cancelling a payment** needs a date on or after everything it posted, in an open period.
   A cancelled payment's number is not reused.
10. **A payment belongs to one branch** and settles that branch's bills.

## For a tax adviser

No accountant or tax adviser has checked any of this. The second, independent working of the
worked example (`docs/examples/step-26.md`) agreed with every entry, and raised these doubts:

- **When tax is withheld.** The law has tax deducted when the supplier is paid, advances
  included, and counts the days to deposit it from the payment. Here it is recorded at the bill
  (Step 25), so an advance goes out with nothing withheld, and the tax on it is recorded only
  when the bill comes. A company that pays large advances could be late depositing. Whether to
  withhold on an advance as it is paid needs deciding with an adviser (point 6 above).
- **Suppliers abroad.** Payments to a supplier who is not resident in Pakistan fall under a
  different section of the law (section 152), with its own rates. The withholding lines in the
  tax tables are section 153's, for residents. Nothing here works out tax on a payment abroad.
- **Cancelling a payment** is right for one entered by mistake. If money really left the bank
  twice, it should stay in the books as an advance until the supplier gives it back.

## Later

- **Bills and payments in a foreign currency**, with the exchange difference on settlement
  (see "A dependency that changed").
- **Supplier returns and debit notes (Step 27)**, which will need to give back or carry forward
  what was paid on a returned bill.
- **Aged payables, the supplier statement, the withholding register and the section 165
  statement (Step 29).** A supplier's position today is its unpaid bills (on a new payment) and
  its advances (on the payments list); there is no statement yet.
- **Cheques given to suppliers** tracked until they clear, and bank reconciliation (Step 34
  onwards).
- **Cancelling a challan** recorded by mistake.
- **A refund from a supplier** of an advance that will not be used.
- **Lists show the newest 200 payments**; no search, paging or export yet.

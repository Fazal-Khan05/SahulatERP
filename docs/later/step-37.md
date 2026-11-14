# Step 37: commission plans and the sales hierarchy

Track C. Built on 2026-11-15 by the Finisher session (moved from the Builder so that it overlaps
with the Builder's Step 21). Migration `0025_commission_plans`.

## Decided by the founder (2026-11-14, asked once for the batch of Steps 32, 21 and 37)

- **A plan per person.** Each salesperson can be put on a plan of their own, with one default
  plan for anyone not given one.
- **Managers earn on what their team sells**: a percentage set in the manager's plan, at every
  level above the seller. Who reports to whom is recorded in this step; the money is worked
  out in Step 38.
- **A monthly target's higher rate applies from the sale that reaches the target onwards.**
  Sales made earlier in the month keep the normal rate (as the old prototype did).
- **Slabs are measured on the salesperson's total sales in the month**, not on each invoice
  line alone (the old prototype measured each line).
- **Only the owner creates and changes commission plans** and says who reports to whom. The
  accountant and the auditor read them.

## What was built

- **Commission plans**: a plan for one salesperson, or the default plan for everyone without one;
  flat, by item category, by customer class, per unit, or slabs on the month's sales; a monthly
  target with a multiplier; a team rate for managers; from a day, to a day or no end. A person's
  plans, and the default plans, never overlap (refused by the database, SE301).
- **The sales hierarchy**: one manager for each member of the sales team, never in a circle
  (refused by the database, SE302).
- **The working-out** in `src/modules/commissions/rules.ts` and, identically, in the database
  (`app.commission_on_line` and friends, see "For the other steps"). Nothing is accrued or posted:
  that is Step 38.
- **Screens**: `/commissions` (the plans and who reports to whom; the owner's and the sales
  manager's Commissions, the auditor's too; the accountant's way in is Reports, "Commission
  plans"), `/commissions/plans/new` and `/commissions/plans/<id>` for the owner.

**The acceptance test**, "Old unit tests pass against the new rules.ts": the old prototype's
calculation and validation tests (COM-003 to COM-016, COM-032, COM-033, COM-038, COM-039, COM-049,
COM-050, COM-069 to COM-072, COM-077) are ported by hand in `rules.test.ts` and pass, and the
database gives the same figures (`commissions.test.ts`). **COM-014 is changed on purpose**: the
founder decided slabs are measured on the month's sales, so a second sale of 100,000 after
600,000 in the same month earns 3,000 at 3%, not 2,000 at 2% as the old per-line rule gave. The
old tests of accrual, release, approval and payroll (COM-017 to COM-031, COM-034 to COM-037 and
the rest) belong to Step 38 and later.

## Decided for Fazal, to confirm

- **The sales manager reads the plans** as well as the accountant and the auditor: the sales
  manager's menu has a Commissions entry, and they manage the team the plans pay.
- **A plan may have no end date**; a new plan for the same person must then start after the old
  one is given an end.
- **The multiplier is at most 10**, against a typing slip; the old prototype had no limit.
- **Customer classes match whatever their capitals and outer spaces** ("Wholesaler" and
  " wholesaler " are the same class), because the class is typed freely on each customer.
- **A manager's share does not use targets or slabs**: it is the manager's team rate on the
  seller's sale, at every level above the seller.
- **The hierarchy has no dates.** Who reports to whom is as it stands when an invoice is posted;
  Step 38 keeps what it accrued, so a later change does not move past commission.
- **A plan can be edited and removed by the owner.** An edit changes what is worked out for
  invoices posted afterwards only; Step 38 keeps the amounts it accrued. Once Step 38 has accrued
  on a plan, its foreign key keeps the plan from being removed (it can be ended with a date).

## Review of the migration

An independent reviewer attacked `0025_commission_plans` as arbitrary SQL from the app's role
(2026-11-15). Nothing crossed a company or let a non-owner write. Fixed in the migration, each
with a test:

- the overlap and circle checks refused nothing under repeatable read, where two transactions
  could each miss the other's row and together close a circle (which would have paid the
  managers in it many times over): they now let in read committed transactions only (SE304);
- the checks ran before row-level security, so their answer ("dates overlap", "a circle") told a
  non-owner or a stranger what plans and hierarchy were there: they now first make sure the
  writer is the company's owner;
- they took advisory locks that anyone could hold, stalling another company's saves: they now
  lock the company's row, which the app's role cannot;
- `app.commission_on_line` let "infinity" through and returned "not a number": refused (SE303).

## Later

- **The salesperson's own view of their plan** ("My commission") comes with the statements of
  Step 39.
- **Returns and the month's total**: whether a credit note takes its sale out of the month's
  total that slabs and the target are measured on is Step 38's to decide, since it passes the
  month's total in.
- **Plans in a currency other than rupees**: amounts are in the base currency.
- **A per-unit plan counts in the item's own unit**, whatever unit the line was sold in.

## For the other steps

These will not be renamed. Step 38 (accrual, release, reversal) is built on them.

**What one salesperson earns on their part of a line**, inside the transaction that posts an
invoice:

```sql
SELECT plan_id, amount
FROM app.commission_on_line(p_tenant, p_user, p_date, p_item, p_customer, p_base, p_quantity, p_month_before);
```

- `p_user`: the salesperson (a `sales_line_salespeople.user_id`).
- `p_date`: the invoice's `document_date`; it picks the plan.
- `p_item`, `p_customer`: the line's item and the invoice's customer; the category and the
  customer class are read from them.
- `p_base`: the salesperson's share of the line's value after discount and before tax, in base
  currency (`sales_lines.value × exchange_rate × share / 100`, rounded to 4 by the caller).
- `p_quantity`: their share of the quantity in the item's own unit (`base_quantity × share / 100`).
- `p_month_before`: **what that salesperson had already sold in the same calendar month before
  this line**, summed from Step 38's own accruals (their `p_base`s), net of returns as Step 38
  decides. The function does not work it out itself: it reads no accrual table, so the caller
  owns the order of lines and what counts. The slabs and the target are measured on it.
- Returns one row, `(plan_id, amount)` with `amount` rounded to 4 decimals, or **no row when no
  plan applies on that day** (then nothing accrues). Keep `plan_id` on the accrual: it says which
  plan the amount was worked out on.
- Refuses (SE303) a base, quantity or month-before below nothing.

**The managers above a salesperson**, nearest first:

```sql
SELECT level, manager_user_id, plan_id, team_rate
FROM app.commission_managers(p_tenant, p_user, p_date);
```

- Level 1 is the seller's own manager. `plan_id` is the plan that applies to that manager on
  `p_date` (null when none), `team_rate` its percentage (0 when none).
- A manager earns `round(p_base × team_rate / 100, 4)` on the seller's base, at every level
  (`managerShare` in rules.ts). Targets and slabs do not apply to a manager's team earnings.

**Also there**: `app.commission_plan_for(p_tenant, p_user, p_date) → uuid` (the person's own plan
covering the day, else the default plan covering it, else null) and
`app.commission_slabs(p_plan, p_total) → numeric` (unrounded).

All four run as the table owner, take the company as an argument, and are revoked from PUBLIC
and granted to nobody: only another function of the database (Step 38's posting, itself a
definer) can call them. The same working-out in TypeScript is `commissionOnLine`, `slabs` and
`managerShare` in `src/modules/commissions/rules.ts`. `src/modules/commissions/commissions.test.ts`
holds the SQL and the TypeScript to the same figures on the old prototype's tests.

**Tables**: `commission_plans` (`user_id` null for the default plan; `kind` flat, category,
customer_class, per_unit, tiered; `rate`, `target`, `multiplier`, `team_rate`, `effective_from`,
`effective_to` null for no end), `commission_plan_rates` (`category_id` or `customer_class`, `rate`),
`commission_plan_tiers` (`threshold`, `rate`), `sales_hierarchy` (`user_id`, `manager_user_id`).
A plan can be edited (only by the owner) and deleted; a foreign key from Step 38's accruals to
`commission_plans` will keep a plan that commission was worked out on (`deletePlan` already turns
that refusal into words). An accrual should keep the amounts it was given, not read the plan again.

**The splits**: `checkSplits` in rules.ts refuses shares that do not total 100 ("Commission splits
must total 100%."); the sales documents already store shares that total 100.

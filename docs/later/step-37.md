# Step 37: commission plans and the sales hierarchy

To be built in track C (commissions). This file is filled in as the step goes.

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

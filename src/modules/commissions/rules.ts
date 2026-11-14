import Decimal from "decimal.js";
import { isIsoDate } from "@/modules/currencies/rules";

// Pure rules for commission plans and the sales hierarchy (Step 37). No I/O.
//
// Ported by hand from the old prototype (reference/old-engine/engine.ts, commissionAmount and
// save_plan; its tests in reference/tests/qa/12-commissions.test.ts), with the founder's changes
// of 2026-11-14:
//   - a plan belongs to one salesperson, or is the default plan for everyone without one;
//   - slabs (tiers) are measured on the salesperson's sales in the month so far, not on each line;
//   - a manager earns a percentage, set in the manager's own plan, of the team's sales.
// The same working-out is in the database as app.commission_on_line (drizzle, Step 37's
// migration), so that Step 38 can accrue inside the transaction that posts an invoice; the
// tests hold the two to the same figures.

export const PLAN_KINDS = ["flat", "category", "customer_class", "per_unit", "tiered"] as const;
export type PlanKind = (typeof PLAN_KINDS)[number];
export const PLAN_KIND_LABELS: Record<PlanKind, string> = {
  flat: "One rate on everything",
  category: "A rate by item category",
  customer_class: "A rate by customer class",
  per_unit: "An amount per unit sold",
  tiered: "Slabs on the month's sales",
};
export const isPlanKind = (value: unknown): value is PlanKind => typeof value === "string" && (PLAN_KINDS as readonly string[]).includes(value);

/** What a plan says, as the working-out needs it. Rates are percentages, except a per-unit plan's, which is rupees a unit. */
export type PlanTerms = {
  kind: PlanKind;
  rate: Decimal;
  /** Category id → rate, for a category plan. A category not listed earns `rate`. */
  categoryRates: ReadonlyMap<string, Decimal>;
  /** Customer class (as classKey gives it) → rate, for a customer-class plan. A class not listed earns `rate`. */
  classRates: ReadonlyMap<string, Decimal>;
  /** Slabs of a tiered plan: from `threshold` of the month's sales, `rate` percent. */
  tiers: readonly { threshold: Decimal; rate: Decimal }[];
  /** The month's sales at which the multiplier starts; 0 for no target. */
  target: Decimal;
  multiplier: Decimal;
  /** What a manager on this plan earns on the sales of everyone under them, in percent. */
  teamRate: Decimal;
};

/** One salesperson's part of an invoice line, as Step 38 hands it over. */
export type LineFacts = {
  /** The salesperson's share of the line's value after discount and before tax. */
  base: Decimal;
  /** The salesperson's share of the quantity, in the item's own unit. */
  quantity: Decimal;
  categoryId: string | null;
  customerClass: string | null;
};

const ZERO = new Decimal(0);
const HUNDRED = new Decimal(100);
/** A customer class is typed freely on each customer: it matches a plan's class whatever its capitals and outer spaces. */
export const classKey = (customerClass: string) => customerClass.trim().toLowerCase();
/** Money is kept to four decimals, half away from zero, as the database rounds. */
export const money = (amount: Decimal) => amount.toDecimalPlaces(4, Decimal.ROUND_HALF_UP);

/** What the slabs give on a month's sales of `total`: each slab's rate on the part of the total inside it. */
export function slabs(tiers: PlanTerms["tiers"], total: Decimal): Decimal {
  const sorted = [...tiers].sort((a, b) => a.threshold.comparedTo(b.threshold));
  return sorted.reduce((sum, tier, at) => {
    const upTo = at + 1 < sorted.length ? Decimal.min(total, sorted[at + 1].threshold) : total;
    return sum.plus(Decimal.max(ZERO, upTo.minus(tier.threshold)).times(tier.rate).div(HUNDRED));
  }, ZERO);
}

/**
 * What one salesperson earns on their part of an invoice line, before rounding is the only
 * thing left: `monthBefore` is what that salesperson had already sold in the same calendar month
 * (their earlier lines' bases), which the slabs and the target are measured on.
 *
 *   flat, category, customer_class   base × rate (the category's or class's rate, else the plan's)
 *   per_unit                          quantity × rate
 *   tiered                            slabs(monthBefore + base) − slabs(monthBefore)
 *
 * When the plan has a target and the month's sales including this line reach it, this line's
 * commission is multiplied: from the sale that reaches the target onwards, not the month before.
 */
export function commissionOnLine(plan: PlanTerms, line: LineFacts, monthBefore: Decimal): Decimal {
  let amount: Decimal;
  switch (plan.kind) {
    case "per_unit":
      amount = line.quantity.times(plan.rate);
      break;
    case "tiered":
      amount = slabs(plan.tiers, monthBefore.plus(line.base)).minus(slabs(plan.tiers, monthBefore));
      break;
    case "category":
      amount = line.base.times((line.categoryId !== null ? plan.categoryRates.get(line.categoryId) : undefined) ?? plan.rate).div(HUNDRED);
      break;
    case "customer_class":
      amount = line.base.times((line.customerClass !== null ? plan.classRates.get(classKey(line.customerClass)) : undefined) ?? plan.rate).div(HUNDRED);
      break;
    case "flat":
      amount = line.base.times(plan.rate).div(HUNDRED);
      break;
  }
  if (plan.target.gt(0) && monthBefore.plus(line.base).gte(plan.target)) amount = amount.times(plan.multiplier);
  return money(amount);
}

/** What a manager earns on a sale under them: their plan's team rate on the seller's base. */
export function managerShare(teamRate: Decimal, base: Decimal): Decimal {
  return money(base.times(teamRate).div(HUNDRED));
}

/** Salespeople's shares of a line must come to exactly 100. */
export function checkSplits(shares: readonly Decimal[]): string | null {
  if (shares.length === 0) return null;
  return shares.reduce((sum, share) => sum.plus(share), ZERO).eq(HUNDRED) ? null : "Commission splits must total 100%.";
}

// ── Plans as typed, and their dates ─────────────────────────────────────────────────────────────

/** Two date ranges overlap; a missing end runs for ever. Ranges that only touch end to end do not overlap. */
export function rangesOverlap(a: { from: string; to: string | null }, b: { from: string; to: string | null }): boolean {
  return (a.to === null || b.from <= a.to) && (b.to === null || a.from <= b.to);
}

export type PlanDraft = {
  name: string;
  userId: string | null;
  kind: PlanKind;
  rate: Decimal;
  categoryRates: { categoryId: string; rate: Decimal }[];
  classRates: { customerClass: string; rate: Decimal }[];
  tiers: { threshold: Decimal; rate: Decimal }[];
  target: Decimal;
  multiplier: Decimal;
  teamRate: Decimal;
  from: string;
  to: string | null;
};

export type RawPlan = {
  name?: unknown;
  userId?: unknown;
  kind?: unknown;
  rate?: unknown;
  categoryRates?: readonly { categoryId?: unknown; rate?: unknown }[];
  classRates?: readonly { customerClass?: unknown; rate?: unknown }[];
  tiers?: readonly { threshold?: unknown; rate?: unknown }[];
  target?: unknown;
  multiplier?: unknown;
  teamRate?: unknown;
  from?: unknown;
  to?: unknown;
};

const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A number as typed: plain digits and one point, at most four decimals; empty is `empty`. */
function amount(raw: unknown, what: string, empty: Decimal | null): { ok: true; value: Decimal } | { ok: false; reason: string } {
  const typed = text(raw);
  if (typed === "") return empty === null ? { ok: false, reason: `Enter ${what}.` } : { ok: true, value: empty };
  if (/^-/.test(typed)) return { ok: false, reason: `${what[0].toUpperCase()}${what.slice(1)} cannot be negative.` };
  if (!/^\d+(\.\d{1,4})?$/.test(typed)) return { ok: false, reason: `Enter ${what} as a plain number, such as 2.5.` };
  if (typed.split(".")[0].replace(/^0+/, "").length > 12) return { ok: false, reason: `${what[0].toUpperCase()}${what.slice(1)} is too large.` };
  return { ok: true, value: new Decimal(typed) };
}

/**
 * Reads a plan as the owner typed it. The old prototype's messages are kept where its tests
 * named them ("Plan dates are invalid.", "Percentage cannot exceed 100.").
 */
export function readPlan(raw: RawPlan): { ok: true; draft: PlanDraft } | { ok: false; reason: string } {
  const name = text(raw.name);
  if (name.length < 2) return { ok: false, reason: "Give the plan a name of at least two letters." };
  if (name.length > 100) return { ok: false, reason: "Keep the plan's name under 100 letters." };
  const user = text(raw.userId);
  if (user !== "" && !UUID.test(user)) return { ok: false, reason: "Choose who the plan is for." };
  if (!isPlanKind(raw.kind)) return { ok: false, reason: "Choose how the plan pays." };
  const kind = raw.kind;
  const percent = (value: Decimal) => value.lte(HUNDRED);

  const rate = amount(raw.rate, kind === "per_unit" ? "the amount per unit" : "the rate", kind === "tiered" ? ZERO : null);
  if (!rate.ok) return rate;
  if (kind !== "per_unit" && !percent(rate.value)) return { ok: false, reason: "Percentage cannot exceed 100." };

  const categoryRates: PlanDraft["categoryRates"] = [];
  if (kind === "category") {
    for (const [at, row] of (raw.categoryRates ?? []).entries()) {
      const id = text(row.categoryId);
      if (id === "" && text(row.rate) === "") continue;
      if (!UUID.test(id)) return { ok: false, reason: `Category rate ${at + 1}: choose the category.` };
      const value = amount(row.rate, "the category's rate", null);
      if (!value.ok) return value;
      if (!percent(value.value)) return { ok: false, reason: "Percentage cannot exceed 100." };
      if (categoryRates.some((c) => c.categoryId === id.toLowerCase())) return { ok: false, reason: "A category is given two rates." };
      categoryRates.push({ categoryId: id.toLowerCase(), rate: value.value });
    }
  }
  const classRates: PlanDraft["classRates"] = [];
  if (kind === "customer_class") {
    for (const [at, row] of (raw.classRates ?? []).entries()) {
      const customerClass = text(row.customerClass);
      if (customerClass === "" && text(row.rate) === "") continue;
      if (customerClass === "" || customerClass.length > 40) return { ok: false, reason: `Class rate ${at + 1}: name the customer class.` };
      const value = amount(row.rate, "the class's rate", null);
      if (!value.ok) return value;
      if (!percent(value.value)) return { ok: false, reason: "Percentage cannot exceed 100." };
      if (classRates.some((c) => c.customerClass.toLowerCase() === customerClass.toLowerCase())) return { ok: false, reason: "A customer class is given two rates." };
      classRates.push({ customerClass, rate: value.value });
    }
  }
  const tiers: PlanDraft["tiers"] = [];
  if (kind === "tiered") {
    for (const row of raw.tiers ?? []) {
      if (text(row.threshold) === "" && text(row.rate) === "") continue;
      const threshold = amount(row.threshold, "where the slab starts", null);
      if (!threshold.ok) return threshold;
      const value = amount(row.rate, "the slab's rate", null);
      if (!value.ok) return value;
      if (!percent(value.value)) return { ok: false, reason: "Percentage cannot exceed 100." };
      if (tiers.some((t) => t.threshold.eq(threshold.value))) return { ok: false, reason: "Two slabs start at the same amount." };
      tiers.push({ threshold: threshold.value, rate: value.value });
    }
    if (tiers.length === 0) return { ok: false, reason: "A slab plan needs at least one slab." };
    tiers.sort((a, b) => a.threshold.comparedTo(b.threshold));
  }

  const target = amount(raw.target, "the monthly target", ZERO);
  if (!target.ok) return target;
  const multiplier = amount(raw.multiplier, "the multiplier", new Decimal(1));
  if (!multiplier.ok) return multiplier;
  if (!multiplier.value.gt(0)) return { ok: false, reason: "Amount must be greater than zero." };
  if (multiplier.value.gt(10)) return { ok: false, reason: "The multiplier can be at most 10." };
  const teamRate = amount(raw.teamRate, "the team rate", ZERO);
  if (!teamRate.ok) return teamRate;
  if (!percent(teamRate.value)) return { ok: false, reason: "Percentage cannot exceed 100." };

  const from = text(raw.from);
  const to = text(raw.to);
  if (!isIsoDate(from)) return { ok: false, reason: "Give the day the plan starts." };
  if (to !== "" && !isIsoDate(to)) return { ok: false, reason: "Give the day the plan ends, or leave it empty." };
  if (to !== "" && to < from) return { ok: false, reason: "Plan dates are invalid." };

  return { ok: true, draft: { name, userId: user === "" ? null : user.toLowerCase(), kind, rate: rate.value, categoryRates, classRates, tiers, target: target.value, multiplier: multiplier.value, teamRate: teamRate.value, from, to: to === "" ? null : to } };
}

// ── The sales hierarchy ─────────────────────────────────────────────────────────────────────────

/**
 * Whether making `manager` the manager of `member` would close a circle: walking up from the
 * manager through `managerOf` reaches the member. Someone as their own manager is a circle too.
 */
export function makesCycle(member: string, manager: string, managerOf: ReadonlyMap<string, string>): boolean {
  const seen = new Set<string>([member]);
  let at: string | undefined = manager;
  while (at !== undefined) {
    if (seen.has(at)) return true;
    seen.add(at);
    at = managerOf.get(at);
  }
  return false;
}

/** Everyone above a member, nearest first. */
export function managersAbove(member: string, managerOf: ReadonlyMap<string, string>): string[] {
  const chain: string[] = [];
  const seen = new Set<string>([member]);
  let at = managerOf.get(member);
  while (at !== undefined && !seen.has(at)) {
    chain.push(at);
    seen.add(at);
    at = managerOf.get(at);
  }
  return chain;
}

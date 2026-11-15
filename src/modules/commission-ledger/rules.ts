import Decimal from "decimal.js";

// Pure rules for commission that has been earned. No I/O.
//
// What a plan gives on a line is Step 37's (src/modules/commissions/rules.ts). This is what
// becomes of it afterwards: how much is still earned once goods have come back, how much the
// customer's money has released, what is owed to a person and what they owe back. The database
// does the same working-out when it happens (drizzle, the commission ledger migration); these
// are for showing it, and for the worked example's tests.

const NIL = new Decimal(0);
const four = (amount: Decimal) => amount.toDecimalPlaces(4, Decimal.ROUND_HALF_UP);

export const MOVEMENT_TYPES = ["accrued", "entitlement_adjusted", "released", "release_reversed", "paid", "recovery_recorded"] as const;
export type MovementType = (typeof MOVEMENT_TYPES)[number];
export const MOVEMENT_WORDS: Record<MovementType, string> = {
  accrued: "Earned when the invoice was posted",
  entitlement_adjusted: "Goods came back",
  released: "Released: the customer paid",
  release_reversed: "Release taken back",
  paid: "Paid",
  recovery_recorded: "Taken back out of a later payment",
};

/** Where an accrual stands. */
export type Standing = { earned: Decimal; released: Decimal; paid: Decimal };

/** Earned but waiting for the customer's money. */
export const waiting = (a: Standing) => Decimal.max(a.earned.minus(a.released), 0);
/** Released and not yet paid: what can be approved and paid. */
export const payable = (a: Standing) => Decimal.max(a.released.minus(a.paid), 0);
/** Paid, and since taken back by a bounce or a return: what the person owes back. */
export const owedBack = (a: Standing) => Decimal.max(a.paid.minus(a.released), 0);

/** In words, for a list. */
export function standingLabel(a: Standing & { approved: boolean }): string {
  if (owedBack(a).gt(0)) return "Owed back";
  if (a.earned.isZero()) return "Nothing earned";
  if (payable(a).gt(0)) return a.approved ? "Approved for payment" : "Released, to approve";
  if (waiting(a).gt(0)) return a.released.isZero() ? "Waiting for the customer to pay" : "Part released";
  return "Paid";
}

/** What is still earned of an accrual once so many of the line's goods have come back. */
export function earnedAfterReturn(accrued: Decimal, invoiced: Decimal, returned: Decimal): Decimal {
  if (returned.gte(invoiced)) return NIL;
  return four(accrued.times(invoiced.minus(returned)).div(invoiced));
}

/**
 * How much of what is earned has been released: the proportion of the invoice that has been
 * collected. `remaining` is what is left of the invoice to collect, its total less its credit
 * notes. With nothing left to collect there is nothing to wait for: an invoice that came to
 * nothing releases what it earned at once, and one that has all come back has earned nothing.
 */
export function releasedFor(earned: Decimal, collected: Decimal, remaining: Decimal): Decimal {
  if (remaining.lte(0)) return earned;
  return four(earned.times(Decimal.min(collected.div(remaining), 1)));
}

export type Totals = { earned: Decimal; released: Decimal; paid: Decimal; waiting: Decimal; payable: Decimal; approved: Decimal; owedBack: Decimal };

/** What a set of accruals comes to. `approved` is the part of what is payable that has been approved. */
export function totalsOf(rows: readonly (Standing & { approved: boolean })[]): Totals {
  const sum = (pick: (row: Standing & { approved: boolean }) => Decimal) => rows.reduce((total, row) => total.plus(pick(row)), NIL);
  return {
    earned: sum((row) => row.earned),
    released: sum((row) => row.released),
    paid: sum((row) => row.paid),
    waiting: sum(waiting),
    payable: sum(payable),
    approved: sum((row) => (row.approved ? payable(row) : NIL)),
    owedBack: sum(owedBack),
  };
}

/**
 * What a payment to one person comes to: everything approved, less what they owe back as far
 * as the payment goes; the rest of what they owe is carried to the next payment.
 */
export function paymentOf(approved: Decimal, owed: Decimal): { gross: Decimal; recovered: Decimal; amount: Decimal; carried: Decimal } {
  const recovered = Decimal.min(approved, owed);
  return { gross: approved, recovered, amount: approved.minus(recovered), carried: owed.minus(recovered) };
}

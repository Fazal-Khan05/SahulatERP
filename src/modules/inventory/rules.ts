import Decimal from "decimal.js";

// Pure rules for stock. No I/O.
//
// A warehouse holds a quantity of an item and that quantity has a value: what the goods cost.
// Goods coming in add their quantity and their value. Goods leaving take their share of the
// value with them, at the weighted-average cost: the value on hand times the quantity leaving,
// over the quantity on hand, rounded to the paisa. The last of the stock takes the last of the
// value, so rounding never leaves a value behind with nothing in stock.
//
// The database works a move out the same way (app.move_stock); these functions say what it
// will do, for the screens and for the tests. Quantities are in the item's own unit.

export type StockOnHand = { quantity: Decimal; value: Decimal };

const Wide = Decimal.clone({ precision: 60 });

/** What one of the item's own unit costs on average; nil when there is none in stock. */
export function averageCost(stock: StockOnHand): Decimal {
  return stock.quantity.isZero() ? new Decimal(0) : new Decimal(new Wide(stock.value).div(stock.quantity).toDecimalPlaces(6, Decimal.ROUND_HALF_UP).toFixed());
}

/** Stock after goods come in with their value. */
export function receive(stock: StockOnHand, quantity: Decimal, value: Decimal): StockOnHand {
  return { quantity: stock.quantity.plus(quantity), value: stock.value.plus(value) };
}

/**
 * Takes a quantity out of stock: what it is worth at the weighted-average cost, and what is
 * left. Refused when there is not enough: stock never goes below zero.
 */
export function issue(stock: StockOnHand, quantity: Decimal): { ok: true; value: Decimal; left: StockOnHand } | { ok: false; short: Decimal } {
  if (!quantity.isFinite() || quantity.lte(0)) return { ok: false, short: new Decimal(0) };
  if (quantity.gt(stock.quantity)) return { ok: false, short: quantity.minus(stock.quantity) };
  // Rounded once, from the exact quotient, the way the database rounds it.
  // Never more than the stock is worth: a value below a paisa cannot round up past itself.
  const value = quantity.eq(stock.quantity) ? stock.value : Decimal.min(new Decimal(new Wide(stock.value).times(quantity).div(stock.quantity).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed()), stock.value);
  return { ok: true, value, left: { quantity: stock.quantity.minus(quantity), value: stock.value.minus(value) } };
}

/** How much of an order line is still to be delivered. */
export function remainingToDeliver(ordered: Decimal, delivered: Decimal): Decimal {
  return Decimal.max(ordered.minus(delivered), 0);
}

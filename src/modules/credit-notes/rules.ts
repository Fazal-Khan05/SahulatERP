import Decimal from "decimal.js";
import { cleanText } from "@/lib/text";
import { isIsoDate } from "@/modules/currencies/rules";
import { parseQuantity } from "@/modules/items/rules";
import { MAX_SALES_LINES } from "@/modules/sales/rules";

// Pure rules for credit notes. No I/O.
//
// A credit note takes back part of one posted sales invoice, line by line: so many of what a
// line billed, of which so many came back damaged. What a line of it comes to is not worked
// out afresh from a price and a tax rate: it is the invoice line's own value and tax, in the
// proportion of the quantity that has come back. The database works the same figures out when
// the credit note is posted and refuses one that differs, so the arithmetic here is the
// arithmetic of app.credit_note_share in drizzle/0023_credit_notes.sql, digit for digit.

// Wide enough that nothing here is ever rounded by the precision: the figures have at most
// twenty digits, and the products of three of them sixty.
const Wide = Decimal.clone({ precision: 80 });
const NIL = new Decimal(0);

const typed = (value: unknown) => (typeof value === "string" ? value.trim() : "");
const isNil = (text: string) => /^0+(\.0+)?$/.test(text);

/**
 * One figure of a line of a credit note. Every credit note brings what has been taken back of
 * `whole` (the invoice line's figure) up to its exact share for `upto` of `of` (all that has
 * come back so far, this credit note included, of what was invoiced), rounded to the paisa,
 * half up; this credit note's part is that, less `gone` (what earlier credit notes took). So
 * however a line comes back, what has been credited is never more than half a paisa from the
 * exact share, and the credit notes of a line that has all come back are exactly the line.
 */
export function creditShare(whole: Decimal, gone: Decimal, upto: Decimal, of: Decimal): Decimal {
  if (upto.gte(of)) return whole.minus(gone);
  // Whole-number arithmetic, as the database does it: floor((200 * whole * upto + of) / (2 * of)) / 100.
  const share = new Wide(whole).times(upto).times(200).plus(of).dividedToIntegerBy(new Wide(of).times(2)).dividedBy(100);
  return Decimal.min(new Decimal(share.toString()), whole).minus(gone);
}

/** What a line of an invoice billed, as far as a credit note needs it. */
export type InvoicedLine = {
  quantity: Decimal;
  unitFactor: Decimal;
  unitPrice: Decimal;
  value: Decimal;
  taxAmount: Decimal;
  furtherTaxAmount: Decimal;
  extraTaxAmount: Decimal;
};

/** What earlier, posted credit notes took of one line of an invoice. */
export type Returned = { quantity: Decimal; value: Decimal; taxAmount: Decimal; furtherTaxAmount: Decimal; extraTaxAmount: Decimal };

export const NOTHING_RETURNED: Returned = { quantity: NIL, value: NIL, taxAmount: NIL, furtherTaxAmount: NIL, extraTaxAmount: NIL };

/** How much of an invoice line can still come back, in the unit it was sold in; never below nil. */
export function stillToReturn(line: Pick<InvoicedLine, "quantity">, returned: Pick<Returned, "quantity">): Decimal {
  return Decimal.max(line.quantity.minus(returned.quantity), 0);
}

export type CreditFigures = { gross: Decimal; discountAmount: Decimal; value: Decimal; taxAmount: Decimal; furtherTaxAmount: Decimal; extraTaxAmount: Decimal; total: Decimal };

/**
 * What a line of a credit note comes to, for `quantity` of an invoice line of which earlier
 * credit notes took `returned`. The caller has checked that no more comes back than is left.
 */
export function creditFigures(line: InvoicedLine, returned: Returned, quantity: Decimal, pricesIncludeTax: boolean): CreditFigures {
  const upto = returned.quantity.plus(quantity);
  const part = (whole: Decimal, gone: Decimal) => creditShare(whole, gone, upto, line.quantity);
  const value = part(line.value, returned.value);
  const taxAmount = part(line.taxAmount, returned.taxAmount);
  const furtherTaxAmount = part(line.furtherTaxAmount, returned.furtherTaxAmount);
  const extraTaxAmount = part(line.extraTaxAmount, returned.extraTaxAmount);
  const gross = quantity.times(line.unitPrice).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  // The discount shown is what lies between the quantity at the price and what the line comes to.
  const net = pricesIncludeTax ? value.plus(taxAmount).plus(furtherTaxAmount) : value;
  return {
    gross,
    discountAmount: Decimal.max(gross.minus(net), 0),
    value,
    taxAmount,
    furtherTaxAmount,
    extraTaxAmount,
    total: value.plus(taxAmount).plus(furtherTaxAmount).plus(extraTaxAmount),
  };
}

export type CreditTotals = { gross: Decimal; discount: Decimal; value: Decimal; tax: Decimal; furtherTax: Decimal; extraTax: Decimal; total: Decimal };

/** What the lines of a credit note come to together. */
export function creditTotals(lines: readonly CreditFigures[]): CreditTotals {
  const sum = (pick: (line: CreditFigures) => Decimal) => lines.reduce((total, line) => total.plus(pick(line)), NIL);
  return {
    gross: sum((line) => line.gross),
    discount: sum((line) => line.discountAmount),
    value: sum((line) => line.value),
    tax: sum((line) => line.taxAmount),
    furtherTax: sum((line) => line.furtherTaxAmount),
    extraTax: sum((line) => line.extraTaxAmount),
    total: sum((line) => line.total),
  };
}

/** Whether a quantity sold in a unit of this size is a quantity the item's own unit can hold (four decimals). */
export function fitsBaseUnit(quantity: Decimal, unitFactor: Decimal): boolean {
  return quantity.times(unitFactor).decimalPlaces() <= 4;
}

export type RawCreditNote = { date?: unknown; notes?: unknown; reference?: unknown; lines?: readonly { sourceLineId?: unknown; quantity?: unknown; damaged?: unknown }[] };
/** `reference` is the customer's own number for the return: a registered buyer's debit note. */
export type CreditNoteDraft = { date: string; notes: string | null; reference: string | null; lines: { sourceLineId: string; quantity: Decimal; damaged: Decimal }[] };

/**
 * Cleans what was typed for a credit note: a date, why, and for each line of the invoice how
 * much came back and how much of that is damaged. A line left empty or at nil is not returned.
 */
export function readCreditNote(raw: RawCreditNote): { ok: true; creditNote: CreditNoteDraft } | { ok: false; reason: string } {
  if (!isIsoDate(raw.date)) return { ok: false, reason: "Enter the date of the credit note." };
  const notes = cleanText(raw.notes);
  if (notes.length > 1000) return { ok: false, reason: "Reason: use at most 1,000 characters." };
  const reference = cleanText(raw.reference);
  if (reference.length > 60) return { ok: false, reason: "Customer's debit note: use at most 60 characters." };
  const lines: CreditNoteDraft["lines"] = [];
  for (const row of raw.lines ?? []) {
    const sourceLineId = typed(row.sourceLineId);
    const returned = typed(row.quantity);
    const damagedText = typed(row.damaged);
    if (sourceLineId === "") continue;
    if (returned === "" || isNil(returned)) {
      if (damagedText !== "" && !isNil(damagedText)) return { ok: false, reason: `Line ${lines.length + 1}: enter how much came back before how much of it is damaged.` };
      continue;
    }
    const quantity = parseQuantity(returned);
    if (!quantity.ok) return { ok: false, reason: `Line ${lines.length + 1}, returned: ${quantity.reason}` };
    let damaged = NIL;
    if (damagedText !== "" && !isNil(damagedText)) {
      const parsed = parseQuantity(damagedText);
      if (!parsed.ok) return { ok: false, reason: `Line ${lines.length + 1}, damaged: ${parsed.reason}` };
      damaged = parsed.value;
    }
    if (damaged.gt(quantity.value)) return { ok: false, reason: `Line ${lines.length + 1}: no more can be damaged than came back.` };
    if (lines.some((line) => line.sourceLineId === sourceLineId)) return { ok: false, reason: "A line of the invoice is on the credit note twice." };
    lines.push({ sourceLineId, quantity: quantity.value, damaged });
  }
  if (lines.length > MAX_SALES_LINES) return { ok: false, reason: `A document can have at most ${MAX_SALES_LINES} lines.` };
  return { ok: true, creditNote: { date: raw.date, notes: notes === "" ? null : notes, reference: reference === "" ? null : reference, lines } };
}

/** What a posted credit note has not yet been set against any invoice: the customer's credit. */
export function creditLeft(total: Decimal, settled: readonly { amount: Decimal }[]): Decimal {
  return Decimal.max(total.minus(settled.reduce((sum, row) => sum.plus(row.amount), NIL)), 0);
}

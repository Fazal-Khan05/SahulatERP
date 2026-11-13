import Decimal from "decimal.js";
import { describe, expect, it } from "vitest";
import { DEFAULT_SALE_TYPES, furtherTaxReason, taxLine, type BuyerTax, type DatedTaxRate, type TaxCategoryForLine, type TaxLineInput } from "./rules";

const d = (value: string | number) => new Decimal(value);

// The categories a company starts with, a reduced-rate one of its own with the schedule that
// gives the rate, and a zero-rated one on which the company has put further tax.
const category = (id: string, kind: TaxCategoryForLine["kind"], sroScheduleNo: string | null = null, sroItemSerial: string | null = null): TaxCategoryForLine => ({ id, kind, sroScheduleNo, sroItemSerial });
const STANDARD = category("std", "standard");
const REDUCED = category("red", "reduced", "Eighth Schedule", "24");
const THIRD = category("third", "third_schedule", "Third Schedule", null);
// A Third Schedule item on which, for the sake of the sums, further tax is charged as well.
const THIRD_WITH_FURTHER = category("third-f", "third_schedule", "Third Schedule", null);
const ZERO = category("zero", "zero_rated");
const ZERO_WITH_FURTHER = category("zero-f", "zero_rated");
const EXEMPT = category("exempt", "exempt");
const rate = (categoryId: string, effectiveFrom: string, percent: string, further: string): DatedTaxRate => ({ categoryId, effectiveFrom, rate: d(percent), furtherTaxRate: d(further) });
const RATES = [
  rate("std", "2024-07-01", "17", "3"),
  rate("std", "2026-07-01", "18", "4"),
  rate("red", "2026-07-01", "5", "4"),
  rate("third", "2026-07-01", "18", "0"),
  rate("third-f", "2026-07-01", "18", "4"),
  rate("zero", "2026-07-01", "0", "0"),
  rate("zero-f", "2026-07-01", "0", "4"),
  rate("exempt", "2026-07-01", "0", "0"),
];

const ACTIVE: BuyerTax = { registrationType: "registered", atlStatus: "active" };
const INACTIVE: BuyerTax = { registrationType: "registered", atlStatus: "inactive" };
const NOT_CHECKED: BuyerTax = { registrationType: "registered", atlStatus: "unknown" };
const UNREGISTERED: BuyerTax = { registrationType: "unregistered", atlStatus: "unknown" };
const END_CONSUMER: BuyerTax = { registrationType: "unregistered", atlStatus: "unknown", furtherTaxExcluded: true };

type Case = {
  name: string;
  category?: TaxCategoryForLine | null;
  buyer?: BuyerTax;
  quantity?: string;
  price?: string;
  discount?: string;
  retailPrice?: string | null;
  date?: string;
  inclusive?: boolean;
  registered?: boolean;
  saleType?: string | null;
  standardCategory?: TaxCategoryForLine | null;
  perUnitSold?: string;
  rates?: DatedTaxRate[];
};
const input = (c: Case): TaxLineInput => ({
  seller: { salesTaxRegistered: c.registered ?? true, pricesIncludeTax: c.inclusive ?? false },
  buyer: c.buyer ?? ACTIVE,
  item: { category: c.category === undefined ? STANDARD : c.category, retailPrice: c.retailPrice === undefined || c.retailPrice === null ? null : d(c.retailPrice), saleType: c.saleType ?? null },
  date: c.date ?? "2026-11-13",
  currency: "PKR",
  quantity: d(c.quantity ?? "10"),
  unitPrice: d(c.price ?? "1000"),
  discount: c.discount === undefined ? undefined : d(c.discount),
  unitsPerUnitSold: c.perUnitSold === undefined ? undefined : d(c.perUnitSold),
  rates: c.rates ?? RATES,
  standardCategory: c.standardCategory === undefined ? STANDARD : c.standardCategory,
});
/** value | rate | tax | further rate | further tax | total, to the paisa. */
const worked = (c: Case): string => {
  const result = taxLine(input(c));
  if (!result.ok) return `refused: ${result.reason}`;
  const l = result.line;
  return [l.value.toFixed(2), l.rate.toFixed(), l.taxAmount.toFixed(2), l.furtherTaxRate.toFixed(), l.furtherTaxAmount.toFixed(2), l.total.toFixed(2)].join(" | ");
};

describe("the tax engine", () => {
  // Ten of an item at 1,000 each unless a case says otherwise.
  const table: [Case, string][] = [
    // Standard rate, by who the buyer is.
    [{ name: "1 standard rate, registered buyer on the active list" }, "10000.00 | 18 | 1800.00 | 0 | 0.00 | 11800.00"],
    [{ name: "2 standard rate, buyer not registered: further tax", buyer: UNREGISTERED }, "10000.00 | 18 | 1800.00 | 4 | 400.00 | 12200.00"],
    [{ name: "3 standard rate, registered buyer not on the active list: further tax", buyer: INACTIVE }, "10000.00 | 18 | 1800.00 | 4 | 400.00 | 12200.00"],
    [{ name: "4 standard rate, registered buyer whose status was never checked: further tax", buyer: NOT_CHECKED }, "10000.00 | 18 | 1800.00 | 4 | 400.00 | 12200.00"],
    [{ name: "5 standard rate, a supply the law takes out of further tax", buyer: END_CONSUMER }, "10000.00 | 18 | 1800.00 | 0 | 0.00 | 11800.00"],
    // The rate in force on the document's date.
    [{ name: "6 a document dated before the rate changed keeps the old rate", date: "2026-06-30", buyer: UNREGISTERED }, "10000.00 | 17 | 1700.00 | 3 | 300.00 | 12000.00"],
    [{ name: "7 the day a rate starts, it applies", date: "2026-07-01" }, "10000.00 | 18 | 1800.00 | 0 | 0.00 | 11800.00"],
    [{ name: "8 a date before any rate: refused, never guessed", date: "2024-06-30" }, "refused: No tax rate is in force for this item's category on 30-06-2024. Add the rate under Settings, Tax."],
    // An item with no category of its own.
    [{ name: "9 no category on the item: the standard rate", category: null }, "10000.00 | 18 | 1800.00 | 0 | 0.00 | 11800.00"],
    [{ name: "10 no category and no standard category to fall back on: refused", category: null, standardCategory: null }, "refused: This company has no standard-rate tax category to fall back on. Set the item's tax category."],
    // Reduced rate under a schedule.
    [{ name: "11 reduced rate, registered active buyer", category: REDUCED }, "10000.00 | 5 | 500.00 | 0 | 0.00 | 10500.00"],
    [{ name: "12 reduced rate, buyer not registered: further tax on top", category: REDUCED, buyer: UNREGISTERED }, "10000.00 | 5 | 500.00 | 4 | 400.00 | 10900.00"],
    // Zero-rated and exempt.
    [{ name: "13 zero-rated, registered buyer", category: ZERO }, "10000.00 | 0 | 0.00 | 0 | 0.00 | 10000.00"],
    [{ name: "14 zero-rated, buyer not registered: no further tax where the category carries none", category: ZERO, buyer: UNREGISTERED }, "10000.00 | 0 | 0.00 | 0 | 0.00 | 10000.00"],
    [{ name: "15 zero-rated category on which the company has put further tax", category: ZERO_WITH_FURTHER, buyer: UNREGISTERED }, "10000.00 | 0 | 0.00 | 4 | 400.00 | 10400.00"],
    [{ name: "16 exempt, buyer not registered: no tax of any kind", category: EXEMPT, buyer: UNREGISTERED }, "10000.00 | 0 | 0.00 | 0 | 0.00 | 10000.00"],
    // Third Schedule: taxed on the retail price (the price before sales tax), whatever the goods sell for.
    [{ name: "17 Third Schedule, sold at 800 with a retail price of 1,000: tax on the 1,000", category: THIRD, price: "800", retailPrice: "1000" }, "8000.00 | 18 | 1800.00 | 0 | 0.00 | 9800.00"],
    [{ name: "18 Third Schedule, buyer not registered: no further tax", category: THIRD, price: "800", retailPrice: "1000", buyer: UNREGISTERED }, "8000.00 | 18 | 1800.00 | 0 | 0.00 | 9800.00"],
    [{ name: "19 Third Schedule with no retail price on the item: refused", category: THIRD, price: "800" }, "refused: This item is taxed on its retail price. Set the retail price on the item."],
    // Prices that already include the tax.
    [{ name: "20 price includes tax, registered active buyer: 18 parts in 118", inclusive: true, price: "1180" }, "10000.00 | 18 | 1800.00 | 0 | 0.00 | 11800.00"],
    [{ name: "21 price includes tax, buyer not registered: 18 and 4 parts in 122", inclusive: true, price: "1220", buyer: UNREGISTERED }, "10000.00 | 18 | 1800.00 | 4 | 400.00 | 12200.00"],
    [{ name: "22 price includes tax, an amount that does not divide evenly", inclusive: true, quantity: "3", price: "999.99" }, "2542.35 | 18 | 457.62 | 0 | 0.00 | 2999.97"],
    [{ name: "23 price includes tax, Third Schedule: the tax is the fixed sum inside the price", inclusive: true, category: THIRD, price: "1180", retailPrice: "1000" }, "10000.00 | 18 | 1800.00 | 0 | 0.00 | 11800.00"],
    [{ name: "24 price includes tax, exempt: the price is the value", inclusive: true, category: EXEMPT, buyer: UNREGISTERED }, "10000.00 | 0 | 0.00 | 0 | 0.00 | 10000.00"],
    // Discounts and rounding.
    [{ name: "25 a discount comes off before tax", discount: "500", buyer: UNREGISTERED }, "9500.00 | 18 | 1710.00 | 4 | 380.00 | 11590.00"],
    [{ name: "26 tax is rounded to the paisa, half up", quantity: "1", price: "0.25" }, "0.25 | 18 | 0.05 | 0 | 0.00 | 0.30"],
    [{ name: "27 a line that does not come to whole paisas is rounded once, then taxed", quantity: "3", price: "33.335" }, "100.01 | 18 | 18.00 | 0 | 0.00 | 118.01"],
    // A line sold by the carton: priced as entered, with the retail price brought to the cartons sold.
    [{ name: "30 1,200 cartons of 12 at 1,000 a carton come to exactly 1,200,000", quantity: "1200", perUnitSold: "12" }, "1200000.00 | 18 | 216000.00 | 0 | 0.00 | 1416000.00"],
    [{ name: "31 Third Schedule by the carton of 12: the retail price of one, times twelve, times the cartons", category: THIRD, quantity: "5", price: "9000", retailPrice: "1000", perUnitSold: "12" }, "45000.00 | 18 | 10800.00 | 0 | 0.00 | 55800.00"],
    // Prices that include the tax, with further tax inside them too.
    [{ name: "32 price includes tax, reduced rate, buyer not registered: 5 and 4 parts in 109", inclusive: true, category: REDUCED, price: "1090", buyer: UNREGISTERED }, "10000.00 | 5 | 500.00 | 4 | 400.00 | 10900.00"],
    [{ name: "33 price includes tax, Third Schedule with further tax: the fixed tax first, then 4 parts in 104", inclusive: true, category: THIRD_WITH_FURTHER, price: "1180", retailPrice: "1000", buyer: UNREGISTERED }, "9615.38 | 18 | 1800.00 | 4 | 384.62 | 11800.00"],
    [{ name: "34 a registered buyer who is not active, on a sale the law takes out of further tax", buyer: { registrationType: "registered", atlStatus: "inactive", furtherTaxExcluded: true } }, "10000.00 | 18 | 1800.00 | 0 | 0.00 | 11800.00"],
    // Rows that contradict their category are not obeyed, and an exempt item needs no row at all.
    [{ name: "35 a zero-rated category whose row carries a rate: refused", category: ZERO, rates: [rate("zero", "2026-07-01", "18", "4")] }, "refused: This item's category is zero-rated but its rate is not nil. Correct the rate under Settings, Tax."],
    [{ name: "36 a standard category whose row carries no rate: refused", rates: [rate("std", "2026-07-01", "0", "0")] }, "refused: This item's category has no rate above nil. Correct the rate under Settings, Tax."],
    [{ name: "37 an exempt item with no rate row at all", category: EXEMPT, rates: [] }, "10000.00 | 0 | 0.00 | 0 | 0.00 | 10000.00"],
    [{ name: "38 no category on the item and a fallback that is not standard-rate: refused", category: null, standardCategory: EXEMPT }, "refused: The category used for items with none of their own must be a standard-rate one. Set the item's tax category."],
    // A company not registered for sales tax charges none, whatever the item or the buyer.
    [{ name: "28 seller not registered: no tax at all", registered: false, buyer: UNREGISTERED }, "10000.00 | 0 | 0.00 | 0 | 0.00 | 10000.00"],
    [{ name: "29 seller not registered: not even a Third Schedule item with no retail price is refused", registered: false, category: THIRD, inclusive: true }, "10000.00 | 0 | 0.00 | 0 | 0.00 | 10000.00"],
  ];

  it.each(table)("$0.name", (c, expected) => {
    expect(worked(c)).toBe(expected);
  });

  it("keeps every line adding up: value plus the taxes is the total, to the paisa", () => {
    for (const [c] of table) {
      const result = taxLine(input(c));
      if (!result.ok) continue;
      const l = result.line;
      expect(l.value.plus(l.taxAmount).plus(l.furtherTaxAmount).plus(l.extraTaxAmount).eq(l.total), c.name).toBe(true);
      for (const amount of [l.value, l.taxAmount, l.furtherTaxAmount, l.total]) expect(amount.decimalPlaces(), c.name).toBeLessThanOrEqual(2);
    }
    // Over many awkward prices, whether the price includes the tax or not.
    for (const inclusive of [true, false]) {
      for (let paisas = 1; paisas <= 2000; paisas += 7) {
        const result = taxLine(input({ name: "sweep", inclusive, quantity: "7", price: d(paisas).div(100).toFixed(2), buyer: UNREGISTERED }));
        if (!result.ok) throw new Error(result.reason);
        const l = result.line;
        expect(l.value.plus(l.taxAmount).plus(l.furtherTaxAmount).eq(l.total), `${paisas} ${inclusive}`).toBe(true);
        // A price that includes the tax is what the buyer pays, to the paisa.
        if (inclusive) expect(l.total.eq(d(paisas).div(100).times(7)), `${paisas}`).toBe(true);
        expect(l.value.isNegative()).toBe(false);
      }
    }
    // A price with the tax inside it and the same goods with the tax on top agree to the paisa:
    // take the value an inclusive line comes to, tax it on top, and the buyer pays the same.
    for (let paisas = 100; paisas <= 300000; paisas += 977) {
      const inside = taxLine(input({ name: "inside", inclusive: true, quantity: "1", price: d(paisas).div(100).toFixed(2), buyer: UNREGISTERED }));
      if (!inside.ok) throw new Error(inside.reason);
      const onTop = taxLine(input({ name: "on top", quantity: "1", price: inside.line.value.toFixed(2), buyer: UNREGISTERED }));
      if (!onTop.ok) throw new Error(onTop.reason);
      expect(onTop.line.total.minus(inside.line.total).abs().lte("0.01"), `${paisas}`).toBe(true);
    }
  });

  it("says what a line is for FBR, and where a special rate comes from", () => {
    const of = (c: Case) => {
      const result = taxLine(input(c));
      if (!result.ok) throw new Error(result.reason);
      return result.line;
    };
    expect(of({ name: "std" })).toMatchObject({ taxed: true, kind: "standard", categoryId: "std", saleType: "Goods at standard rate (default)", sroScheduleNo: null, sroItemSerial: null, retailPriceBase: null, currency: "PKR", rateFrom: "2026-07-01" });
    // The row that was used can be found again; a line with no tax used none.
    expect(of({ name: "old rate", date: "2026-06-30" }).rateFrom).toBe("2024-07-01");
    expect([of({ name: "exempt", category: EXEMPT }).rateFrom, of({ name: "no tax", registered: false }).rateFrom]).toEqual([null, null]);
    expect(of({ name: "reduced", category: REDUCED })).toMatchObject({ kind: "reduced", saleType: "Goods at Reduced Rate", sroScheduleNo: "Eighth Schedule", sroItemSerial: "24" });
    expect(of({ name: "third", category: THIRD, price: "800", retailPrice: "1000" })).toMatchObject({ kind: "third_schedule", saleType: "3rd Schedule Goods", sroScheduleNo: "Third Schedule" });
    expect(of({ name: "third base", category: THIRD, price: "800", retailPrice: "1000" }).retailPriceBase?.toFixed(2)).toBe("10000.00");
    expect(of({ name: "zero", category: ZERO }).saleType).toBe("Goods at zero-rate");
    expect(of({ name: "exempt", category: EXEMPT }).saleType).toBe("Exempt goods");
    // The item's own name for the sale wins over the default for its category.
    expect(of({ name: "own", saleType: "Steel melting and re-rolling" }).saleType).toBe("Steel melting and re-rolling");
    // A fallen-back item is recorded under the category that was used.
    expect(of({ name: "fallback", category: null })).toMatchObject({ categoryId: "std", kind: "standard" });
    expect(of({ name: "no tax", registered: false })).toMatchObject({ taxed: false, kind: null, categoryId: null, saleType: null });
    expect(Object.keys(DEFAULT_SALE_TYPES).sort()).toEqual(["exempt", "reduced", "standard", "third_schedule", "zero_rated"]);
  });

  it("says why further tax was added", () => {
    expect([furtherTaxReason(ACTIVE), furtherTaxReason(UNREGISTERED), furtherTaxReason(INACTIVE), furtherTaxReason(NOT_CHECKED), furtherTaxReason(END_CONSUMER)]).toEqual([null, "buyer_unregistered", "buyer_inactive", "buyer_not_checked", null]);
    // A buyer not registered but somehow marked active is still not registered.
    expect(furtherTaxReason({ registrationType: "unregistered", atlStatus: "active" })).toBe("buyer_unregistered");
    const result = taxLine(input({ name: "reason", buyer: NOT_CHECKED }));
    expect(result.ok && result.line.furtherTaxReason).toBe("buyer_not_checked");
    // No reason is given where no further tax is charged.
    const third = taxLine(input({ name: "third", category: THIRD, retailPrice: "1000", buyer: UNREGISTERED }));
    expect(third.ok && third.line.furtherTaxReason).toBeNull();
  });

  it("refuses what cannot be a line", () => {
    const refusal = (c: Case) => {
      const result = taxLine(input(c));
      return result.ok ? null : result.reason;
    };
    expect(refusal({ name: "none", quantity: "0" })).toBe("The quantity must be more than zero.");
    expect(refusal({ name: "negative", price: "-1" })).toBe("The price cannot be negative.");
    expect(refusal({ name: "discount", discount: "10000.01" })).toBe("The discount cannot be more than the line.");
    expect(refusal({ name: "negative discount", discount: "-1" })).toBe("The discount cannot be negative.");
    expect(refusal({ name: "nan", quantity: "NaN" })).toBe("The quantity must be more than zero.");
    expect(refusal({ name: "nan discount", discount: "NaN" })).toBe("The discount is not an amount.");
    expect(refusal({ name: "unit", perUnitSold: "0" })).toBe("The size of the unit sold must be more than zero.");
    // A discount of nothing is nothing, however it was arrived at; one a hair over the line is too much.
    expect(worked({ name: "minus nothing", discount: "-0" })).toBe("10000.00 | 18 | 1800.00 | 0 | 0.00 | 11800.00");
    expect(worked({ name: "a hair under", discount: "9999.996" })).toBe("0.00 | 18 | 0.00 | 0 | 0.00 | 0.00");
    expect(refusal({ name: "a hair over", discount: "10000.006" })).toBe("The discount cannot be more than the line.");
    // A price that includes tax cannot be less than the tax on the printed retail price.
    expect(refusal({ name: "under", inclusive: true, category: THIRD, price: "100", retailPrice: "1000" })).toBe("The price is less than the sales tax on the item's retail price.");
    // A whole discount leaves a line of nothing, taxed at nothing.
    expect(worked({ name: "free", discount: "10000" })).toBe("0.00 | 18 | 0.00 | 0 | 0.00 | 0.00");
  });
});

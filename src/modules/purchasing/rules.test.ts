import Decimal from "decimal.js";
import { describe, expect, it } from "vitest";
import { costLine, orderTotal, parseUnitCost, readOrder, readReceipt, receiptLines, stillToReceive, type OrderItem, type OrderLineToReceive } from "./rules";

const d = (value: string | number) => new Decimal(value);
const SUPPLIER = "11111111-1111-4111-8111-111111111111";
const WAREHOUSE = "22222222-2222-4222-8222-222222222222";
const LAMP = "33333333-3333-4333-8333-333333333333";
const PIECE = "44444444-4444-4444-8444-444444444444";
const CARTON = "55555555-5555-4555-8555-555555555555";

const lamp: OrderItem = { id: LAMP, code: "LT-1", name: "Lamp", archived: false, baseUnitId: PIECE, conversions: [{ unitId: CARTON, factor: d(24) }] };
const head = { date: "2026-10-05", supplierId: SUPPLIER, warehouseId: WAREHOUSE };

describe("what one costs", () => {
  it("is a plain number with up to four decimals, and may be nothing", () => {
    expect(parseUnitCost("1250")).toEqual({ ok: true, cost: d(1250) });
    expect(parseUnitCost(" 12.3456 ")).toEqual({ ok: true, cost: d("12.3456") });
    // A free sample still arrives.
    expect(parseUnitCost("0")).toEqual({ ok: true, cost: d(0) });
  });

  it("refuses commas, signs, a fifth decimal and nothing at all", () => {
    for (const typed of ["1,250", "-5", "+5", "12.34567", "", "abc", "1e3"]) expect(parseUnitCost(typed).ok, typed).toBe(false);
    expect(parseUnitCost("12345678901234").ok).toBe(false);
    expect(parseUnitCost(1250).ok).toBe(false);
  });
});

describe("a purchase order as typed", () => {
  it("is read into a draft, with empty rows left out and empty fields as nothing", () => {
    const read = readOrder({
      ...head,
      expectedOn: "",
      supplierReference: "  Q-77  ",
      note: "",
      lines: [
        { itemId: LAMP, unitId: CARTON, quantity: "3", unitCost: "2400" },
        { itemId: "", unitId: "", quantity: "", unitCost: "" },
        { itemId: LAMP, unitId: "", quantity: "10", unitCost: "101.5" },
      ],
    });
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.order).toMatchObject({ date: "2026-10-05", supplierId: SUPPLIER, warehouseId: WAREHOUSE, expectedOn: null, supplierReference: "Q-77", note: null });
    expect(read.order.lines.map((line) => [line.unitId, line.quantity.toFixed(), line.unitCost.toFixed()])).toEqual([
      [CARTON, "3", "2400"],
      [null, "10", "101.5"],
    ]);
  });

  it("says the first thing that is wrong, naming the line as it stands on the screen", () => {
    const reason = (raw: Parameters<typeof readOrder>[0]) => {
      const read = readOrder(raw);
      return read.ok ? "" : read.reason;
    };
    expect(reason({ ...head, date: "5 October" })).toBe("Enter the date of the order.");
    expect(reason({ ...head, supplierId: "" })).toBe("Choose the supplier.");
    expect(reason({ ...head, warehouseId: " " })).toBe("Choose the warehouse the goods are to arrive at.");
    expect(reason({ ...head, expectedOn: "2026-10-04" })).toBe("The goods cannot be expected before the order's date.");
    expect(reason({ ...head, lines: [{ itemId: "", quantity: "2", unitCost: "5" }] })).toBe("Line 1: choose an item.");
    expect(reason({ ...head, lines: [{ itemId: LAMP, quantity: "1", unitCost: "5" }, {}, { itemId: LAMP, quantity: "0", unitCost: "5" }] })).toBe("Line 2, quantity: The quantity must be more than zero.");
    expect(reason({ ...head, lines: [{ itemId: LAMP, quantity: "1", unitCost: "" }] })).toBe("Line 1, cost: Enter what one costs.");
  });

  it("holds no more than two hundred lines", () => {
    const line = { itemId: LAMP, quantity: "1", unitCost: "1" };
    expect(readOrder({ ...head, lines: Array.from({ length: 200 }, () => line) }).ok).toBe(true);
    expect(readOrder({ ...head, lines: Array.from({ length: 201 }, () => line) }).ok).toBe(false);
  });
});

describe("a line of an order worked out", () => {
  const draft = (over: { unitId?: string | null; quantity?: string; unitCost?: string }) => ({ itemId: LAMP, unitId: over.unitId ?? null, quantity: d(over.quantity ?? "1"), unitCost: d(over.unitCost ?? "1"), description: null });

  it("is in the item's own unit unless another is named, and comes to the quantity at the cost of one", () => {
    const own = costLine(draft({ quantity: "10", unitCost: "101.5" }), lamp);
    expect(own.ok && [own.line.unitId, own.line.unitFactor.toFixed(), own.line.baseQuantity.toFixed(), own.line.amount.toFixed(2), own.line.description]).toEqual([PIECE, "1", "10", "1015.00", "Lamp"]);
    // Three cartons of 24 at 2,400 a carton: 72 pieces, 7,200.
    const carton = costLine(draft({ unitId: CARTON, quantity: "3", unitCost: "2400" }), lamp);
    expect(carton.ok && [carton.line.unitId, carton.line.unitFactor.toFixed(), carton.line.baseQuantity.toFixed(), carton.line.amount.toFixed(2)]).toEqual([CARTON, "24", "72", "7200.00"]);
  });

  it("rounds a line to the paisa, half up, and the order is the sum of its lines", () => {
    const third = costLine(draft({ quantity: "3", unitCost: "33.3333" }), lamp);
    const half = costLine(draft({ quantity: "0.5", unitCost: "0.01" }), lamp);
    expect(third.ok && third.line.amount.toFixed(2)).toBe("100.00");
    expect(half.ok && half.line.amount.toFixed(2)).toBe("0.01");
    if (third.ok && half.ok) expect(orderTotal([third.line, half.line]).toFixed(2)).toBe("100.01");
    expect(orderTotal([]).toFixed(2)).toBe("0.00");
  });

  it("refuses an archived item and a unit the item is not bought in", () => {
    const archived = costLine(draft({}), { ...lamp, archived: true });
    expect(archived.ok ? "" : archived.reason).toBe("LT-1 is archived. Restore the item before ordering it.");
    expect(costLine(draft({ unitId: SUPPLIER }), lamp).ok).toBe(false);
  });
});

describe("goods received against an order", () => {
  const line = (over: Partial<OrderLineToReceive>): OrderLineToReceive => ({ lineId: "a", lineNo: 1, itemId: LAMP, itemCode: "LT-1", description: "Lamp", unitCode: "pc", unitFactor: d(1), ordered: d(100), received: d(0), ...over });

  it("leaves what was ordered less what has arrived, never less than nothing", () => {
    expect(stillToReceive(line({ received: d(40) })).toFixed()).toBe("60");
    expect(stillToReceive(line({ received: d(100) })).toFixed()).toBe("0");
    expect(stillToReceive(line({ received: d(101) })).toFixed()).toBe("0");
  });

  it("is read as a day and what arrived of each line; a line left empty or at nil did not come", () => {
    const read = readReceipt({ date: "2026-10-09", supplierDeliveryNote: " DN-9 ", note: "", lines: [{ orderLineId: "a", quantity: "40" }, { orderLineId: "b", quantity: "" }, { orderLineId: "c", quantity: "0.00" }] });
    expect(read.ok && [read.receipt.date, read.receipt.supplierDeliveryNote, read.receipt.note, read.receipt.lines.map((row) => `${row.orderLineId}:${row.quantity.toFixed()}`)]).toEqual(["2026-10-09", "DN-9", null, ["a:40"]]);
    expect(readReceipt({ date: "", lines: [] }).ok).toBe(false);
    expect(readReceipt({ date: "2026-10-09", lines: [{ orderLineId: "a", quantity: "four" }] }).ok).toBe(false);
    const twice = readReceipt({ date: "2026-10-09", lines: [{ orderLineId: "a", quantity: "1" }, { orderLineId: "a", quantity: "2" }] });
    expect(twice.ok ? "" : twice.reason).toBe("A line of the order is on the goods received note twice.");
  });

  it("takes what arrived up to what is left, in the order's own line order, in the item's own unit", () => {
    const order = [line({ lineId: "a", lineNo: 1 }), line({ lineId: "b", lineNo: 2, itemCode: "LT-2", unitCode: "ctn", unitFactor: d(24), ordered: d(3), received: d(1) })];
    const worked = receiptLines(order, [
      { orderLineId: "b", quantity: d(2) },
      { orderLineId: "a", quantity: d(100) },
    ]);
    expect(worked.ok && worked.lines.map((row) => [row.orderLineId, row.quantity.toFixed(), row.baseQuantity.toFixed()])).toEqual([
      ["a", "100", "100"],
      ["b", "2", "48"],
    ]);
  });

  it("refuses more than is left, saying what was ordered and what has arrived", () => {
    const reason = (order: OrderLineToReceive[], quantity: string, lineId = "a") => {
      const worked = receiptLines(order, [{ orderLineId: lineId, quantity: d(quantity) }]);
      return worked.ok ? "" : worked.reason;
    };
    expect(reason([line({})], "100.0001")).toBe("LT-1: 100 was ordered, so 100.0001 cannot be received.");
    expect(reason([line({ received: d(40) })], "61")).toBe("LT-1: 100 was ordered and 40 has arrived, so only 60 more can be received.");
    expect(reason([line({})], "1", "z")).toBe("A line on the goods received note is not a line of its order.");
    // A third of a carton of 24.5 pieces is not a number of pieces four decimals can hold.
    expect(reason([line({ unitFactor: d("24.5"), ordered: d(10) })], "0.3333")).toBe("LT-1: use a quantity the item's own unit can hold, with fewer decimals.");
  });
});

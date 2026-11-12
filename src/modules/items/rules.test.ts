import Decimal from "decimal.js";
import { describe, expect, it } from "vitest";
import { readCsvTable } from "@/lib/csv-table";
import { cleanText, readYesNo } from "@/lib/text";
import {
  ITEM_IMPORT_MAX_ROWS,
  changedFields,
  lookup,
  parseFactor,
  parseQuantity,
  readCategoryName,
  readItem,
  readItemImport,
  readUnit,
  toBaseQuantity,
  type ItemLookups,
  type RawItem,
} from "./rules";

const d = (value: string) => new Decimal(value);
const PIECE = "11111111-1111-4111-8111-111111111111";
const CARTON = "22222222-2222-4222-8222-222222222222";
const DOZEN = "33333333-3333-4333-8333-333333333333";
const KG = "44444444-4444-4444-8444-444444444444";
const PARTS = "55555555-5555-4555-8555-555555555555";
const STANDARD = "66666666-6666-4666-8666-666666666666";

const known: ItemLookups = {
  units: lookup([
    { id: PIECE, name: "Piece", code: "pc" },
    { id: CARTON, name: "Carton", code: "ctn" },
    { id: DOZEN, name: "Dozen", code: "dz" },
    { id: KG, name: "Kilogram", code: "kg" },
  ]),
  categories: lookup([{ id: PARTS, name: "Engine parts" }]),
  taxCategories: lookup([{ id: STANDARD, name: "Standard rate" }]),
};
const problems = (raw: RawItem): string[] => {
  const read = readItem(raw, known);
  return read.ok ? [] : read.problems;
};

describe("toBaseQuantity", () => {
  const chain = { baseUnitId: PIECE, conversions: [{ unitId: CARTON, factor: d("24") }, { unitId: DOZEN, factor: d("12") }] };
  const base = (quantity: string, unit: string, item = chain) => {
    const result = toBaseQuantity(d(quantity), unit, item);
    return result.ok ? result.quantity.toFixed() : result.reason;
  };

  it("turns a line entered in cartons into pieces", () => {
    expect(base("3", CARTON)).toBe("72");
    expect(base("1", CARTON)).toBe("24");
    expect(base("0.5", CARTON)).toBe("12");
    expect(base("2.25", DOZEN)).toBe("27");
  });

  it("leaves a line entered in the item's own unit as it is", () => {
    expect(base("7", PIECE)).toBe("7");
    expect(base("0.0001", PIECE)).toBe("0.0001");
  });

  it("refuses a unit the item does not have, and a quantity that is not above zero", () => {
    expect(base("3", KG)).toBe("This item is not bought or sold in that unit.");
    expect(base("0", CARTON)).toBe("The quantity must be more than zero.");
    expect(base("-1", PIECE)).toBe("The quantity must be more than zero.");
  });

  it("refuses anything the database could not hold exactly, in any unit", () => {
    expect(base("1.23456", PIECE)).toBe("Use at most 4 digits after the point.");
    expect(base("NaN", PIECE)).toBe("The quantity must be more than zero.");
    expect(base("Infinity", CARTON)).toBe("The quantity must be more than zero.");
    expect(base("1000000000000", PIECE)).toBe("That quantity is too large.");
    expect(base("999999999999", CARTON)).toBe("That quantity is too large.");
    // A product with more digits than decimal.js keeps by default is still the exact one.
    const fine = { baseUnitId: PIECE, conversions: [{ unitId: CARTON, factor: d("1.000001") }] };
    expect(base("123456.0001", CARTON, fine)).toBe("That quantity does not come to an exact number of the item's own unit. Enter it in the item's own unit.");
    expect(base("99999999999.9999", CARTON, { baseUnitId: PIECE, conversions: [{ unitId: CARTON, factor: d("2") }] })).toBe("199999999999.9998");
  });

  it("stays exact, and refuses a result four decimals cannot hold", () => {
    // 0.1 and 0.2 are not exact as JS numbers; here they are.
    const grams = { baseUnitId: KG, conversions: [{ unitId: PIECE, factor: d("0.1") }] };
    expect(base("3", PIECE, grams)).toBe("0.3");
    const thirds = { baseUnitId: KG, conversions: [{ unitId: PIECE, factor: d("0.333333") }] };
    expect(base("1", PIECE, thirds)).toBe("That quantity does not come to an exact number of the item's own unit. Enter it in the item's own unit.");
    expect(base("0.0001", CARTON)).toBe("0.0024");
    expect(base("0.00001", CARTON)).toBe("Use at most 4 digits after the point.");
  });
});

describe("quantities and factors as typed", () => {
  it("reads a plain number above zero", () => {
    const quantity = parseQuantity(" 2.5 ");
    expect(quantity.ok && quantity.value.toFixed()).toBe("2.5");
    const factor = parseFactor("0.001");
    expect(factor.ok && factor.value.toFixed()).toBe("0.001");
  });

  it.each([
    ["", "Enter a number."],
    ["1,000", "Enter a plain number without commas, such as 12 or 2.5."],
    ["-3", "Enter a plain number without commas, such as 12 or 2.5."],
    ["1e3", "Enter a plain number without commas, such as 12 or 2.5."],
    ["0", "The quantity must be more than zero."],
    ["1.23456", "Use at most 4 digits after the point."],
    ["1234567890123", "That number is too large."],
  ])("refuses the quantity %j", (input, reason) => {
    expect(parseQuantity(input)).toEqual({ ok: false, reason });
  });

  it("refuses a factor of zero, too many decimals, or anything that is not text", () => {
    expect(parseFactor("0")).toEqual({ ok: false, reason: "The number of units must be more than zero." });
    expect(parseFactor("1.1234567")).toEqual({ ok: false, reason: "Use at most 6 digits after the point." });
    expect(parseFactor(24)).toEqual({ ok: false, reason: "Enter a number." });
  });
});

describe("units and categories", () => {
  it("reads a unit's short form and name", () => {
    expect(readUnit({ code: " ctn ", name: " Carton " })).toEqual({ ok: true, unit: { code: "ctn", name: "Carton" } });
    expect(readUnit({ code: "2x", name: "Pair" }).ok).toBe(false);
    expect(readUnit({ code: "a b", name: "Pair" }).ok).toBe(false);
    expect(readUnit({ code: "pr", name: "x" }).ok).toBe(false);
  });

  it("reads a category name", () => {
    expect(readCategoryName("  Engine   parts ")).toEqual({ ok: true, name: "Engine parts" });
    expect(readCategoryName("x").ok).toBe(false);
  });
});

describe("readItem", () => {
  it("needs a code, a name and a unit, and fills in the plain defaults", () => {
    expect(readItem({ code: "BP-100", name: " Brake   pad ", unit: "pc" }, known)).toEqual({
      ok: true,
      pack: null,
      item: {
        code: "BP-100",
        name: "Brake pad",
        categoryId: null,
        baseUnitId: PIECE,
        taxCategoryId: null,
        hsCode: null,
        fbrUomCode: null,
        saleType: null,
        retailPrice: null,
        reorderLevel: null,
        weight: null,
        volume: null,
        trackBatches: false,
        trackSerials: false,
      },
    });
    expect(problems({})).toEqual(["Enter the item's code.", "Enter the item's name.", "Unit: choose the unit the item is counted in."]);
  });

  it("finds the unit, category and tax category by id, by name or by short form", () => {
    const read = readItem(
      { code: "BP-100", name: "Brake pad", unit: PIECE, category: "ENGINE PARTS", taxCategory: "standard rate", hsCode: "8714.1090", fbrUomCode: "U1000069", saleType: "Goods at standard rate (default)", retailPrice: "1250.50", reorderLevel: "20", weight: "0.35", volume: "0.0012", trackBatches: "yes", trackSerials: "No", packUnit: "Carton", packSize: "24" },
      known,
    );
    expect(read).toMatchObject({
      ok: true,
      pack: { unitId: CARTON, factor: "24.000000" },
      item: { baseUnitId: PIECE, categoryId: PARTS, taxCategoryId: STANDARD, hsCode: "8714.1090", retailPrice: "1250.5000", reorderLevel: "20.0000", weight: "0.3500", volume: "0.0012", trackBatches: true, trackSerials: false },
    });
  });

  it("lists every problem at once, in plain words", () => {
    expect(
      problems({ code: "bad code", name: "x", unit: "box", category: "Tyres", taxCategory: "Luxury", hsCode: "87", retailPrice: "1,250", reorderLevel: "-5", weight: "heavy", trackBatches: "maybe", packUnit: "ctn" }),
    ).toEqual([
      "Code: use up to 30 letters, digits, dots, dashes or slashes, with no spaces.",
      "Enter the item's name.",
      'Unit: there is no unit called "box". Add it under Items, Units and categories first.',
      'Category: there is no category called "Tyres". Add it under Items, Units and categories first.',
      'Tax category: there is no tax category called "Luxury". Add it under Settings, Tax first.',
      "HS code: 4 to 10 digits, such as 8714.1090.",
      "Retail price: Enter the amount as a plain number without commas, such as 500000.",
      "Reorder level: Enter the amount as a plain number without commas, such as 500000.",
      "Weight: Enter the amount as a plain number without commas, such as 500000.",
      "Track batches: write Yes or No.",
      "Pack unit and Units per pack go together: fill in both or neither.",
    ]);
  });

  it("ties the pack to a second unit and a sensible size", () => {
    const item = { code: "BP-100", name: "Brake pad", unit: "pc" };
    expect(problems({ ...item, packUnit: "pc", packSize: "24" })).toEqual(["Pack unit: it must differ from the item's own unit."]);
    expect(problems({ ...item, packUnit: "ctn", packSize: "0" })).toEqual(["Units per pack: The number of units must be more than zero."]);
    expect(problems({ ...item, packUnit: "crate", packSize: "24" })).toEqual(['Pack unit: there is no pack unit called "crate". Add it under Items, Units and categories first.']);
  });

  it("lets an id win over a name, and a name over a short form, when one word could mean two units", () => {
    const BOX = "77777777-7777-4777-8777-777777777777";
    const BOX10 = "88888888-8888-4888-8888-888888888888";
    // "Box" is one unit's name and another's short form; a category is named like another's id.
    const clash: ItemLookups = {
      units: lookup([{ id: BOX10, name: "Box of 10", code: "box" }, { id: BOX, name: "Box", code: "bx" }]),
      categories: lookup([{ id: PARTS, name: STANDARD }, { id: STANDARD, name: "Tyres" }]),
      taxCategories: lookup([]),
    };
    const unitOf = (unit: string, category = "") => {
      const read = readItem({ code: "A1", name: "Thing", unit, category }, clash);
      return read.ok ? [read.item.baseUnitId, read.item.categoryId] : read.problems;
    };
    expect(unitOf("Box")).toEqual([BOX, null]);
    expect(unitOf("bx")).toEqual([BOX, null]);
    expect(unitOf("Box of 10")).toEqual([BOX10, null]);
    expect(unitOf(BOX10, STANDARD)).toEqual([BOX10, STANDARD]);
  });

  it("never takes a word every object answers to as a unit or category", () => {
    expect(problems({ code: "A1", name: "Thing", unit: "constructor" })).toHaveLength(1);
    expect(problems({ code: "A1", name: "Thing", unit: "pc", category: "toString" })).toHaveLength(1);
  });
});

describe("shared helpers", () => {
  it("cleans text and reads yes or no", () => {
    expect(cleanText("  a \n b ")).toBe("a b");
    expect(cleanText(42)).toBe("");
    expect([readYesNo("Yes"), readYesNo("on"), readYesNo(""), readYesNo("N"), readYesNo("maybe")]).toEqual([true, true, false, false, undefined]);
  });

  it("keeps only the fields that differ", () => {
    expect(changedFields({ a: 1, b: "x", c: null }, { a: 1, b: "y", c: 2 })).toEqual({ before: { b: "x", c: null }, after: { b: "y", c: 2 } });
  });

  it("reads a table by its headings and numbers rows as a spreadsheet does", () => {
    const columns = [{ key: "code", header: "Code" }, { key: "name", header: "Name" }] as const;
    const table = readCsvTable("\nname,CODE,,\nBrake pad,BP-100,,\n\n,BP-200,,stray\n", columns, "code", 10);
    expect(table).toEqual({
      ok: true,
      rows: [
        { row: 3, raw: { name: "Brake pad", code: "BP-100" }, extra: false },
        { row: 5, raw: { name: "", code: "BP-200" }, extra: true },
      ],
    });
    expect(readCsvTable("Name\nBrake pad\n", columns, "code", 10)).toEqual({ ok: false, reason: 'The file needs a "Code" column in its first row.' });
    expect(readCsvTable("Code,Price\nA,1\n", columns, "code", 10)).toEqual({ ok: false, reason: 'The column "Price" is not one this import knows. Rename or remove it.' });
    expect(readCsvTable("Code\nA\nB\nC\n", columns, "code", 2)).toEqual({ ok: false, reason: "The file has 3 rows. Import at most 2 at a time." });
  });
});

describe("readItemImport", () => {
  it("reads every good row and lists every bad one with its row number", () => {
    const csv = ["Code,Name,Unit,Category,Retail price,Pack unit,Units per pack", "BP-100,Brake pad,pc,Engine parts,1250,ctn,24", "BP-200,,pc,,,,", "bp-100,Brake pad again,pc,,,,", "BP-300,Chain,box,,,,", "BP-400,Sprocket,kg,,99.5,,"].join("\n");
    const read = readItemImport(csv, known);
    expect(read.status).toBe("read");
    if (read.status !== "read") return;
    expect(read.items.map((i) => [i.row, i.item.code, i.item.baseUnitId, i.pack?.factor ?? null])).toEqual([
      [2, "BP-100", PIECE, "24.000000"],
      [6, "BP-400", KG, null],
    ]);
    expect(read.problems).toEqual([
      { row: 3, name: "BP-200", problems: ["Enter the item's name."] },
      { row: 4, name: "Brake pad again", problems: ["The same code is in row 2."] },
      { row: 5, name: "Chain", problems: ['Unit: there is no unit called "box". Add it under Items, Units and categories first.'] },
    ]);
  });

  it("refuses a file it cannot use as a whole", () => {
    const reason = (csv: string) => {
      const read = readItemImport(csv, known);
      return read.status === "unreadable" ? read.reason : read.status;
    };
    expect(reason("")).toBe("The file is empty.");
    expect(reason("Name,Unit\nBrake pad,pc\n")).toBe('The file needs a "Code" column in its first row.');
    const many = ["Code,Name,Unit", ...Array.from({ length: ITEM_IMPORT_MAX_ROWS + 1 }, (_, i) => `I${i},Item ${i},pc`)].join("\n");
    expect(reason(many)).toBe(`The file has ${ITEM_IMPORT_MAX_ROWS + 1} rows. Import at most ${ITEM_IMPORT_MAX_ROWS} at a time.`);
  });
});

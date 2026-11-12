import Decimal from "decimal.js";
import { readCsvTable } from "@/lib/csv-table";
import { AMOUNT_SCALE, parseAmount } from "@/lib/money";
import { cleanText, readYesNo } from "@/lib/text";

// Pure rules for items, their categories, units and unit conversions. No I/O.
//
// An item is counted in one unit, its base unit: stock, reorder levels and costs are kept in it.
// It can also be bought or sold in other units, each worth a fixed number of base units (a
// carton of 24 pieces). A document line entered in such a unit is turned into base units by
// toBaseQuantity(); nothing else converts quantities. Quantities and factors are decimal.js
// values, never JS numbers.

/** Digits after the decimal point that a quantity keeps; the columns are numeric(20,4). */
export const QUANTITY_SCALE = 4;
/** Digits after the decimal point that a conversion factor keeps; numeric(20,6). */
export const FACTOR_SCALE = 6;

/** A quantity has at most twelve digits before the point. */
const QUANTITY_LIMIT = new Decimal("1e12");
/** decimal.js keeps 20 significant digits by default; twelve digits times twelve digits needs more. */
const Exact = Decimal.clone({ precision: 60 });

type Parsed = { ok: true; value: Decimal } | { ok: false; reason: string };

function parsePlain(input: unknown, scale: number, example: string): Parsed {
  const text = typeof input === "string" ? input.trim() : "";
  if (text === "") return { ok: false, reason: "Enter a number." };
  if (!/^\d+(\.\d+)?$/.test(text)) return { ok: false, reason: `Enter a plain number without commas, such as ${example}.` };
  const [whole, fraction = ""] = text.split(".");
  if (fraction.length > scale) return { ok: false, reason: `Use at most ${scale} digits after the point.` };
  if (whole.replace(/^0+/, "").length > 12) return { ok: false, reason: "That number is too large." };
  return { ok: true, value: new Decimal(text) };
}

/** A quantity as typed: a plain number above zero, at most four digits after the point. */
export function parseQuantity(input: unknown): Parsed {
  const parsed = parsePlain(input, QUANTITY_SCALE, "12 or 2.5");
  if (parsed.ok && parsed.value.lte(0)) return { ok: false, reason: "The quantity must be more than zero." };
  return parsed;
}

/** How many base units one of another unit holds: a plain number above zero. */
export function parseFactor(input: unknown): Parsed {
  const parsed = parsePlain(input, FACTOR_SCALE, "24");
  if (parsed.ok && parsed.value.lte(0)) return { ok: false, reason: "The number of units must be more than zero." };
  return parsed;
}

export type ItemUnits = {
  baseUnitId: string;
  /** One of `unitId` is worth `factor` base units. */
  conversions: readonly { unitId: string; factor: Decimal }[];
};

/**
 * A quantity entered in one of the item's units, as base units. Three cartons of 24 are 72
 * pieces. Refuses a unit the item does not have, and a result that cannot be held exactly in
 * four decimals: a quantity is never rounded behind anyone's back.
 */
export function toBaseQuantity(quantity: Decimal, unitId: string, item: ItemUnits): { ok: true; quantity: Decimal } | { ok: false; reason: string } {
  // Whatever the caller passes, only a quantity the database can hold exactly goes further.
  if (!quantity.isFinite() || quantity.lte(0)) return { ok: false, reason: "The quantity must be more than zero." };
  if (quantity.decimalPlaces() > QUANTITY_SCALE) return { ok: false, reason: `Use at most ${QUANTITY_SCALE} digits after the point.` };
  if (quantity.gte(QUANTITY_LIMIT)) return { ok: false, reason: "That quantity is too large." };
  if (unitId === item.baseUnitId) return { ok: true, quantity };
  const conversion = item.conversions.find((c) => c.unitId === unitId);
  if (!conversion) return { ok: false, reason: "This item is not bought or sold in that unit." };
  // Multiplied with digits to spare, so the product is the exact one, never a rounded one.
  const base = new Exact(quantity).mul(conversion.factor);
  if (base.decimalPlaces() > QUANTITY_SCALE) {
    return { ok: false, reason: "That quantity does not come to an exact number of the item's own unit. Enter it in the item's own unit." };
  }
  if (base.gte(QUANTITY_LIMIT)) return { ok: false, reason: "That quantity is too large." };
  return { ok: true, quantity: new Decimal(base.toFixed()) };
}

// ── Units and categories ────────────────────────────────────────────────────────────────────────

export function readUnit(raw: { code?: unknown; name?: unknown }): { ok: true; unit: { code: string; name: string } } | { ok: false; reason: string } {
  const code = cleanText(raw.code);
  const name = cleanText(raw.name);
  if (!/^[A-Za-z][A-Za-z0-9]{0,9}$/.test(code)) return { ok: false, reason: "Short form: up to 10 letters or digits, starting with a letter, such as pc or ctn." };
  if ([...name].length < 2 || name.length > 40) return { ok: false, reason: "Enter the unit's name, such as Piece or Carton." };
  return { ok: true, unit: { code, name } };
}

export function readCategoryName(raw: unknown): { ok: true; name: string } | { ok: false; reason: string } {
  const name = cleanText(raw);
  if ([...name].length < 2 || name.length > 60) return { ok: false, reason: "Enter the category's name, in 2 to 60 characters." };
  return { ok: true, name };
}

// ── Items ───────────────────────────────────────────────────────────────────────────────────────

/** An item as stored. Amounts and quantities are exact decimals as text. */
export type ItemInput = {
  code: string;
  name: string;
  categoryId: string | null;
  baseUnitId: string;
  taxCategoryId: string | null;
  hsCode: string | null;
  fbrUomCode: string | null;
  saleType: string | null;
  /** What one of the item's own unit sells for when no other price applies. */
  defaultPrice: string | null;
  retailPrice: string | null;
  reorderLevel: string | null;
  weight: string | null;
  volume: string | null;
  trackBatches: boolean;
  trackSerials: boolean;
};

/** A second unit given with the item in an import: one `unitId` holds `factor` base units. */
export type PackInput = { unitId: string; factor: string };

const FIELDS = [
  { key: "code", header: "Code" },
  { key: "name", header: "Name" },
  { key: "category", header: "Category" },
  { key: "unit", header: "Unit" },
  { key: "taxCategory", header: "Tax category" },
  { key: "hsCode", header: "HS code" },
  { key: "fbrUomCode", header: "FBR unit code" },
  { key: "saleType", header: "Sale type" },
  { key: "defaultPrice", header: "Selling price" },
  { key: "retailPrice", header: "Retail price" },
  { key: "reorderLevel", header: "Reorder level" },
  { key: "weight", header: "Weight" },
  { key: "volume", header: "Volume" },
  { key: "trackBatches", header: "Track batches" },
  { key: "trackSerials", header: "Track serials" },
  { key: "packUnit", header: "Pack unit" },
  { key: "packSize", header: "Units per pack" },
] as const;

export type ItemField = (typeof FIELDS)[number]["key"];
export type RawItem = Partial<Record<ItemField, unknown>>;
export const ITEM_COLUMNS: readonly { key: ItemField; header: string }[] = FIELDS;

/**
 * What a company already has, to match an item's unit, category and tax category against. Each
 * map is keyed by the id and by the lower-case name (and, for units, the short form), so the
 * form can send an id and a file can send a name.
 */
export type ItemLookups = { units: ReadonlyMap<string, string>; categories: ReadonlyMap<string, string>; taxCategories: ReadonlyMap<string, string> };

/**
 * Builds a lookup from rows: every id, name and short form leads to the row's id. Where one
 * word could mean two rows, an id wins over a name and a name over a short form, so the id the
 * form sends is never mistaken for a row that happens to be named like it.
 */
export function lookup(rows: readonly { id: string; name: string; code?: string | null }[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const row of rows) if (row.code) map.set(row.code.toLowerCase(), row.id);
  for (const row of rows) map.set(row.name.toLowerCase(), row.id);
  for (const row of rows) map.set(row.id, row.id);
  return map;
}

/**
 * Cleans one item, or lists everything wrong with it. Never guesses: a unit or category the
 * company does not have is a problem, not a new unit or category.
 */
export function readItem(raw: RawItem, known: ItemLookups): { ok: true; item: ItemInput; pack: PackInput | null } | { ok: false; problems: string[] } {
  const problems: string[] = [];
  const optional = (value: unknown, max: number, what: string): string | null => {
    const cleaned = cleanText(value);
    if (cleaned.length > max) problems.push(`${what}: use at most ${max} characters.`);
    return cleaned === "" ? null : cleaned;
  };
  const find = (value: unknown, map: ReadonlyMap<string, string>, what: string, where: string): string | null => {
    const cleaned = cleanText(value);
    if (cleaned === "") return null;
    const id = map.get(cleaned) ?? map.get(cleaned.toLowerCase());
    if (!id) problems.push(`${what}: there is no ${what.toLowerCase()} called "${cleaned.slice(0, 40)}". Add it under ${where} first.`);
    return id ?? null;
  };
  const amount = (value: unknown, what: string): string | null => {
    if (cleanText(value) === "") return null;
    const parsed = parseAmount(value);
    if (!parsed.ok) problems.push(`${what}: ${parsed.reason}`);
    return parsed.ok ? parsed.amount.toFixed(AMOUNT_SCALE) : null;
  };
  const yesNo = (value: unknown, what: string): boolean => {
    const read = readYesNo(value);
    if (read === undefined) problems.push(`${what}: write Yes or No.`);
    return read ?? false;
  };

  const code = cleanText(raw.code);
  if (code === "") problems.push("Enter the item's code.");
  else if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,29}$/.test(code)) problems.push("Code: use up to 30 letters, digits, dots, dashes or slashes, with no spaces.");
  const name = cleanText(raw.name);
  if ([...name].length < 2) problems.push("Enter the item's name.");
  else if (name.length > 160) problems.push("Name: use at most 160 characters.");

  const baseUnitId = find(raw.unit, known.units, "Unit", "Items, Units and categories");
  if (cleanText(raw.unit) === "") problems.push("Unit: choose the unit the item is counted in.");
  const categoryId = find(raw.category, known.categories, "Category", "Items, Units and categories");
  const taxCategoryId = find(raw.taxCategory, known.taxCategories, "Tax category", "Settings, Tax");

  let hsCode: string | null = null;
  if (cleanText(raw.hsCode) !== "") {
    const typed = cleanText(raw.hsCode).replace(/\s/g, "");
    if (/^\d{4}(\.?\d{2}){0,3}$/.test(typed) || /^\d{4}\.\d{4}$/.test(typed)) hsCode = typed;
    else problems.push("HS code: 4 to 10 digits, such as 8714.1090.");
  }
  const fbrUomCode = optional(raw.fbrUomCode, 40, "FBR unit code");
  const saleType = optional(raw.saleType, 60, "Sale type");
  const defaultPrice = amount(raw.defaultPrice, "Selling price");
  const retailPrice = amount(raw.retailPrice, "Retail price");
  const reorderLevel = amount(raw.reorderLevel, "Reorder level");
  const weight = amount(raw.weight, "Weight");
  const volume = amount(raw.volume, "Volume");
  const trackBatches = yesNo(raw.trackBatches, "Track batches");
  const trackSerials = yesNo(raw.trackSerials, "Track serials");

  let pack: PackInput | null = null;
  const packUnitTyped = cleanText(raw.packUnit) !== "";
  const packSizeTyped = cleanText(raw.packSize) !== "";
  if (packUnitTyped !== packSizeTyped) problems.push("Pack unit and Units per pack go together: fill in both or neither.");
  else if (packUnitTyped) {
    const unitId = find(raw.packUnit, known.units, "Pack unit", "Items, Units and categories");
    const factor = parseFactor(raw.packSize);
    if (!factor.ok) problems.push(`Units per pack: ${factor.reason}`);
    if (unitId && unitId === baseUnitId) problems.push("Pack unit: it must differ from the item's own unit.");
    else if (unitId && factor.ok) pack = { unitId, factor: factor.value.toFixed(FACTOR_SCALE) };
  }

  if (problems.length > 0 || !baseUnitId) return { ok: false, problems };
  return {
    ok: true,
    pack,
    item: { code, name, categoryId, baseUnitId, taxCategoryId, hsCode, fbrUomCode, saleType, defaultPrice, retailPrice, reorderLevel, weight, volume, trackBatches, trackSerials },
  };
}

/** The fields that differ between two versions of a record, for the audit row of an update. */
export function changedFields<T extends Record<string, unknown>>(before: T, after: T): { before: Partial<T>; after: Partial<T> } {
  const was: Record<string, unknown> = {};
  const now: Record<string, unknown> = {};
  for (const key of Object.keys(after)) {
    if (before[key] !== after[key]) {
      was[key] = before[key];
      now[key] = after[key];
    }
  }
  return { before: was as Partial<T>, after: now as Partial<T> };
}

// ── Reading an import file ──────────────────────────────────────────────────────────────────────

export const ITEM_IMPORT_MAX_ROWS = 2000;
export const ITEM_IMPORT_MAX_BYTES = 800 * 1024;

/** One row that cannot be imported. `row` is its row in the file as a spreadsheet numbers it. */
export type ImportProblem = { row: number; name: string; problems: string[] };

export type ItemImportRead =
  | { status: "unreadable"; reason: string }
  /** `items` are the rows that read cleanly; `problems` the rest. Nothing may be kept if there is any problem. */
  | { status: "read"; items: { row: number; item: ItemInput; pack: PackInput | null }[]; problems: ImportProblem[] };

/**
 * Reads a CSV file of items, each row checked exactly as the form would check it. A code used
 * twice in the file is a problem on the later row.
 */
export function readItemImport(csv: string, known: ItemLookups): ItemImportRead {
  const table = readCsvTable(csv, ITEM_COLUMNS, "code", ITEM_IMPORT_MAX_ROWS);
  if (!table.ok) return { status: "unreadable", reason: table.reason };
  const items: { row: number; item: ItemInput; pack: PackInput | null }[] = [];
  const problems: ImportProblem[] = [];
  const codesSeen = new Map<string, number>();
  for (const { row, raw, extra } of table.rows) {
    const found: string[] = [];
    if (extra) found.push("This row has more cells than the file has columns. Check for a stray comma.");
    const read = readItem(raw, known);
    if (!read.ok) found.push(...read.problems);
    const codeKey = cleanText(raw.code).toLowerCase();
    if (codeKey !== "") {
      const first = codesSeen.get(codeKey);
      if (first !== undefined) found.push(`The same code is in row ${first}.`);
      else codesSeen.set(codeKey, row);
    }
    if (found.length > 0) problems.push({ row, name: (cleanText(raw.name) || cleanText(raw.code)).slice(0, 120), problems: found });
    else if (read.ok) items.push({ row, item: read.item, pack: read.pack });
  }
  return { status: "read", items, problems };
}

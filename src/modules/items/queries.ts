import "server-only";
import Decimal from "decimal.js";
import { and, asc, eq, isNotNull, isNull, sql, type SQL } from "drizzle-orm";
import { isUuid, withTenant, type Tx } from "@/db";
import { UserError } from "@/lib/errors";
import { taxCategories } from "@/modules/tax/schema";
import { can, type TenantContext } from "@/modules/tenant/rules";
import { lookup, toBaseQuantity, type ItemInput, type ItemLookups } from "./rules";
import { itemCategories, itemUnits, items, units } from "./schema";

export function requireItemAccess(ctx: TenantContext): void {
  if (!can(ctx.role, "item.read")) throw new UserError("Your role does not include the item list.");
}

export type Named = { id: string; name: string; code?: string | null };

/** The company's units, item categories and tax categories, inside a transaction the caller holds. */
export async function selectItemSetup(tx: Tx, tenantId: string): Promise<{ units: Named[]; categories: Named[]; taxCategories: Named[]; known: ItemLookups }> {
  const [unitRows, categoryRows, taxRows] = await Promise.all([
    tx.select({ id: units.id, name: units.name, code: units.code }).from(units).where(eq(units.tenantId, tenantId)).orderBy(asc(sql`lower(${units.name})`)),
    tx.select({ id: itemCategories.id, name: itemCategories.name }).from(itemCategories).where(eq(itemCategories.tenantId, tenantId)).orderBy(asc(sql`lower(${itemCategories.name})`)),
    tx.select({ id: taxCategories.id, name: taxCategories.name }).from(taxCategories).where(eq(taxCategories.tenantId, tenantId)).orderBy(asc(taxCategories.kind), asc(taxCategories.name)),
  ]);
  return {
    units: unitRows,
    categories: categoryRows,
    taxCategories: taxRows,
    known: { units: lookup(unitRows), categories: lookup(categoryRows), taxCategories: lookup(taxRows) },
  };
}

/** What the item forms choose from. */
export async function getItemSetup(ctx: TenantContext) {
  requireItemAccess(ctx);
  return withTenant(ctx.userId, ctx.tenantId, (tx) => selectItemSetup(tx, ctx.tenantId));
}

export type StoredItem = {
  id: string;
  item: ItemInput;
  archivedAt: Date | null;
  updatedAt: Date;
  /** The other units the item is bought or sold in; one of each holds `factor` base units. */
  conversions: { unitId: string; code: string; name: string; factor: Decimal }[];
};

const itemColumns = {
  id: items.id,
  code: items.code,
  name: items.name,
  categoryId: items.categoryId,
  baseUnitId: items.baseUnitId,
  taxCategoryId: items.taxCategoryId,
  hsCode: items.hsCode,
  fbrUomCode: items.fbrUomCode,
  saleType: items.saleType,
  defaultPrice: items.defaultPrice,
  retailPrice: items.retailPrice,
  reorderLevel: items.reorderLevel,
  weight: items.weight,
  volume: items.volume,
  trackBatches: items.trackBatches,
  trackSerials: items.trackSerials,
  archivedAt: items.archivedAt,
  updatedAt: items.updatedAt,
};

/** One item with its conversions, inside a transaction the caller holds; null when it is not this company's. */
export async function selectItem(tx: Tx, tenantId: string, id: string): Promise<StoredItem | null> {
  const [[row], conversions] = await Promise.all([
    tx.select(itemColumns).from(items).where(and(eq(items.tenantId, tenantId), eq(items.id, id))),
    tx
      .select({ unitId: itemUnits.unitId, code: units.code, name: units.name, factor: itemUnits.factor })
      .from(itemUnits)
      .innerJoin(units, and(eq(units.tenantId, itemUnits.tenantId), eq(units.id, itemUnits.unitId)))
      .where(and(eq(itemUnits.tenantId, tenantId), eq(itemUnits.itemId, id)))
      .orderBy(asc(itemUnits.factor)),
  ]);
  if (!row) return null;
  const { id: itemId, archivedAt, updatedAt, ...item } = row;
  return { id: itemId, item, archivedAt, updatedAt, conversions: conversions.map((c) => ({ ...c, factor: new Decimal(c.factor) })) };
}

export async function getItem(ctx: TenantContext, id: string): Promise<StoredItem | null> {
  requireItemAccess(ctx);
  if (!isUuid(id)) return null;
  return withTenant(ctx.userId, ctx.tenantId, (tx) => selectItem(tx, ctx.tenantId, id));
}

export const ITEM_LIST_LIMIT = 200;

export type ItemListRow = {
  id: string;
  code: string;
  name: string;
  category: string | null;
  unit: string;
  defaultPrice: Decimal | null;
  retailPrice: Decimal | null;
  reorderLevel: Decimal | null;
};

/**
 * The list screen: live items, or the archived ones, by code. `search` matches part of the code,
 * name or category. Returns at most ITEM_LIST_LIMIT rows and says when there are more.
 */
export async function listItems(ctx: TenantContext, options: { search?: string; archived?: boolean }): Promise<{ rows: ItemListRow[]; more: boolean }> {
  requireItemAccess(ctx);
  const term = (options.search ?? "").replace(/[^\P{Cc}]/gu, " ").trim().slice(0, 80);
  // % and _ mean "anything" to LIKE; typed by a person they mean themselves.
  const pattern = `%${term.replace(/[\\%_]/g, "\\$&")}%`;
  const matches: SQL | undefined = term === "" ? undefined : sql`(${items.code} ilike ${pattern} or ${items.name} ilike ${pattern} or ${itemCategories.name} ilike ${pattern})`;
  const found = await withTenant(ctx.userId, ctx.tenantId, (tx) =>
    tx
      .select({ id: items.id, code: items.code, name: items.name, category: itemCategories.name, unit: units.code, defaultPrice: items.defaultPrice, retailPrice: items.retailPrice, reorderLevel: items.reorderLevel })
      .from(items)
      .innerJoin(units, and(eq(units.tenantId, items.tenantId), eq(units.id, items.baseUnitId)))
      .leftJoin(itemCategories, and(eq(itemCategories.tenantId, items.tenantId), eq(itemCategories.id, items.categoryId)))
      .where(and(eq(items.tenantId, ctx.tenantId), options.archived ? isNotNull(items.archivedAt) : isNull(items.archivedAt), matches))
      .orderBy(asc(sql`lower(${items.code})`))
      .limit(ITEM_LIST_LIMIT + 1),
  );
  return {
    more: found.length > ITEM_LIST_LIMIT,
    rows: found.slice(0, ITEM_LIST_LIMIT).map((row) => ({
      ...row,
      defaultPrice: row.defaultPrice === null ? null : new Decimal(row.defaultPrice),
      retailPrice: row.retailPrice === null ? null : new Decimal(row.retailPrice),
      reorderLevel: row.reorderLevel === null ? null : new Decimal(row.reorderLevel),
    })),
  };
}

/**
 * A quantity entered in one of an item's units, as the item's base units: three cartons of 24
 * are 72 pieces. What a document line will call. Refuses an item that is not this company's, a
 * unit the item does not have, and a result that is not exact.
 */
export async function convertToBase(
  ctx: TenantContext,
  itemId: string,
  unitId: string,
  quantity: Decimal,
): Promise<{ ok: true; quantity: Decimal; baseUnitId: string } | { ok: false; reason: string }> {
  requireItemAccess(ctx);
  if (!isUuid(itemId) || !isUuid(unitId)) return { ok: false, reason: "Choose an item and a unit." };
  const item = await withTenant(ctx.userId, ctx.tenantId, (tx) => selectItem(tx, ctx.tenantId, itemId));
  if (!item) return { ok: false, reason: "That item is not in this company." };
  const result = toBaseQuantity(quantity, unitId, { baseUnitId: item.item.baseUnitId, conversions: item.conversions });
  return result.ok ? { ...result, baseUnitId: item.item.baseUnitId } : result;
}

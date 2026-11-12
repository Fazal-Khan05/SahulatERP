import "server-only";
import Decimal from "decimal.js";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { isUuid, withTenant } from "@/db";
import { UserError } from "@/lib/errors";
import { isIsoDate } from "@/modules/currencies/rules";
import { items } from "@/modules/items/schema";
import { customers } from "@/modules/parties/schema";
import { can, type TenantContext } from "@/modules/tenant/rules";
import { priceInForce, resolvePrice, type PriceSource } from "./rules";
import { customerPrices, itemPricesByClass, priceListItems, priceLists } from "./schema";

export function requirePriceAccess(ctx: TenantContext): void {
  if (!can(ctx.role, "price.read")) throw new UserError("Your role does not include prices.");
}

export type PriceListRow = { id: string; name: string; isDefault: boolean; prices: number };

/** The company's price lists, the default first, each with how many prices it holds. */
export async function listPriceLists(ctx: TenantContext): Promise<PriceListRow[]> {
  requirePriceAccess(ctx);
  return withTenant(ctx.userId, ctx.tenantId, (tx) =>
    tx
      .select({
        id: priceLists.id,
        name: priceLists.name,
        isDefault: priceLists.isDefault,
        // Written out with its own names: inside this one-table select the columns of both
        // tables would otherwise be spelled the same and the count would compare a table with itself.
        prices: sql<number>`(select count(*)::int from public.price_list_items p where p.tenant_id = "price_lists"."tenant_id" and p.price_list_id = "price_lists"."id")`,
      })
      .from(priceLists)
      .where(eq(priceLists.tenantId, ctx.tenantId))
      .orderBy(desc(priceLists.isDefault), asc(sql`lower(${priceLists.name})`)),
  );
}

export type PriceRow = {
  id: string;
  /** What the price is for besides the item: the list's, class's or customer's name. */
  label: string;
  itemCode: string;
  itemName: string;
  price: Decimal;
  validFrom: string;
  validTo: string | null;
  /** True for the row that applies on the day asked about, among rows for the same thing. */
  inForce: boolean;
};

const PRICE_ROWS_LIMIT = 500;

type Selected = { id: string; group: string; label: string; itemCode: string; itemName: string; price: string; validFrom: string; validTo: string | null };

/** Marks, among rows for the same thing (`group`), the one in force on a date. */
function marked(rows: Selected[], on: string): PriceRow[] {
  const groups = new Map<string, Selected[]>();
  for (const row of rows) groups.set(row.group, [...(groups.get(row.group) ?? []), row]);
  const current = new Set([...groups.values()].map((group) => priceInForce(group, on)?.id));
  return rows.map((row) => ({
    id: row.id,
    label: row.label,
    itemCode: row.itemCode,
    itemName: row.itemName,
    price: new Decimal(row.price),
    validFrom: row.validFrom,
    validTo: row.validTo,
    inForce: current.has(row.id),
  }));
}

/** One price list with its prices, by item code then newest first. Null when it is not this company's. */
export async function getPriceList(ctx: TenantContext, id: string, on: string): Promise<{ id: string; name: string; isDefault: boolean; prices: PriceRow[]; more: boolean } | null> {
  requirePriceAccess(ctx);
  if (!isUuid(id)) return null;
  const [[list], rows] = await withTenant(ctx.userId, ctx.tenantId, (tx) =>
    Promise.all([
      tx.select({ id: priceLists.id, name: priceLists.name, isDefault: priceLists.isDefault }).from(priceLists).where(and(eq(priceLists.tenantId, ctx.tenantId), eq(priceLists.id, id))),
      tx
        .select({ id: priceListItems.id, group: priceListItems.itemId, label: sql<string>`''`, itemCode: items.code, itemName: items.name, price: priceListItems.price, validFrom: priceListItems.validFrom, validTo: priceListItems.validTo })
        .from(priceListItems)
        .innerJoin(items, and(eq(items.tenantId, priceListItems.tenantId), eq(items.id, priceListItems.itemId)))
        .where(and(eq(priceListItems.tenantId, ctx.tenantId), eq(priceListItems.priceListId, id)))
        .orderBy(asc(sql`lower(${items.code})`), desc(priceListItems.validFrom))
        .limit(PRICE_ROWS_LIMIT + 1),
    ]),
  );
  if (!list) return null;
  return { ...list, more: rows.length > PRICE_ROWS_LIMIT, prices: marked(rows.slice(0, PRICE_ROWS_LIMIT), on) };
}

/** Every special price of one item: on price lists, for classes and for single customers. */
export async function listItemPrices(ctx: TenantContext, itemId: string, on: string): Promise<{ lists: PriceRow[]; classes: PriceRow[]; customers: PriceRow[] }> {
  requirePriceAccess(ctx);
  if (!isUuid(itemId)) return { lists: [], classes: [], customers: [] };
  const shared = { itemCode: items.code, itemName: items.name };
  const [lists, classes, own] = await withTenant(ctx.userId, ctx.tenantId, (tx) =>
    Promise.all([
      tx
        .select({ id: priceListItems.id, group: priceListItems.priceListId, label: priceLists.name, ...shared, price: priceListItems.price, validFrom: priceListItems.validFrom, validTo: priceListItems.validTo })
        .from(priceListItems)
        .innerJoin(items, and(eq(items.tenantId, priceListItems.tenantId), eq(items.id, priceListItems.itemId)))
        .innerJoin(priceLists, and(eq(priceLists.tenantId, priceListItems.tenantId), eq(priceLists.id, priceListItems.priceListId)))
        .where(and(eq(priceListItems.tenantId, ctx.tenantId), eq(priceListItems.itemId, itemId)))
        .orderBy(asc(sql`lower(${priceLists.name})`), desc(priceListItems.validFrom)),
      tx
        .select({ id: itemPricesByClass.id, group: sql<string>`lower(${itemPricesByClass.customerClass})`, label: itemPricesByClass.customerClass, ...shared, price: itemPricesByClass.price, validFrom: itemPricesByClass.validFrom, validTo: itemPricesByClass.validTo })
        .from(itemPricesByClass)
        .innerJoin(items, and(eq(items.tenantId, itemPricesByClass.tenantId), eq(items.id, itemPricesByClass.itemId)))
        .where(and(eq(itemPricesByClass.tenantId, ctx.tenantId), eq(itemPricesByClass.itemId, itemId)))
        .orderBy(asc(sql`lower(${itemPricesByClass.customerClass})`), desc(itemPricesByClass.validFrom)),
      tx
        .select({ id: customerPrices.id, group: customerPrices.customerId, label: customers.name, ...shared, price: customerPrices.price, validFrom: customerPrices.validFrom, validTo: customerPrices.validTo })
        .from(customerPrices)
        .innerJoin(items, and(eq(items.tenantId, customerPrices.tenantId), eq(items.id, customerPrices.itemId)))
        .innerJoin(customers, and(eq(customers.tenantId, customerPrices.tenantId), eq(customers.id, customerPrices.customerId)))
        .where(and(eq(customerPrices.tenantId, ctx.tenantId), eq(customerPrices.itemId, itemId)))
        .orderBy(asc(sql`lower(${customers.name})`), desc(customerPrices.validFrom)),
    ]),
  );
  return { lists: marked(lists, on), classes: marked(classes, on), customers: marked(own, on) };
}

/**
 * The price a customer pays for one of an item's own unit on a date, and where it comes from:
 * the customer's own price, else the class price, else the customer's list (or the default
 * list), else the item's default. Null when the item has no price at any level, or the item or
 * customer is not this company's; a document must then ask, never guess. `customerId` null
 * means no particular customer, such as a walk-in sale.
 */
export async function getPriceFor(
  ctx: TenantContext,
  query: { itemId: string; customerId: string | null; date: string },
): Promise<{ price: Decimal; source: PriceSource; validFrom: string | null } | null> {
  requirePriceAccess(ctx);
  const { itemId, customerId, date } = query;
  if (!isUuid(itemId) || !isIsoDate(date) || (customerId !== null && !isUuid(customerId))) return null;
  return withTenant(ctx.userId, ctx.tenantId, async (tx) => {
    const [[item], [customer], [defaultList]] = await Promise.all([
      tx.select({ defaultPrice: items.defaultPrice }).from(items).where(and(eq(items.tenantId, ctx.tenantId), eq(items.id, itemId))),
      customerId === null
        ? Promise.resolve([])
        : tx.select({ customerClass: customers.customerClass, priceListId: customers.priceListId }).from(customers).where(and(eq(customers.tenantId, ctx.tenantId), eq(customers.id, customerId))),
      tx.select({ id: priceLists.id }).from(priceLists).where(and(eq(priceLists.tenantId, ctx.tenantId), eq(priceLists.isDefault, true))),
    ]);
    if (!item || (customerId !== null && !customer)) return null;
    const listId = customer?.priceListId ?? defaultList?.id ?? null;
    const columns = (t: typeof priceListItems | typeof itemPricesByClass | typeof customerPrices) => ({ price: t.price, validFrom: t.validFrom, validTo: t.validTo });
    const [own, byClass, onList] = await Promise.all([
      customerId === null
        ? Promise.resolve([])
        : tx.select(columns(customerPrices)).from(customerPrices).where(and(eq(customerPrices.tenantId, ctx.tenantId), eq(customerPrices.customerId, customerId), eq(customerPrices.itemId, itemId))),
      !customer?.customerClass
        ? Promise.resolve([])
        : tx
            .select(columns(itemPricesByClass))
            .from(itemPricesByClass)
            .where(and(eq(itemPricesByClass.tenantId, ctx.tenantId), eq(itemPricesByClass.itemId, itemId), sql`lower(${itemPricesByClass.customerClass}) = lower(${customer.customerClass})`)),
      listId === null
        ? Promise.resolve([])
        : tx.select(columns(priceListItems)).from(priceListItems).where(and(eq(priceListItems.tenantId, ctx.tenantId), eq(priceListItems.priceListId, listId), eq(priceListItems.itemId, itemId))),
    ]);
    const exact = (rows: { price: string; validFrom: string; validTo: string | null }[]) => rows.map((row) => ({ ...row, price: new Decimal(row.price) }));
    return resolvePrice({ customer: exact(own), class: exact(byClass), list: exact(onList), itemDefault: item.defaultPrice === null ? null : new Decimal(item.defaultPrice) }, date);
  });
}

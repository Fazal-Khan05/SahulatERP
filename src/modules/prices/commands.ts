import "server-only";
import { and, eq, isNull, sql } from "drizzle-orm";
import { audit, isUuid, withTenant, type Tx } from "@/db";
import { UserError, pgCode } from "@/lib/errors";
import { cleanText } from "@/lib/text";
import { items } from "@/modules/items/schema";
import { customers } from "@/modules/parties/schema";
import { can, type TenantContext } from "@/modules/tenant/rules";
import { readClass, readDatedPrice, readListName } from "./rules";
import { customerPrices, itemPricesByClass, priceListItems, priceLists } from "./schema";

// Prices are added, corrected and ended; never deleted. Saving a price that starts on the same
// day as one already there corrects it, and the audit row keeps both values.

const UNIQUE_VIOLATION = "23505";
const SAME_MOMENT = "Someone else saved a price for that day at the same moment. Check the list and try again.";

function requireManager(ctx: TenantContext): void {
  if (!can(ctx.role, "price.manage")) throw new UserError("Only an owner, an accountant or a sales manager can change prices.");
}

/** Adds a price list. The first list a company adds becomes its default. */
export async function createPriceList(ctx: TenantContext, rawName: unknown): Promise<{ id: string }> {
  requireManager(ctx);
  const read = readListName(rawName);
  if (!read.ok) throw new UserError(read.reason);
  try {
    return await withTenant(ctx.userId, ctx.tenantId, async (tx) => {
      const existing = await tx.select({ id: priceLists.id }).from(priceLists).where(eq(priceLists.tenantId, ctx.tenantId)).limit(1);
      const isDefault = existing.length === 0;
      const [row] = await tx.insert(priceLists).values({ tenantId: ctx.tenantId, name: read.name, isDefault, createdBy: ctx.userId }).returning({ id: priceLists.id });
      await audit(tx, ctx, { action: "price_list.create", entity: "price_list", entityId: row.id, after: { name: read.name, isDefault } });
      return row;
    });
  } catch (error) {
    if (pgCode(error) === UNIQUE_VIOLATION) {
      const e = error as { constraint_name?: string; cause?: { constraint_name?: string } };
      // Two first lists at the same moment both try to be the default; the name is not the problem.
      const byDefault = (e.cause?.constraint_name ?? e.constraint_name) === "price_lists_one_default_per_tenant";
      throw new UserError(byDefault ? "Another price list was added at the same moment. Try again." : "A price list with this name already exists.");
    }
    throw error;
  }
}

/** Makes a list the one used for customers who are on no list. */
export async function setDefaultPriceList(ctx: TenantContext, listId: unknown): Promise<void> {
  requireManager(ctx);
  if (!isUuid(listId)) throw new UserError("That price list is not in this company.");
  await withTenant(ctx.userId, ctx.tenantId, async (tx) => {
    const lists = await tx.select({ id: priceLists.id, name: priceLists.name, isDefault: priceLists.isDefault }).from(priceLists).where(eq(priceLists.tenantId, ctx.tenantId)).for("update");
    const chosen = lists.find((list) => list.id === listId);
    if (!chosen) throw new UserError("That price list is not in this company.");
    if (chosen.isDefault) return;
    const previous = lists.find((list) => list.isDefault);
    // The old default steps down first: the database allows only one at a time.
    if (previous) await tx.update(priceLists).set({ isDefault: false }).where(and(eq(priceLists.tenantId, ctx.tenantId), eq(priceLists.id, previous.id)));
    await tx.update(priceLists).set({ isDefault: true }).where(and(eq(priceLists.tenantId, ctx.tenantId), eq(priceLists.id, chosen.id)));
    await audit(tx, ctx, { action: "price_list.set_default", entity: "price_list", entityId: chosen.id, before: { default: previous?.name ?? null }, after: { default: chosen.name } });
  });
}

/** The live item with this code or id, or a refusal in plain words. */
async function findItem(tx: Tx, ctx: TenantContext, raw: unknown): Promise<{ id: string; code: string }> {
  const typed = cleanText(raw);
  if (typed === "") throw new UserError("Enter the item's code.");
  const [found] = await tx
    .select({ id: items.id, code: items.code })
    .from(items)
    .where(and(eq(items.tenantId, ctx.tenantId), isNull(items.archivedAt), isUuid(typed) ? eq(items.id, typed) : sql`lower(${items.code}) = lower(${typed})`));
  if (!found) throw new UserError(`There is no item with the code "${typed.slice(0, 30)}".`);
  return found;
}

type PriceTable = typeof priceListItems | typeof itemPricesByClass | typeof customerPrices;
type Dated = { price: string; validFrom: string; validTo: string | null };

/** Inserts a price, or corrects the one that starts on the same day, and writes the audit row. */
async function savePrice(
  tx: Tx,
  ctx: TenantContext,
  table: PriceTable,
  same: ReturnType<typeof and>,
  insert: () => Promise<{ id: string }[]>,
  described: Record<string, string>,
  dated: Dated,
): Promise<void> {
  const [existing] = await tx.select({ id: table.id, price: table.price, validTo: table.validTo }).from(table).where(same).for("update");
  let id: string;
  if (existing) {
    id = existing.id;
    await tx.update(table).set({ price: dated.price, validTo: dated.validTo, updatedAt: sql`now()`, updatedBy: ctx.userId }).where(same);
  } else {
    id = (await insert())[0].id;
  }
  await audit(tx, ctx, {
    action: "price.set",
    entity: "price",
    entityId: id,
    before: existing ? { ...described, validFrom: dated.validFrom, price: existing.price, validTo: existing.validTo } : null,
    after: { ...described, ...dated },
  });
}

function dated(raw: { price?: unknown; validFrom?: unknown; validTo?: unknown }): Dated {
  const read = readDatedPrice(raw);
  if (!read.ok) throw new UserError(read.reason);
  return { price: read.price, validFrom: read.validFrom, validTo: read.validTo };
}

const by = (ctx: TenantContext) => ({ tenantId: ctx.tenantId, createdBy: ctx.userId, updatedBy: ctx.userId });

async function guarded<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (pgCode(error) === UNIQUE_VIOLATION) throw new UserError(SAME_MOMENT);
    throw error;
  }
}

/** Sets an item's price on a price list from a date. */
export async function setListPrice(ctx: TenantContext, listId: unknown, raw: { item?: unknown; price?: unknown; validFrom?: unknown; validTo?: unknown }): Promise<void> {
  requireManager(ctx);
  if (!isUuid(listId)) throw new UserError("That price list is not in this company.");
  const price = dated(raw);
  await guarded(() =>
    withTenant(ctx.userId, ctx.tenantId, async (tx) => {
      const [list] = await tx.select({ name: priceLists.name }).from(priceLists).where(and(eq(priceLists.tenantId, ctx.tenantId), eq(priceLists.id, listId)));
      if (!list) throw new UserError("That price list is not in this company.");
      const item = await findItem(tx, ctx, raw.item);
      const same = and(eq(priceListItems.tenantId, ctx.tenantId), eq(priceListItems.priceListId, listId), eq(priceListItems.itemId, item.id), eq(priceListItems.validFrom, price.validFrom));
      await savePrice(tx, ctx, priceListItems, same, () => tx.insert(priceListItems).values({ ...by(ctx), priceListId: listId, itemId: item.id, ...price }).returning({ id: priceListItems.id }), { list: list.name, item: item.code }, price);
    }),
  );
}

/** Sets an item's price for every customer of one class from a date. */
export async function setClassPrice(ctx: TenantContext, raw: { item?: unknown; customerClass?: unknown; price?: unknown; validFrom?: unknown; validTo?: unknown }): Promise<void> {
  requireManager(ctx);
  const read = readClass(raw.customerClass);
  if (!read.ok) throw new UserError(read.reason);
  const price = dated(raw);
  await guarded(() =>
    withTenant(ctx.userId, ctx.tenantId, async (tx) => {
      const item = await findItem(tx, ctx, raw.item);
      const same = and(eq(itemPricesByClass.tenantId, ctx.tenantId), eq(itemPricesByClass.itemId, item.id), sql`lower(${itemPricesByClass.customerClass}) = lower(${read.customerClass})`, eq(itemPricesByClass.validFrom, price.validFrom));
      await savePrice(tx, ctx, itemPricesByClass, same, () => tx.insert(itemPricesByClass).values({ ...by(ctx), customerClass: read.customerClass, itemId: item.id, ...price }).returning({ id: itemPricesByClass.id }), { class: read.customerClass, item: item.code }, price);
    }),
  );
}

/** Sets one customer's own price for an item from a date. The customer is given by code, name or id. */
export async function setCustomerPrice(ctx: TenantContext, raw: { item?: unknown; customer?: unknown; price?: unknown; validFrom?: unknown; validTo?: unknown }): Promise<void> {
  requireManager(ctx);
  const typed = cleanText(raw.customer);
  if (typed === "") throw new UserError("Enter the customer's code or name.");
  const price = dated(raw);
  await guarded(() =>
    withTenant(ctx.userId, ctx.tenantId, async (tx) => {
      const matches = await tx
        .select({ id: customers.id, name: customers.name, code: customers.code })
        .from(customers)
        .where(and(eq(customers.tenantId, ctx.tenantId), isNull(customers.archivedAt), isUuid(typed) ? eq(customers.id, typed) : sql`(lower(${customers.code}) = lower(${typed}) or lower(${customers.name}) = lower(${typed}))`));
      // What was typed may be one customer's code and another's name. The code is the surer of the two.
      const customer = matches.find((row) => row.code?.toLowerCase() === typed.toLowerCase()) ?? matches[0];
      if (!customer) throw new UserError(`There is no customer with the code or name "${typed.slice(0, 40)}".`);
      const item = await findItem(tx, ctx, raw.item);
      const same = and(eq(customerPrices.tenantId, ctx.tenantId), eq(customerPrices.customerId, customer.id), eq(customerPrices.itemId, item.id), eq(customerPrices.validFrom, price.validFrom));
      await savePrice(tx, ctx, customerPrices, same, () => tx.insert(customerPrices).values({ ...by(ctx), customerId: customer.id, itemId: item.id, ...price }).returning({ id: customerPrices.id }), { customer: customer.name, item: item.code }, price);
    }),
  );
}

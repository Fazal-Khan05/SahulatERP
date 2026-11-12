import "server-only";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { audit, isUuid, withTenant, type Tx } from "@/db";
import { UserError, pgCode } from "@/lib/errors";
import { can, type TenantContext } from "@/modules/tenant/rules";
import { selectItem, selectItemSetup } from "./queries";
import {
  FACTOR_SCALE,
  changedFields,
  parseFactor,
  readCategoryName,
  readItem,
  readItemImport,
  readUnit,
  type ImportProblem,
  type ItemInput,
  type PackInput,
  type RawItem,
} from "./rules";
import { itemCategories, itemUnits, items, units } from "./schema";

// Items are added, changed, archived and restored; never deleted. Units and categories are
// written once. Every command writes its audit row in the same transaction as the change.

const UNIQUE_VIOLATION = "23505";
const INSERT_CHUNK = 250;
const NOT_HERE = "That item is not in this company.";
const UNIT_TAKEN = "A unit with this name or short form already exists.";

function requireManager(ctx: TenantContext): void {
  if (!can(ctx.role, "item.manage")) throw new UserError("Only an owner or an accountant can change items.");
}

/** Adds a unit, such as Piece (pc) or Carton (ctn). */
export async function addUnit(ctx: TenantContext, raw: { code?: unknown; name?: unknown }): Promise<{ id: string }> {
  requireManager(ctx);
  const read = readUnit(raw);
  if (!read.ok) throw new UserError(read.reason);
  try {
    return await withTenant(ctx.userId, ctx.tenantId, async (tx) => {
      // A name that is another unit's short form, or the reverse, would make a file's "Box" mean two units.
      const { units: existing } = await selectItemSetup(tx, ctx.tenantId);
      const words = new Set(existing.flatMap((unit) => [unit.name.toLowerCase(), (unit.code ?? "").toLowerCase()]));
      if (words.has(read.unit.name.toLowerCase()) || words.has(read.unit.code.toLowerCase())) throw new UserError(UNIT_TAKEN);
      const [row] = await tx.insert(units).values({ tenantId: ctx.tenantId, ...read.unit, createdBy: ctx.userId }).returning({ id: units.id });
      await audit(tx, ctx, { action: "unit.add", entity: "unit", entityId: row.id, after: read.unit });
      return row;
    });
  } catch (error) {
    if (pgCode(error) === UNIQUE_VIOLATION) throw new UserError(UNIT_TAKEN);
    throw error;
  }
}

/** Adds an item category. */
export async function addItemCategory(ctx: TenantContext, rawName: unknown): Promise<{ id: string }> {
  requireManager(ctx);
  const read = readCategoryName(rawName);
  if (!read.ok) throw new UserError(read.reason);
  try {
    return await withTenant(ctx.userId, ctx.tenantId, async (tx) => {
      const [row] = await tx.insert(itemCategories).values({ tenantId: ctx.tenantId, name: read.name, createdBy: ctx.userId }).returning({ id: itemCategories.id });
      await audit(tx, ctx, { action: "item_category.add", entity: "item_category", entityId: row.id, after: { name: read.name } });
      return row;
    });
  } catch (error) {
    if (pgCode(error) === UNIQUE_VIOLATION) throw new UserError("A category with this name already exists.");
    throw error;
  }
}

/** Writes new items and their pack conversions. Ids are made here so the rows can point at each other. */
async function insertItems(tx: Tx, ctx: TenantContext, list: { id: string; item: ItemInput; pack: PackInput | null }[]): Promise<void> {
  const by = { tenantId: ctx.tenantId, createdBy: ctx.userId, updatedBy: ctx.userId };
  for (let start = 0; start < list.length; start += INSERT_CHUNK) {
    const chunk = list.slice(start, start + INSERT_CHUNK);
    await tx.insert(items).values(chunk.map(({ id, item }) => ({ id, ...by, ...item })));
    const packs = chunk.filter((entry) => entry.pack !== null);
    if (packs.length > 0) await tx.insert(itemUnits).values(packs.map(({ id, pack }) => ({ ...by, itemId: id, unitId: pack!.unitId, factor: pack!.factor })));
  }
}

/** Adds an item. A pack unit and size given with it become its first conversion. */
export async function createItem(ctx: TenantContext, raw: RawItem): Promise<{ id: string }> {
  requireManager(ctx);
  const id = randomUUID();
  try {
    await withTenant(ctx.userId, ctx.tenantId, async (tx) => {
      const { known } = await selectItemSetup(tx, ctx.tenantId);
      const read = readItem(raw, known);
      if (!read.ok) throw new UserError(read.problems[0]);
      await insertItems(tx, ctx, [{ id, item: read.item, pack: read.pack }]);
      await audit(tx, ctx, { action: "item.create", entity: "item", entityId: id, after: { ...read.item, pack: read.pack } });
    });
  } catch (error) {
    if (pgCode(error) === UNIQUE_VIOLATION) throw new UserError("Another item already has this code.");
    throw error;
  }
  return { id };
}

/** Locks the item's row for the rest of the transaction and returns the item as it stands. */
async function lockItem(tx: Tx, ctx: TenantContext, id: unknown) {
  if (!isUuid(id)) throw new UserError(NOT_HERE);
  const mine = and(eq(items.tenantId, ctx.tenantId), eq(items.id, id));
  const locked = await tx.select({ id: items.id }).from(items).where(mine).for("update");
  const found = locked.length === 0 ? null : await selectItem(tx, ctx.tenantId, id);
  if (!found) throw new UserError(NOT_HERE);
  return { found, mine, id };
}

/**
 * Changes an item. Its unit cannot change, because stock is counted in it. Only the fields that
 * differ go in the audit row. An archived item must be restored first, and a form opened before
 * someone else's change is refused.
 */
export async function updateItem(ctx: TenantContext, itemId: unknown, raw: RawItem, loadedAt?: unknown): Promise<{ id: string }> {
  requireManager(ctx);
  try {
    await withTenant(ctx.userId, ctx.tenantId, async (tx) => {
      const { found, mine, id } = await lockItem(tx, ctx, itemId);
      if (found.archivedAt !== null) throw new UserError("Restore the item before changing it.");
      if (typeof loadedAt === "string" && loadedAt !== "" && loadedAt !== found.updatedAt.toISOString()) {
        throw new UserError("Someone else changed this item while you had it open. Reload the page to see their change, then make yours.");
      }
      const { known } = await selectItemSetup(tx, ctx.tenantId);
      // The form does not offer the unit or a pack on an item that exists.
      const read = readItem({ ...raw, unit: found.item.baseUnitId, packUnit: "", packSize: "" }, known);
      if (!read.ok) throw new UserError(read.problems[0]);
      const changes = changedFields(found.item, read.item);
      if (Object.keys(changes.after).length === 0) return;
      // The unit is left out of the update: it is fixed, and the app holds no right to change it.
      await tx.update(items).set({ ...read.item, baseUnitId: undefined, updatedAt: sql`now()`, updatedBy: ctx.userId }).where(mine);
      await audit(tx, ctx, { action: "item.update", entity: "item", entityId: id, before: changes.before, after: changes.after });
    });
  } catch (error) {
    if (pgCode(error) === UNIQUE_VIOLATION) throw new UserError("Another item already has this code.");
    throw error;
  }
  return { id: itemId as string };
}

/** Archives an item, which hides it from lists and pickers, or restores it. Nothing is deleted. */
export async function setItemArchived(ctx: TenantContext, itemId: unknown, archived: boolean): Promise<void> {
  requireManager(ctx);
  await withTenant(ctx.userId, ctx.tenantId, async (tx) => {
    const { found, mine, id } = await lockItem(tx, ctx, itemId);
    if ((found.archivedAt !== null) === archived) return;
    await tx
      .update(items)
      .set({ archivedAt: archived ? sql`now()` : null, archivedBy: archived ? ctx.userId : null, updatedAt: sql`now()`, updatedBy: ctx.userId })
      .where(mine);
    await audit(tx, ctx, {
      action: archived ? "item.archive" : "item.restore",
      entity: "item",
      entityId: id,
      before: { code: found.item.code, archived: !archived },
      after: { code: found.item.code, archived },
    });
  });
}

/**
 * Says how many of the item's own unit one of another unit holds: a carton of 24 pieces. Saving
 * the same unit again corrects the number; the audit row keeps both.
 */
export async function setItemUnit(ctx: TenantContext, itemId: unknown, raw: { unit?: unknown; factor?: unknown }): Promise<void> {
  requireManager(ctx);
  const factor = parseFactor(raw.factor);
  if (!factor.ok) throw new UserError(`Units per pack: ${factor.reason}`);
  const stored = factor.value.toFixed(FACTOR_SCALE);
  await withTenant(ctx.userId, ctx.tenantId, async (tx) => {
    const { found, id } = await lockItem(tx, ctx, itemId);
    if (found.archivedAt !== null) throw new UserError("Restore the item before changing it.");
    const { known } = await selectItemSetup(tx, ctx.tenantId);
    const typed = typeof raw.unit === "string" ? raw.unit.trim() : "";
    const unitId = known.units.get(typed) ?? known.units.get(typed.toLowerCase());
    if (!unitId) throw new UserError("Choose a unit.");
    if (unitId === found.item.baseUnitId) throw new UserError("That is the item's own unit; it needs no conversion.");
    const existing = found.conversions.find((c) => c.unitId === unitId);
    const row = and(eq(itemUnits.tenantId, ctx.tenantId), eq(itemUnits.itemId, id), eq(itemUnits.unitId, unitId));
    if (existing) await tx.update(itemUnits).set({ factor: stored, updatedAt: sql`now()`, updatedBy: ctx.userId }).where(row);
    else await tx.insert(itemUnits).values({ tenantId: ctx.tenantId, itemId: id, unitId, factor: stored, createdBy: ctx.userId, updatedBy: ctx.userId });
    await audit(tx, ctx, {
      action: "item_unit.set",
      entity: "item",
      entityId: id,
      before: existing ? { code: found.item.code, unitId, factor: existing.factor.toFixed(FACTOR_SCALE) } : null,
      after: { code: found.item.code, unitId, factor: stored },
    });
  });
}

/** Removes one of an item's other units. Documents already written keep their own quantities. */
export async function removeItemUnit(ctx: TenantContext, itemId: unknown, unitId: unknown): Promise<void> {
  requireManager(ctx);
  await withTenant(ctx.userId, ctx.tenantId, async (tx) => {
    const { found, id } = await lockItem(tx, ctx, itemId);
    if (found.archivedAt !== null) throw new UserError("Restore the item before changing it.");
    const existing = found.conversions.find((c) => c.unitId === unitId);
    if (!existing) return;
    await tx.delete(itemUnits).where(and(eq(itemUnits.tenantId, ctx.tenantId), eq(itemUnits.itemId, id), eq(itemUnits.unitId, existing.unitId)));
    await audit(tx, ctx, {
      action: "item_unit.remove",
      entity: "item",
      entityId: id,
      before: { code: found.item.code, unitId: existing.unitId, factor: existing.factor.toFixed(FACTOR_SCALE) },
      after: null,
    });
  });
}

export type ItemImportOutcome = { imported: number } | { problems: ImportProblem[] };

/**
 * Imports a CSV file of items, all or nothing. If any row is wrong, or has the code of an item
 * that already exists, no row is kept and every bad row is returned with what is wrong.
 */
export async function importItems(ctx: TenantContext, file: { name: string; text: string }): Promise<ItemImportOutcome> {
  requireManager(ctx);
  try {
    return await withTenant(ctx.userId, ctx.tenantId, async (tx): Promise<ItemImportOutcome> => {
      const { known } = await selectItemSetup(tx, ctx.tenantId);
      const read = readItemImport(file.text, known);
      if (read.status === "unreadable") throw new UserError(read.reason);
      const problems = [...read.problems];
      if (read.items.length > 0) {
        // Archived items count too: their codes are still taken.
        const existing = await tx.select({ code: sql<string>`lower(${items.code})` }).from(items).where(eq(items.tenantId, ctx.tenantId));
        const codes = new Set(existing.map((row) => row.code));
        for (const { row, item } of read.items) {
          if (codes.has(item.code.toLowerCase())) problems.push({ row, name: item.name, problems: ["Another item already has this code."] });
        }
      }
      if (problems.length > 0) return { problems: problems.sort((a, b) => a.row - b.row) };

      const list = read.items.map(({ item, pack }) => ({ id: randomUUID(), item, pack }));
      await insertItems(tx, ctx, list);
      await audit(tx, ctx, {
        action: "item.import",
        entity: "item",
        // The ids tie each imported item back to this import; it has no audit row of its own.
        after: { rows: list.length, file: file.name.replace(/[^\P{Cc}]/gu, "").slice(0, 120), ids: list.map((entry) => entry.id) },
      });
      return { imported: list.length };
    });
  } catch (error) {
    if (pgCode(error) === UNIQUE_VIOLATION) {
      throw new UserError("An item in the file has a code that is already taken. Nothing was imported; import the file again to see which row.");
    }
    throw error;
  }
}

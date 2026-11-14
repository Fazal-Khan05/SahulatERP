import "server-only";
import Decimal from "decimal.js";
import { and, eq, sql } from "drizzle-orm";
import { audit, isUuid, withTenant, type Tx } from "@/db";
import { readCsvTable } from "@/lib/csv-table";
import { UserError, pgCode } from "@/lib/errors";
import { periodRefusal } from "@/modules/numbering/rules";
import { can, type Permission, type TenantContext } from "@/modules/tenant/rules";
import { warehouses } from "@/modules/warehouses/schema";
import { selectItemsByCode, selectStockAdjustment, selectStockCount, selectStockTransfer, type StockAdjustment, type StockCount, type StockTransfer } from "./queries";
import {
  MAX_OPENING_ROWS,
  OPENING_COLUMNS,
  QUANTITY_SCALE,
  formatQuantity,
  readAdjustment,
  readCountStart,
  readCounted,
  readOpeningRows,
  readTransfer,
  type AdjustmentDraft,
  type AdjustmentKind,
  type AdjustmentLine,
  type OpeningProblem,
  type RawAdjustment,
  type RawTransfer,
  type TransferDraft,
} from "./rules";
import { stockAdjustmentLines, stockAdjustments, stockCountLines, stockCounts, stockTransferLines, stockTransfers } from "./schema";

// The commands behind the stock screens. A draft is written here, by the app, under row-level
// security. Posting is not: each post command only asks the database's own function, which
// takes the number, moves the stock and posts the journal in the same transaction, or refuses.

function requirePermission(ctx: TenantContext, permission: Permission, refusal: string): void {
  if (!can(ctx.role, permission)) throw new UserError(refusal);
}

const ONLY_WAREHOUSE = "Only an owner, an accountant or the warehouse can do that.";
const ONLY_BOOKS = "Only an owner or an accountant can do that.";

/** A screen opened before someone else's change must not act on what it no longer shows. */
function requireFresh(updatedAt: Date, loadedAt: unknown, what: string): void {
  const loaded = loadedAt instanceof Date ? loadedAt.toISOString() : loadedAt;
  if (typeof loaded === "string" && loaded !== "" && loaded !== updatedAt.toISOString()) {
    throw new UserError(`Someone changed this ${what} after you opened it. Reload the page and try again.`);
  }
}

/** The warehouse's name and branch, if it is one this member sees; a refusal otherwise. */
async function requireWarehouse(tx: Tx, ctx: TenantContext, id: string, refusal: string): Promise<{ name: string; branchId: string }> {
  if (!isUuid(id)) throw new UserError(refusal);
  const [found] = await tx.select({ name: warehouses.name, branchId: warehouses.branchId }).from(warehouses).where(and(eq(warehouses.tenantId, ctx.tenantId), eq(warehouses.id, id)));
  if (!found) throw new UserError(refusal);
  return found;
}

const BETWEEN_BRANCHES = "These two warehouses belong to different branches. Transfers between branches are not available yet; a transfer stays inside one branch.";

/** Each line with its item, found by the code typed. An unknown or archived code is refused by line. */
async function withItems<T extends { itemCode: string }>(tx: Tx, ctx: TenantContext, lines: readonly T[], allowArchived: boolean): Promise<(T & { itemId: string })[]> {
  const found = await selectItemsByCode(
    tx,
    ctx.tenantId,
    lines.map((line) => line.itemCode),
  );
  return lines.map((line, index) => {
    const item = found.get(line.itemCode.toLowerCase());
    if (!item) throw new UserError(`Line ${index + 1}: there is no item with the code ${line.itemCode}.`);
    if (item.archived && !allowArchived) throw new UserError(`Line ${index + 1}: ${item.code} is archived. Restore it on the item list first.`);
    return { ...line, itemId: item.id };
  });
}

/** What to tell someone whose stock document the database refused, or null for anything unexpected. */
function stockRefusal(error: unknown, date: string, what: string): UserError | null {
  const code = pgCode(error);
  const closed = periodRefusal(code, date);
  if (closed) return new UserError(closed);
  if (code === "SE015") return new UserError("That date is before the day the books were opened.");
  if (code === "SE060") return new UserError(`There is not enough in stock for this ${what}. Stock never goes below zero; check the quantities against what the warehouse holds.`);
  if (code === "SE064") return new UserError("The chart of accounts has no stock account, or no account for the other side of this entry. Set the company up first.");
  if (code === "SE202") return new UserError(`This ${what} has nothing on it yet.`);
  if (code === "SE205") return new UserError(`No cost is known for one of the items being added. Enter what one costs on its line${what === "stock count" ? ", in a stock adjustment, before posting this count" : ""}.`);
  if (code === "SE206") return new UserError("Stock has moved since this sheet was started. Look at the items marked on the sheet, then choose what to do.");
  if (code === "SE208") return new UserError(BETWEEN_BRANCHES);
  if (code === "SE209") return new UserError(`Someone changed this ${what} after you opened it. Reload the page and try again.`);
  if (code === "SE210") return new UserError("The company's opening balances are already posted. Opening stock is dated on the same day as they are; change the date and post again.");
  if (code === "42501") return new UserError("Your role cannot do that.");
  if (code === "SE200" || code === "SE201" || code === "SE203" || code === "SE204" || code === "SE207" || code === "SE074") {
    return new UserError(`This ${what} could not be posted as it stands. Reload the page and try again.`);
  }
  return null;
}

async function callPost(tx: Tx, call: ReturnType<typeof sql>): Promise<string> {
  const [row] = await tx.execute<{ number: string }>(call);
  return row.number;
}

// ── transfers ───────────────────────────────────────────────────────────────────────────────────

const TRANSFER_GONE = "That transfer is not in this company.";

async function lockTransfer(tx: Tx, ctx: TenantContext, id: unknown, loadedAt?: unknown): Promise<StockTransfer> {
  if (!isUuid(id)) throw new UserError(TRANSFER_GONE);
  const transfer = await selectStockTransfer(tx, ctx.tenantId, id, true);
  if (!transfer) throw new UserError(TRANSFER_GONE);
  requireFresh(transfer.updatedAt, loadedAt, "transfer");
  return transfer;
}

const describeTransfer = (draft: Pick<TransferDraft, "date" | "note">, from: string, to: string, lines: readonly { itemCode: string; quantity: Decimal }[]) => ({
  date: draft.date,
  from,
  to,
  note: draft.note,
  lines: lines.map((line) => ({ item: line.itemCode, quantity: formatQuantity(line.quantity) })),
});

/** Saves a stock transfer as a draft: a new one, or an existing draft with its lines replaced. */
export async function saveTransferDraft(ctx: TenantContext, id: unknown, raw: RawTransfer, loadedAt?: unknown): Promise<{ id: string; updatedAt: Date }> {
  requirePermission(ctx, "stock_transfer.manage", ONLY_WAREHOUSE);
  const read = readTransfer(raw);
  if (!read.ok) throw new UserError(read.reason);
  const draft = read.draft;
  return withTenant(ctx.userId, ctx.tenantId, async (tx) => {
    const leaves = await requireWarehouse(tx, ctx, draft.fromWarehouseId, "Choose the warehouse the goods leave, from your own warehouses.");
    const arrives = await requireWarehouse(tx, ctx, draft.toWarehouseId, "Choose the warehouse the goods go to, from your own warehouses.");
    if (leaves.branchId !== arrives.branchId) throw new UserError(BETWEEN_BRANCHES);
    const from = leaves.name;
    const to = arrives.name;
    const lines = await withItems(tx, ctx, draft.lines, true);
    const values = { transferDate: draft.date, fromWarehouseId: draft.fromWarehouseId, toWarehouseId: draft.toWarehouseId, note: draft.note, updatedBy: ctx.userId };
    let saved: { id: string; updatedAt: Date };
    let before: unknown = null;
    if (id === null || id === undefined || id === "") {
      [saved] = await tx
        .insert(stockTransfers)
        .values({ tenantId: ctx.tenantId, createdBy: ctx.userId, ...values })
        .returning({ id: stockTransfers.id, updatedAt: stockTransfers.updatedAt });
    } else {
      const stored = await lockTransfer(tx, ctx, id, loadedAt);
      if (stored.status !== "draft") throw new UserError("This transfer is posted and cannot be changed. Transfer the goods back instead.");
      before = describeTransfer(stored, stored.fromWarehouse, stored.toWarehouse, stored.lines.map((line) => ({ itemCode: line.code, quantity: line.quantity })));
      await tx.delete(stockTransferLines).where(and(eq(stockTransferLines.tenantId, ctx.tenantId), eq(stockTransferLines.transferId, stored.id)));
      [saved] = await tx
        .update(stockTransfers)
        .set({ ...values, updatedAt: sql`now()` })
        .where(and(eq(stockTransfers.tenantId, ctx.tenantId), eq(stockTransfers.id, stored.id)))
        .returning({ id: stockTransfers.id, updatedAt: stockTransfers.updatedAt });
    }
    if (lines.length > 0) {
      await tx.insert(stockTransferLines).values(
        lines.map((line, index) => ({ tenantId: ctx.tenantId, transferId: saved.id, lineNo: index + 1, itemId: line.itemId, quantity: line.quantity.toFixed(QUANTITY_SCALE), createdBy: ctx.userId })),
      );
    }
    await audit(tx, ctx, { action: before === null ? "stock_transfer.create" : "stock_transfer.update", entity: "stock_transfer", entityId: saved.id, before, after: describeTransfer(draft, from, to, draft.lines) });
    return saved;
  });
}

/** Throws a draft transfer away. A posted one is never removed. */
export async function discardTransfer(ctx: TenantContext, id: unknown, loadedAt?: unknown): Promise<void> {
  requirePermission(ctx, "stock_transfer.manage", ONLY_WAREHOUSE);
  await withTenant(ctx.userId, ctx.tenantId, async (tx) => {
    const stored = await lockTransfer(tx, ctx, id, loadedAt);
    if (stored.status !== "draft") throw new UserError("This transfer is posted and cannot be removed. Transfer the goods back instead.");
    await tx.delete(stockTransferLines).where(and(eq(stockTransferLines.tenantId, ctx.tenantId), eq(stockTransferLines.transferId, stored.id)));
    await tx.delete(stockTransfers).where(and(eq(stockTransfers.tenantId, ctx.tenantId), eq(stockTransfers.id, stored.id)));
    await audit(tx, ctx, {
      action: "stock_transfer.discard",
      entity: "stock_transfer",
      entityId: stored.id,
      before: describeTransfer(stored, stored.fromWarehouse, stored.toWarehouse, stored.lines.map((line) => ({ itemCode: line.code, quantity: line.quantity }))),
      after: null,
    });
  });
}

/** Posts a draft transfer: the goods leave one warehouse and are in the other, in one transaction. */
export async function postTransfer(ctx: TenantContext, id: unknown, loadedAt?: unknown): Promise<{ number: string }> {
  requirePermission(ctx, "stock_transfer.manage", ONLY_WAREHOUSE);
  let date = "";
  try {
    return await withTenant(ctx.userId, ctx.tenantId, async (tx) => {
      const stored = await lockTransfer(tx, ctx, id, loadedAt);
      if (stored.status !== "draft") throw new UserError("This transfer is already posted.");
      if (stored.lines.length === 0) throw new UserError("Add at least one item to the transfer before posting it.");
      date = stored.date;
      return { number: await callPost(tx, sql`select app.post_stock_transfer(${stored.id}) as number`) };
    });
  } catch (error) {
    throw stockRefusal(error, date, "transfer") ?? error;
  }
}

// ── adjustments and opening stock ───────────────────────────────────────────────────────────────

const ADJUSTMENT_GONE = "That stock adjustment is not in this company.";
const called = (kind: AdjustmentKind) => (kind === "opening" ? "opening stock entry" : "stock adjustment");

async function lockAdjustment(tx: Tx, ctx: TenantContext, id: unknown, loadedAt?: unknown): Promise<StockAdjustment> {
  if (!isUuid(id)) throw new UserError(ADJUSTMENT_GONE);
  const adjustment = await selectStockAdjustment(tx, ctx.tenantId, id, true);
  if (!adjustment) throw new UserError(ADJUSTMENT_GONE);
  requireFresh(adjustment.updatedAt, loadedAt, called(adjustment.kind));
  return adjustment;
}

const describeAdjustment = (draft: Pick<AdjustmentDraft, "kind" | "date" | "reason" | "note">, warehouse: string, lines: readonly AdjustmentLine[]) => ({
  kind: draft.kind,
  date: draft.date,
  warehouse,
  reason: draft.reason,
  note: draft.note,
  lines: lines.length,
  // The whole list is kept for a document typed by hand; a file of opening stock is summed up.
  ...(lines.length <= 50 ? { items: lines.map((line) => ({ item: line.itemCode, quantity: formatQuantity(line.quantity), unitCost: line.unitCost === null ? null : formatQuantity(line.unitCost) })) } : {}),
});
const storedLines = (stored: StockAdjustment): AdjustmentLine[] => stored.lines.map((line) => ({ itemCode: line.code, quantity: line.quantity, unitCost: line.unitCost }));

async function writeAdjustment(tx: Tx, ctx: TenantContext, id: unknown, draft: AdjustmentDraft, loadedAt: unknown): Promise<{ id: string; updatedAt: Date }> {
  const { name: warehouse } = await requireWarehouse(tx, ctx, draft.warehouseId, "Choose one of your warehouses.");
  const lines = await withItems(tx, ctx, draft.lines, true);
  const values = { adjustmentDate: draft.date, warehouseId: draft.warehouseId, reason: draft.reason, note: draft.note, updatedBy: ctx.userId };
  let saved: { id: string; updatedAt: Date };
  let before: unknown = null;
  if (id === null || id === undefined || id === "") {
    [saved] = await tx
      .insert(stockAdjustments)
      .values({ tenantId: ctx.tenantId, kind: draft.kind, createdBy: ctx.userId, ...values })
      .returning({ id: stockAdjustments.id, updatedAt: stockAdjustments.updatedAt });
  } else {
    const stored = await lockAdjustment(tx, ctx, id, loadedAt);
    if (stored.status !== "draft") throw new UserError("This is posted and cannot be changed. Post an opposite entry instead.");
    if (stored.kind !== draft.kind) throw new UserError(ADJUSTMENT_GONE);
    before = describeAdjustment(stored, stored.warehouse, storedLines(stored));
    await tx.delete(stockAdjustmentLines).where(and(eq(stockAdjustmentLines.tenantId, ctx.tenantId), eq(stockAdjustmentLines.adjustmentId, stored.id)));
    [saved] = await tx
      .update(stockAdjustments)
      .set({ ...values, updatedAt: sql`now()` })
      .where(and(eq(stockAdjustments.tenantId, ctx.tenantId), eq(stockAdjustments.id, stored.id)))
      .returning({ id: stockAdjustments.id, updatedAt: stockAdjustments.updatedAt });
  }
  // In batches: a file of opening stock can hold two thousand rows.
  for (let start = 0; start < lines.length; start += 500) {
    await tx.insert(stockAdjustmentLines).values(
      lines.slice(start, start + 500).map((line, index) => ({
        tenantId: ctx.tenantId,
        adjustmentId: saved.id,
        lineNo: start + index + 1,
        itemId: line.itemId,
        quantity: line.quantity.toFixed(QUANTITY_SCALE),
        unitCost: line.unitCost === null ? null : line.unitCost.toFixed(QUANTITY_SCALE),
        createdBy: ctx.userId,
      })),
    );
  }
  await audit(tx, ctx, { action: before === null ? "stock_adjustment.create" : "stock_adjustment.update", entity: "stock_adjustment", entityId: saved.id, before, after: describeAdjustment(draft, warehouse, draft.lines) });
  return saved;
}

/** Saves a stock adjustment, or an opening stock entry, as a draft: a new one, or an existing draft with its lines replaced. */
export async function saveAdjustmentDraft(ctx: TenantContext, kind: AdjustmentKind, id: unknown, raw: RawAdjustment, loadedAt?: unknown): Promise<{ id: string; updatedAt: Date }> {
  requirePermission(ctx, "stock_adjustment.manage", ONLY_BOOKS);
  const read = readAdjustment(kind, raw);
  if (!read.ok) throw new UserError(read.reason);
  return withTenant(ctx.userId, ctx.tenantId, (tx) => writeAdjustment(tx, ctx, id, read.draft, loadedAt));
}

export type OpeningImport = { ok: true; id: string; lines: number } | { ok: false; reason?: string; problems?: OpeningProblem[] };

/**
 * Reads a CSV file of opening stock (item code, quantity, unit cost) into a new draft for one
 * warehouse. Every row must be right, or nothing is kept and each wrong row is named. The draft
 * is then looked over and posted like any other.
 */
export async function importOpeningStock(ctx: TenantContext, raw: { date?: unknown; warehouseId?: unknown; note?: unknown; csv: string }): Promise<OpeningImport> {
  requirePermission(ctx, "stock_adjustment.manage", ONLY_BOOKS);
  const head = readAdjustment("opening", { date: raw.date, warehouseId: raw.warehouseId, note: raw.note, lines: [] });
  if (!head.ok) return { ok: false, reason: head.reason };
  const table = readCsvTable(raw.csv, OPENING_COLUMNS, "code", MAX_OPENING_ROWS);
  if (!table.ok) return { ok: false, reason: table.reason };
  const missing = OPENING_COLUMNS.filter((column) => table.rows.every((row) => row.raw[column.key] === undefined));
  if (missing.length > 0) return { ok: false, reason: `The file needs a "${missing[0].header}" column in its first row.` };
  const read = readOpeningRows(table.rows);
  if (!read.ok) return { ok: false, problems: read.problems };
  return withTenant(ctx.userId, ctx.tenantId, async (tx) => {
    const found = await selectItemsByCode(
      tx,
      ctx.tenantId,
      read.lines.map((line) => line.itemCode),
    );
    const problems: OpeningProblem[] = [];
    read.lines.forEach((line, index) => {
      const item = found.get(line.itemCode.toLowerCase());
      if (!item) problems.push({ row: table.rows[index].row, name: line.itemCode, problems: ["There is no item with this code. Add it to the item list first, or correct the code."] });
    });
    if (problems.length > 0) return { ok: false as const, problems };
    const saved = await writeAdjustment(tx, ctx, null, { ...head.draft, lines: read.lines }, undefined);
    return { ok: true as const, id: saved.id, lines: read.lines.length };
  });
}

/** Throws a draft adjustment away. A posted one is never removed. */
export async function discardAdjustment(ctx: TenantContext, id: unknown, loadedAt?: unknown): Promise<{ kind: AdjustmentKind }> {
  requirePermission(ctx, "stock_adjustment.manage", ONLY_BOOKS);
  return withTenant(ctx.userId, ctx.tenantId, async (tx) => {
    const stored = await lockAdjustment(tx, ctx, id, loadedAt);
    if (stored.status !== "draft") throw new UserError("This is posted and cannot be removed. Post an opposite entry instead.");
    await tx.delete(stockAdjustmentLines).where(and(eq(stockAdjustmentLines.tenantId, ctx.tenantId), eq(stockAdjustmentLines.adjustmentId, stored.id)));
    await tx.delete(stockAdjustments).where(and(eq(stockAdjustments.tenantId, ctx.tenantId), eq(stockAdjustments.id, stored.id)));
    await audit(tx, ctx, { action: "stock_adjustment.discard", entity: "stock_adjustment", entityId: stored.id, before: describeAdjustment(stored, stored.warehouse, storedLines(stored)), after: null });
    return { kind: stored.kind };
  });
}

/** Posts a draft adjustment or opening stock entry: the stock moves and the journal is posted, in one transaction. */
export async function postAdjustment(ctx: TenantContext, id: unknown, loadedAt?: unknown): Promise<{ number: string }> {
  requirePermission(ctx, "stock_adjustment.manage", ONLY_BOOKS);
  let date = "";
  let what = "stock adjustment";
  try {
    return await withTenant(ctx.userId, ctx.tenantId, async (tx) => {
      const stored = await lockAdjustment(tx, ctx, id, loadedAt);
      if (stored.status !== "draft") throw new UserError("This is already posted.");
      if (stored.lines.length === 0) throw new UserError("Add at least one item before posting.");
      date = stored.date;
      what = called(stored.kind);
      return { number: await callPost(tx, sql`select app.post_stock_adjustment(${stored.id}) as number`) };
    });
  } catch (error) {
    throw stockRefusal(error, date, what) ?? error;
  }
}

// ── counts ──────────────────────────────────────────────────────────────────────────────────────

const COUNT_GONE = "That stock count is not in this company.";

async function lockCount(tx: Tx, ctx: TenantContext, id: unknown, loadedAt?: unknown): Promise<StockCount> {
  if (!isUuid(id)) throw new UserError(COUNT_GONE);
  const count = await selectStockCount(tx, ctx.tenantId, id, true);
  if (!count) throw new UserError(COUNT_GONE);
  requireFresh(count.updatedAt, loadedAt, "count");
  return count;
}

/** The count's row touched, so that its "last changed" moves on: a screen opened before then can tell. */
async function touchCount(tx: Tx, ctx: TenantContext, id: string, change: { countDate?: string; note?: string | null } = {}): Promise<Date> {
  const [saved] = await tx
    .update(stockCounts)
    .set({ ...change, updatedAt: sql`now()`, updatedBy: ctx.userId })
    .where(and(eq(stockCounts.tenantId, ctx.tenantId), eq(stockCounts.id, id)))
    .returning({ updatedAt: stockCounts.updatedAt });
  return saved.updatedAt;
}

/**
 * Starts a stock count of one warehouse: a sheet with a line for every item the warehouse
 * holds, each with what the books say it holds at this moment (the database writes that figure).
 */
export async function startCount(ctx: TenantContext, raw: { date?: unknown; warehouseId?: unknown; note?: unknown }): Promise<{ id: string; lines: number }> {
  requirePermission(ctx, "stock_count.manage", ONLY_WAREHOUSE);
  const read = readCountStart(raw);
  if (!read.ok) throw new UserError(read.reason);
  const draft = read.draft;
  return withTenant(ctx.userId, ctx.tenantId, async (tx) => {
    const { name: warehouse } = await requireWarehouse(tx, ctx, draft.warehouseId, "Choose one of your warehouses.");
    const [saved] = await tx
      .insert(stockCounts)
      .values({ tenantId: ctx.tenantId, countDate: draft.date, warehouseId: draft.warehouseId, note: draft.note, createdBy: ctx.userId, updatedBy: ctx.userId })
      .returning({ id: stockCounts.id });
    const lines = await tx.execute(sql`
      insert into public.stock_count_lines (tenant_id, count_id, item_id, created_by)
        select b.tenant_id, ${saved.id}::uuid, b.item_id, ${ctx.userId}::uuid
        from public.stock_balances b
        where b.tenant_id = ${ctx.tenantId} and b.warehouse_id = ${draft.warehouseId} and b.quantity > 0
        returning id`);
    await audit(tx, ctx, { action: "stock_count.create", entity: "stock_count", entityId: saved.id, after: { date: draft.date, warehouse, note: draft.note, lines: lines.length } });
    return { id: saved.id, lines: lines.length };
  });
}

/**
 * Saves what has been counted so far on a sheet still being counted, with its date and note.
 * A line left empty is not counted (yet).
 */
export async function saveCounts(
  ctx: TenantContext,
  id: unknown,
  raw: { date?: unknown; note?: unknown; lines: readonly { lineId?: unknown; counted?: unknown; label?: string }[] },
  loadedAt?: unknown,
): Promise<{ updatedAt: Date }> {
  requirePermission(ctx, "stock_count.manage", ONLY_WAREHOUSE);
  const head = readCountStart({ date: raw.date, warehouseId: "kept", note: raw.note });
  if (!head.ok) throw new UserError(head.reason);
  const read = readCounted(raw.lines);
  if (!read.ok) throw new UserError(read.reason);
  return withTenant(ctx.userId, ctx.tenantId, async (tx) => {
    const stored = await lockCount(tx, ctx, id, loadedAt);
    if (stored.status !== "draft") throw new UserError("This count is finished and cannot be changed. Send it back first.");
    const known = new Map(stored.lines.map((line) => [line.id, line]));
    const changed = read.counted.filter((line) => {
      const before = known.get(line.lineId);
      return before !== undefined && (before.counted === null ? line.counted !== null : line.counted === null || !before.counted.eq(line.counted));
    });
    if (changed.length > 0) {
      const values = sql.join(
        changed.map((line) => sql`(${line.lineId}::uuid, ${line.counted === null ? null : line.counted.toFixed(QUANTITY_SCALE)}::numeric)`),
        sql`, `,
      );
      await tx.execute(sql`
        update public.stock_count_lines l set counted_quantity = v.counted
        from (values ${values}) as v(id, counted)
        where l.tenant_id = ${ctx.tenantId} and l.count_id = ${stored.id} and l.id = v.id`);
    }
    const updatedAt = await touchCount(tx, ctx, stored.id, { countDate: head.draft.date, note: head.draft.note });
    await audit(tx, ctx, {
      action: "stock_count.update",
      entity: "stock_count",
      entityId: stored.id,
      before: { date: stored.date, note: stored.note },
      after: {
        date: head.draft.date,
        note: head.draft.note,
        changed: changed.slice(0, 50).map((line) => ({ item: known.get(line.lineId)?.code, counted: line.counted === null ? null : formatQuantity(line.counted) })),
        linesChanged: changed.length,
      },
    });
    return { updatedAt };
  });
}

/** Adds an item to a sheet still being counted: something found on the shelf that the sheet does not list. */
export async function addCountItem(ctx: TenantContext, id: unknown, raw: { itemCode?: unknown }, loadedAt?: unknown): Promise<{ updatedAt: Date }> {
  requirePermission(ctx, "stock_count.manage", ONLY_WAREHOUSE);
  const itemCode = typeof raw.itemCode === "string" ? raw.itemCode.trim() : "";
  if (itemCode === "") throw new UserError("Enter the item's code.");
  return withTenant(ctx.userId, ctx.tenantId, async (tx) => {
    const stored = await lockCount(tx, ctx, id, loadedAt);
    if (stored.status !== "draft") throw new UserError("This count is finished and cannot be changed. Send it back first.");
    const item = (await selectItemsByCode(tx, ctx.tenantId, [itemCode])).get(itemCode.toLowerCase());
    if (!item) throw new UserError(`There is no item with the code ${itemCode}.`);
    if (stored.lines.some((line) => line.itemId === item.id)) throw new UserError(`${item.code} is already on the sheet.`);
    await tx.insert(stockCountLines).values({ tenantId: ctx.tenantId, countId: stored.id, itemId: item.id, createdBy: ctx.userId });
    const updatedAt = await touchCount(tx, ctx, stored.id);
    await audit(tx, ctx, { action: "stock_count.add_item", entity: "stock_count", entityId: stored.id, after: { item: item.code } });
    return { updatedAt };
  });
}

/** Throws a sheet away while it is still being counted. A finished or posted count is never removed. */
export async function discardCount(ctx: TenantContext, id: unknown, loadedAt?: unknown): Promise<void> {
  requirePermission(ctx, "stock_count.manage", ONLY_WAREHOUSE);
  await withTenant(ctx.userId, ctx.tenantId, async (tx) => {
    const stored = await lockCount(tx, ctx, id, loadedAt);
    if (stored.status !== "draft") throw new UserError("Only a count that is still being counted can be thrown away. Send it back first.");
    await tx.delete(stockCountLines).where(and(eq(stockCountLines.tenantId, ctx.tenantId), eq(stockCountLines.countId, stored.id)));
    await tx.delete(stockCounts).where(and(eq(stockCounts.tenantId, ctx.tenantId), eq(stockCounts.id, stored.id)));
    await audit(tx, ctx, { action: "stock_count.discard", entity: "stock_count", entityId: stored.id, before: { date: stored.date, warehouse: stored.warehouse, lines: stored.lines.length }, after: null });
  });
}

/** One step of a count that the database itself takes and records: finished, sent back, brought up to date. */
async function moveCount(ctx: TenantContext, id: unknown, loadedAt: unknown, from: StockCount["status"], refusal: string, call: (countId: string) => ReturnType<typeof sql>): Promise<void> {
  try {
    await withTenant(ctx.userId, ctx.tenantId, async (tx) => {
      const stored = await lockCount(tx, ctx, id, loadedAt);
      if (stored.status !== from) throw new UserError(refusal);
      await tx.execute(call(stored.id));
    });
  } catch (error) {
    if (pgCode(error) === "SE202") throw new UserError("Nothing has been counted yet. Enter what was counted, save, then mark the count finished.");
    throw stockRefusal(error, "", "stock count") ?? error;
  }
}

/** Marks a count finished: the sheet is closed to changes and waits for an owner or an accountant. */
export async function submitCount(ctx: TenantContext, id: unknown, loadedAt?: unknown): Promise<void> {
  requirePermission(ctx, "stock_count.manage", ONLY_WAREHOUSE);
  await moveCount(ctx, id, loadedAt, "draft", "This count is already finished.", (countId) => sql`select app.submit_stock_count(${countId})`);
}

/** Sends a finished count back, or takes it back, so it can be changed again. */
export async function returnCount(ctx: TenantContext, id: unknown, loadedAt?: unknown): Promise<void> {
  requirePermission(ctx, "stock_count.manage", ONLY_WAREHOUSE);
  await moveCount(ctx, id, loadedAt, "submitted", "Only a finished count that is not yet posted can be sent back.", (countId) => sql`select app.return_stock_count(${countId})`);
}

/**
 * Brings "what the books held" on every line up to this moment, for a count made after stock
 * moved. A line whose figure changes is cleared, to be counted again.
 */
export async function rebookCount(ctx: TenantContext, id: unknown, loadedAt?: unknown): Promise<void> {
  requirePermission(ctx, "stock_count.manage", ONLY_WAREHOUSE);
  await moveCount(ctx, id, loadedAt, "draft", "Send the count back first; then it can be brought up to date.", (countId) => sql`select app.rebook_stock_count(${countId})`);
}

/**
 * Posts a finished count: stock moves by each difference and their value goes to the stock
 * adjustments account, in one transaction. `loadedAt` is the sheet's "last changed" as the
 * poster read it, and is required. When stock has moved since the sheet was started the
 * database refuses, unless `countedFirst` says the shelves were counted before it moved.
 */
export async function postCount(ctx: TenantContext, id: unknown, loadedAt: unknown, countedFirst = false): Promise<{ number: string }> {
  requirePermission(ctx, "stock_count.post", "Only an owner or an accountant can post a stock count.");
  // What the poster looked at is what is posted, so the poster says when they looked: there is no posting blind.
  const seen = loadedAt instanceof Date ? loadedAt.toISOString() : loadedAt;
  if (typeof seen !== "string" || Number.isNaN(Date.parse(seen))) throw new UserError("Open the count again and look it over before posting it.");
  let date = "";
  try {
    return await withTenant(ctx.userId, ctx.tenantId, async (tx) => {
      const stored = await lockCount(tx, ctx, id, loadedAt);
      if (stored.status === "posted") throw new UserError("This count is already posted.");
      if (stored.status !== "submitted") throw new UserError("Mark the count finished before posting it.");
      date = stored.date;
      // The database compares it again under its own hold on the sheet, and refuses one that has changed since.
      return { number: await callPost(tx, sql`select app.post_stock_count(${stored.id}, ${seen}::timestamptz, ${countedFirst}) as number`) };
    });
  } catch (error) {
    throw stockRefusal(error, date, "stock count") ?? error;
  }
}

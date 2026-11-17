import "server-only";
import { and, eq, sql } from "drizzle-orm";
import { audit, isUuid, withTenant, type Tx } from "@/db";
import { UserError, pgCode } from "@/lib/errors";
import { todayIso } from "@/lib/format";
import { isIsoDate } from "@/modules/currencies/rules";
import { periodRefusal } from "@/modules/numbering/rules";
import { selectBillsOwed } from "@/modules/supplier-payments/queries";
import { readAllocations, settle, type RawAllocation } from "@/modules/supplier-payments/rules";
import { can, type Permission, type TenantContext } from "@/modules/tenant/rules";
import { selectReceiptToReturn, selectReturn, selectReturnables, type SupplierReturn } from "./queries";
import { readReturn, returnLines, type RawReturn } from "./rules";
import { supplierReturns } from "./schema";

// The commands behind the supplier return screens. A draft is written here, by the app, under
// row-level security. Posting a return and setting its credit against bills are not: each
// command only asks the database's own function, which takes the number, moves the stock and
// posts the journal in the same transaction, or refuses.

function requirePermission(ctx: TenantContext, permission: Permission, refusal: string): void {
  if (!can(ctx.role, permission)) throw new UserError(refusal);
}

const ONLY_BOOKS = "Only an owner or an accountant can send goods back to a supplier.";
const RETURN_GONE = "That supplier return is not in this company.";
const dmy = (date: string) => date.split("-").reverse().join("-");

/** A screen opened before someone else's change must not act on what it no longer shows. */
function requireFresh(updatedAt: Date, loadedAt: unknown): void {
  const loaded = loadedAt instanceof Date ? loadedAt.toISOString() : loadedAt;
  if (typeof loaded === "string" && loaded !== "" && loaded !== updatedAt.toISOString()) {
    throw new UserError("Someone changed this return after you opened it. Reload the page and try again.");
  }
}

const isNew = (id: unknown) => id === null || id === undefined || id === "";

/** What to tell someone whose return the database refused, or null for anything unexpected. */
function returnRefusal(error: unknown, date: string): UserError | null {
  const code = pgCode(error);
  const closed = periodRefusal(code, date);
  if (closed) return new UserError(closed);
  if (code === "SE015") return new UserError("That date is before the day the books were opened.");
  if (code === "SE060") return new UserError("The warehouse no longer holds that much of an item on the return. Goods that were sold or moved cannot be sent back from here; reload the page and check the quantities.");
  if (code === "SE064") return new UserError("The chart of accounts lacks an account a return posts to (stock, goods received not invoiced, trade payables or purchase price differences). Set the company up first.");
  if (code === "SE246") return new UserError(RETURN_GONE);
  if (code === "SE250") return new UserError("Enter how much goes back of at least one line.");
  if (code === "SE251") return new UserError("More is on the return than can still go back. A bill or another return may have been posted since you opened this page; reload it and check the quantities.");
  if (code === "SE252") return new UserError("That date has not come yet, or is before what it follows: goods go back on or after the day they were received, and billed goods on or after the day of their bill.");
  if (code === "SE253") return new UserError("The credit could not be set against those bills: each must be a bill of this supplier that is still owed at least that much, and in all no more than is left of the credit. Reload the page and check the amounts.");
  if (code === "40P01") return new UserError("Someone else was working on the same supplier or the same stock at that moment. Nothing was changed; try again.");
  if (code === "42501") return new UserError("Your role cannot do that.");
  if (code === "SE247" || code === "SE248" || code === "SE249" || code === "SE254" || code === "SE219" || code === "23514" || code === "23503" || code === "23505") {
    return new UserError("This return could not be saved as it stands. Reload the page and try again.");
  }
  return null;
}

async function lockReturn(tx: Tx, ctx: TenantContext, id: unknown, loadedAt?: unknown): Promise<SupplierReturn> {
  if (!isUuid(id)) throw new UserError(RETURN_GONE);
  const found = await selectReturn(tx, ctx.tenantId, id, true);
  if (!found) throw new UserError(RETURN_GONE);
  requireFresh(found.updatedAt, loadedAt);
  return found;
}

const describe = (date: string, reason: string, reference: string | null, receipt: { number: string; supplierName: string; warehouseName: string }, lines: number) => ({
  date,
  receipt: receipt.number,
  supplier: receipt.supplierName,
  warehouse: receipt.warehouseName,
  reason,
  supplierReference: reference,
  lines,
});

/** Saves a return as a draft: a new one against a posted goods received note, or an existing draft with its lines replaced. */
export async function saveReturnDraft(ctx: TenantContext, id: unknown, raw: RawReturn, loadedAt?: unknown): Promise<{ id: string; updatedAt: Date }> {
  requirePermission(ctx, "supplier_return.manage", ONLY_BOOKS);
  const read = readReturn(raw);
  if (!read.ok) throw new UserError(read.reason);
  const draft = read.draft;
  if (draft.date > todayIso(new Date())) throw new UserError("A return cannot be dated on a day that has not come yet.");
  try {
    return await withTenant(ctx.userId, ctx.tenantId, async (tx) => {
      const stored = isNew(id) ? null : await lockReturn(tx, ctx, id, loadedAt);
      if (stored && stored.status !== "draft") throw new UserError("This return is posted and cannot be changed.");
      if (stored && stored.receipt.id !== draft.receiptId) throw new UserError("A return stays with the goods received note it was written for. Throw this draft away and start a new one for the other note.");
      const receipt = stored?.receipt ?? (await selectReceiptToReturn(tx, ctx.tenantId, draft.receiptId));
      if (!receipt) throw new UserError("Choose a posted goods received note from the list.");
      if (draft.date < receipt.date) throw new UserError(`The goods arrived on ${dmy(receipt.date)}. They cannot go back before that day.`);
      for (const line of draft.lines) {
        if (!isUuid(line.receiptLineId) || (line.billLineId !== null && !isUuid(line.billLineId))) throw new UserError("Some goods on the return are not goods of this note. Reload the page.");
      }
      const worked = returnLines(await selectReturnables(tx, ctx.tenantId, receipt.id), draft.lines, draft.date);
      if (!worked.ok) throw new UserError(worked.reason);

      let saved: { id: string; updatedAt: Date };
      let before: unknown = null;
      if (!stored) {
        [saved] = await tx
          .insert(supplierReturns)
          .values({ tenantId: ctx.tenantId, returnDate: draft.date, receiptId: receipt.id, supplierId: receipt.supplierId, warehouseId: receipt.warehouseId, branchId: receipt.branchId, reason: draft.reason, supplierReference: draft.supplierReference, createdBy: ctx.userId, updatedBy: ctx.userId })
          .returning({ id: supplierReturns.id, updatedAt: supplierReturns.updatedAt });
      } else {
        before = describe(stored.date, stored.reason, stored.supplierReference, stored.receipt, stored.lines.length);
        await tx.execute(sql`delete from supplier_return_lines where tenant_id = ${ctx.tenantId}::uuid and return_id = ${stored.id}::uuid`);
        [saved] = await tx
          .update(supplierReturns)
          .set({ returnDate: draft.date, reason: draft.reason, supplierReference: draft.supplierReference, updatedBy: ctx.userId, updatedAt: sql`now()` })
          .where(and(eq(supplierReturns.tenantId, ctx.tenantId), eq(supplierReturns.id, stored.id)))
          .returning({ id: supplierReturns.id, updatedAt: supplierReturns.updatedAt });
      }
      // Written column by column: the app's role may not name a line's figures.
      for (const line of worked.lines) {
        await tx.execute(sql`
          insert into supplier_return_lines (tenant_id, return_id, line_no, receipt_line_id, bill_line_id, item_id, unit_factor, quantity, base_quantity, created_by)
          values (${ctx.tenantId}::uuid, ${saved.id}::uuid, ${line.lineNo}, ${line.receiptLineId}::uuid, ${line.billLineId}::uuid, ${line.itemId}::uuid,
                  ${line.unitFactor.toFixed()}::numeric, ${line.quantity.toFixed()}::numeric, ${line.baseQuantity.toFixed()}::numeric, ${ctx.userId}::uuid)`);
      }
      await audit(tx, ctx, { action: before === null ? "supplier_return.create" : "supplier_return.update", entity: "supplier_return", entityId: saved.id, before, after: describe(draft.date, draft.reason, draft.supplierReference, receipt, worked.lines.length) });
      return saved;
    });
  } catch (error) {
    throw returnRefusal(error, draft.date) ?? error;
  }
}

/** Throws a draft return away. A posted one is never removed. */
export async function discardReturn(ctx: TenantContext, id: unknown, loadedAt?: unknown): Promise<void> {
  requirePermission(ctx, "supplier_return.manage", ONLY_BOOKS);
  await withTenant(ctx.userId, ctx.tenantId, async (tx) => {
    const stored = await lockReturn(tx, ctx, id, loadedAt);
    if (stored.status !== "draft") throw new UserError("This return is posted and cannot be removed.");
    await tx.execute(sql`delete from supplier_return_lines where tenant_id = ${ctx.tenantId}::uuid and return_id = ${stored.id}::uuid`);
    await tx.delete(supplierReturns).where(and(eq(supplierReturns.tenantId, ctx.tenantId), eq(supplierReturns.id, stored.id)));
    await audit(tx, ctx, { action: "supplier_return.discard", entity: "supplier_return", entityId: stored.id, before: describe(stored.date, stored.reason, stored.supplierReference, stored.receipt, stored.lines.length), after: null });
  });
}

/** Posts a draft return: it takes its number, the goods leave the warehouse, and what they undo comes off the books. */
export async function postReturn(ctx: TenantContext, id: unknown, loadedAt?: unknown): Promise<{ number: string }> {
  requirePermission(ctx, "supplier_return.manage", ONLY_BOOKS);
  let date = "";
  try {
    return await withTenant(ctx.userId, ctx.tenantId, async (tx) => {
      const stored = await lockReturn(tx, ctx, id, loadedAt);
      if (stored.status !== "draft") throw new UserError("This return is already posted.");
      date = stored.date;
      // Said in plain words here; the database checks every line again as it posts.
      const worked = returnLines(await selectReturnables(tx, ctx.tenantId, stored.receipt.id), stored.lines, stored.date);
      if (!worked.ok) throw new UserError(worked.reason);
      const [row] = await tx.execute<{ number: string }>(sql`select app.post_supplier_return(${stored.id}::uuid) as number`);
      return { number: row.number };
    });
  } catch (error) {
    throw returnRefusal(error, date) ?? error;
  }
}

/** Sets what is left of a posted return's credit against other bills of the same supplier, on a day. */
export async function applyReturnCredit(ctx: TenantContext, id: unknown, raw: { date?: unknown; allocations?: readonly RawAllocation[] }, loadedAt?: unknown): Promise<{ bills: number }> {
  requirePermission(ctx, "supplier_return.manage", ONLY_BOOKS);
  if (!isIsoDate(raw.date)) throw new UserError("Enter the day the credit is set against the bills.");
  const date = raw.date;
  if (date > todayIso(new Date())) throw new UserError("That date has not come yet.");
  const read = readAllocations(raw.allocations);
  if (!read.ok) throw new UserError(read.reason);
  if (read.allocations.length === 0) throw new UserError("Enter an amount against at least one bill.");
  try {
    return await withTenant(ctx.userId, ctx.tenantId, async (tx) => {
      const stored = await lockReturn(tx, ctx, id, loadedAt);
      if (stored.status !== "posted") throw new UserError("Post the return first; what the supplier owes back is then a credit.");
      if (date < stored.date) throw new UserError(`The return is dated ${dmy(stored.date)}. Its credit cannot be set against a bill before that.`);
      for (const line of read.allocations) if (!isUuid(line.billId)) throw new UserError("A bill named is not an unpaid bill of this supplier in this branch. Reload the page.");
      const worked = settle(stored.creditLeft, date, read.allocations, await selectBillsOwed(tx, ctx.tenantId, stored.receipt.supplierId, stored.receipt.branchId), "what is left of the credit");
      if (!worked.ok) throw new UserError(worked.reason);
      const list = JSON.stringify(read.allocations.map((line) => ({ bill_id: line.billId, amount: line.amount.toFixed(2) })));
      const [row] = await tx.execute<{ bills: number }>(sql`select app.apply_supplier_return_credit(${stored.id}::uuid, ${date}::date, ${list}::jsonb) as bills`);
      return { bills: row.bills };
    });
  } catch (error) {
    throw returnRefusal(error, date) ?? error;
  }
}

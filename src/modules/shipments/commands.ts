import "server-only";
import { and, eq, sql } from "drizzle-orm";
import { audit, isUuid, withTenant, type Tx } from "@/db";
import { UserError, pgCode } from "@/lib/errors";
import { todayIso } from "@/lib/format";
import { isIsoDate } from "@/modules/currencies/rules";
import { periodRefusal } from "@/modules/numbering/rules";
import { can, type Permission, type TenantContext } from "@/modules/tenant/rules";
import { selectBillLinesToCharge, selectReceiptsToShip, selectShipment, type Shipment } from "./queries";
import { CHARGE_CLASS_LABELS, previewSpread, readCharge, readShipment, readShipmentDetails, type RawCharge, type RawShipment, type ShipmentDetails } from "./rules";
import { shipmentReceipts, shipments } from "./schema";

// The commands behind the shipment screens. A shipment, its goods and its charges are written
// here, by the app, under row-level security; the database gives the shipment its number and
// reads what each charge amounts to from its bill. Spreading the charges and cancelling a
// shipment are not the app's: each command only asks the database's own function.

function requirePermission(ctx: TenantContext, permission: Permission, refusal: string): void {
  if (!can(ctx.role, permission)) throw new UserError(refusal);
}

const ONLY_BOOKS = "Only an owner or an accountant can work on shipments.";
const SHIPMENT_GONE = "That shipment is not in this company.";
const dmy = (date: string) => date.split("-").reverse().join("-");

/** A screen opened before someone else's change must not act on what it no longer shows. */
function requireFresh(updatedAt: Date, loadedAt: unknown): void {
  const loaded = loadedAt instanceof Date ? loadedAt.toISOString() : loadedAt;
  if (typeof loaded === "string" && loaded !== "" && loaded !== updatedAt.toISOString()) {
    throw new UserError("Someone changed this shipment after you opened it. Reload the page and try again.");
  }
}

/** What to tell someone whose shipment the database refused, or null for anything unexpected. */
function shipmentRefusal(error: unknown, date: string): UserError | null {
  const code = pgCode(error);
  const closed = periodRefusal(code, date);
  if (closed) return new UserError(closed);
  if (code === "SE015") return new UserError("That date is before the day the books were opened.");
  if (code === "SE064") return new UserError("The chart of accounts lacks an account import charges post to (goods in transit, stock, cost of goods sold, input tax or advance income tax). Set the company up first.");
  if (code === "SE255") return new UserError(SHIPMENT_GONE);
  if (code === "SE256") return new UserError("This shipment was cancelled, or is closed. Reload the page.");
  if (code === "SE258") return new UserError("Goods are put on a shipment, or taken off it, only while it is open; they are posted goods received notes from its supplier into its branch, each on one shipment. Reload the page.");
  if (code === "SE259") return new UserError("That charge cannot go on the shipment: it must be a line of a posted bill of this branch charged to Goods in transit, on no other shipment, with an account that suits its kind. Reload the page.");
  if (code === "SE260") return new UserError("Every charge on this shipment has already been spread.");
  if (code === "SE261") return new UserError("Put the goods on the shipment first: the goods received notes it brought.");
  if (code === "SE262") return new UserError("A charge is spread by weight or volume, and none of the goods has any. Enter the weight or volume on the items' cards, or take the charge off and put it on again spread another way.");
  if (code === "SE263") return new UserError("That date has not come yet, or is before the goods arrived or a charge was billed.");
  if (code === "SE264") return new UserError("Take the goods and charges off the shipment first; then it can be cancelled.");
  if (code === "SE265") return new UserError("A charge that has been spread stays as it is.");
  if (code === "SE266") return new UserError("The stock changed while the charges were being spread. Nothing was changed; try again.");
  if (code === "40P01") return new UserError("Someone else was working on the same stock at that moment. Nothing was changed; try again.");
  if (code === "23505") return new UserError("That is already on a shipment. Reload the page.");
  if (code === "42501") return new UserError("Your role cannot do that.");
  if (code === "SE257" || code === "SE219" || code === "23514" || code === "23503" || code === "23502") return new UserError("This shipment could not be saved as it stands. Reload the page and try again.");
  return null;
}

async function lockShipment(tx: Tx, ctx: TenantContext, id: unknown, loadedAt?: unknown): Promise<Shipment> {
  if (!isUuid(id)) throw new UserError(SHIPMENT_GONE);
  const found = await selectShipment(tx, ctx.tenantId, id, true);
  if (!found) throw new UserError(SHIPMENT_GONE);
  requireFresh(found.updatedAt, loadedAt);
  return found;
}

/** Marks the shipment as changed, so that a page opened before this cannot act on what it no longer shows. */
async function touch(tx: Tx, ctx: TenantContext, id: string): Promise<Date> {
  const [row] = await tx
    .update(shipments)
    .set({ updatedBy: ctx.userId, updatedAt: sql`now()` })
    .where(and(eq(shipments.tenantId, ctx.tenantId), eq(shipments.id, id)))
    .returning({ updatedAt: shipments.updatedAt });
  return row.updatedAt;
}

const detailValues = (details: ShipmentDetails) => ({
  stage: details.stage,
  origin: details.origin,
  port: details.port,
  containerNo: details.containerNo,
  blNumber: details.blNumber,
  lcNumber: details.lcNumber,
  gdNumber: details.gdNumber,
  gdDate: details.gdDate,
  customsValue: details.customsValue?.toFixed(2) ?? null,
  expectedOn: details.expectedOn,
  note: details.note,
});

const describe = (details: ShipmentDetails) => ({ ...detailValues(details) });

/** Opens a shipment from a supplier into a branch. The database gives it its number. */
export async function openShipment(ctx: TenantContext, raw: RawShipment): Promise<{ id: string; number: string }> {
  requirePermission(ctx, "shipment.manage", ONLY_BOOKS);
  const read = readShipment(raw);
  if (!read.ok) throw new UserError(read.reason);
  const draft = read.shipment;
  if (draft.openedOn > todayIso(new Date())) throw new UserError("A shipment cannot be opened on a day that has not come yet.");
  try {
    return await withTenant(ctx.userId, ctx.tenantId, async (tx) => {
      if (!isUuid(draft.supplierId)) throw new UserError("Choose the supplier from the list.");
      const [supplier] = await tx.execute<{ name: string }>(sql`select name from suppliers where tenant_id = ${ctx.tenantId}::uuid and id = ${draft.supplierId}::uuid and archived_at is null`);
      if (!supplier) throw new UserError("Choose the supplier from the list.");
      if (!isUuid(draft.branchId)) throw new UserError("Choose the branch from your own branches.");
      const [branch] = await tx.execute<{ id: string }>(sql`select id from branches where tenant_id = ${ctx.tenantId}::uuid and id = ${draft.branchId}::uuid`);
      if (!branch) throw new UserError("Choose the branch from your own branches.");
      // The number is the database's: it is taken as the row is written, whatever is sent here.
      const [saved] = await tx
        .insert(shipments)
        .values({ tenantId: ctx.tenantId, number: "", openedOn: draft.openedOn, supplierId: draft.supplierId, branchId: draft.branchId, ...detailValues(draft), createdBy: ctx.userId, updatedBy: ctx.userId })
        .returning({ id: shipments.id, number: shipments.number });
      await audit(tx, ctx, { action: "shipment.open", entity: "shipment", entityId: saved.id, before: null, after: { number: saved.number, supplier: supplier.name, openedOn: draft.openedOn, ...describe(draft) } });
      return saved;
    });
  } catch (error) {
    throw shipmentRefusal(error, draft.openedOn) ?? error;
  }
}

/** Changes how far a shipment has come and what identifies it at the port. */
export async function updateShipment(ctx: TenantContext, id: unknown, raw: RawShipment, loadedAt?: unknown): Promise<{ updatedAt: Date }> {
  requirePermission(ctx, "shipment.manage", ONLY_BOOKS);
  const read = readShipmentDetails(raw);
  if (!read.ok) throw new UserError(read.reason);
  try {
    return await withTenant(ctx.userId, ctx.tenantId, async (tx) => {
      const stored = await lockShipment(tx, ctx, id, loadedAt);
      if (stored.status === "cancelled") throw new UserError("This shipment was cancelled and cannot be changed.");
      const [saved] = await tx
        .update(shipments)
        .set({ ...detailValues(read.details), updatedBy: ctx.userId, updatedAt: sql`now()` })
        .where(and(eq(shipments.tenantId, ctx.tenantId), eq(shipments.id, stored.id)))
        .returning({ updatedAt: shipments.updatedAt });
      const before = { stage: stored.stage, origin: stored.origin, port: stored.port, containerNo: stored.containerNo, blNumber: stored.blNumber, lcNumber: stored.lcNumber, gdNumber: stored.gdNumber, gdDate: stored.gdDate, customsValue: stored.customsValue?.toFixed(2) ?? null, expectedOn: stored.expectedOn, note: stored.note };
      await audit(tx, ctx, { action: "shipment.update", entity: "shipment", entityId: stored.id, before, after: describe(read.details) });
      return saved;
    });
  } catch (error) {
    throw shipmentRefusal(error, "") ?? error;
  }
}

/** Puts a posted goods received note on an open shipment. */
export async function addShipmentReceipt(ctx: TenantContext, id: unknown, receiptId: unknown, loadedAt?: unknown): Promise<{ updatedAt: Date }> {
  requirePermission(ctx, "shipment.manage", ONLY_BOOKS);
  try {
    return await withTenant(ctx.userId, ctx.tenantId, async (tx) => {
      const stored = await lockShipment(tx, ctx, id, loadedAt);
      if (stored.status !== "open") throw new UserError("Goods are put on a shipment only while it is open.");
      const choices = await selectReceiptsToShip(tx, ctx.tenantId, stored.supplierId, stored.branchId);
      const receipt = choices.find((row) => row.id === receiptId);
      if (!receipt) throw new UserError("Choose a goods received note from the list: one from this supplier, into this branch, that is on no shipment yet.");
      await tx.insert(shipmentReceipts).values({ tenantId: ctx.tenantId, shipmentId: stored.id, receiptId: receipt.id, createdBy: ctx.userId });
      await audit(tx, ctx, { action: "shipment.add_goods", entity: "shipment", entityId: stored.id, before: null, after: { number: stored.number, goodsReceived: receipt.label } });
      return { updatedAt: await touch(tx, ctx, stored.id) };
    });
  } catch (error) {
    throw shipmentRefusal(error, "") ?? error;
  }
}

/** Takes a goods received note off an open shipment. */
export async function removeShipmentReceipt(ctx: TenantContext, id: unknown, rowId: unknown, loadedAt?: unknown): Promise<{ updatedAt: Date }> {
  requirePermission(ctx, "shipment.manage", ONLY_BOOKS);
  try {
    return await withTenant(ctx.userId, ctx.tenantId, async (tx) => {
      const stored = await lockShipment(tx, ctx, id, loadedAt);
      if (stored.status !== "open") throw new UserError("Goods are taken off a shipment only while it is open.");
      const row = stored.receipts.find((receipt) => receipt.id === rowId);
      if (!row) throw new UserError("Those goods are no longer on the shipment. Reload the page.");
      await tx.delete(shipmentReceipts).where(and(eq(shipmentReceipts.tenantId, ctx.tenantId), eq(shipmentReceipts.id, row.id)));
      await audit(tx, ctx, { action: "shipment.remove_goods", entity: "shipment", entityId: stored.id, before: { number: stored.number, goodsReceived: row.number }, after: null });
      return { updatedAt: await touch(tx, ctx, stored.id) };
    });
  } catch (error) {
    throw shipmentRefusal(error, "") ?? error;
  }
}

/** Puts a charge on a shipment: a bill line charged to Goods in transit, with what kind of charge it is. */
export async function addShipmentCharge(ctx: TenantContext, id: unknown, raw: RawCharge, loadedAt?: unknown): Promise<{ updatedAt: Date }> {
  requirePermission(ctx, "shipment.manage", ONLY_BOOKS);
  const read = readCharge(raw);
  if (!read.ok) throw new UserError(read.reason);
  const charge = read.charge;
  try {
    return await withTenant(ctx.userId, ctx.tenantId, async (tx) => {
      const stored = await lockShipment(tx, ctx, id, loadedAt);
      if (stored.status === "cancelled") throw new UserError("This shipment was cancelled.");
      const line = (await selectBillLinesToCharge(tx, ctx.tenantId, stored.branchId)).find((row) => row.billLineId === charge.billLineId);
      if (!line) throw new UserError("Choose a bill line from the list: one charged to Goods in transit that is on no shipment yet.");
      if (charge.accountId !== null) {
        if (!isUuid(charge.accountId)) throw new UserError("Choose the account from the list.");
        const [account] = await tx.execute<{ id: string }>(sql`
          select id from accounts where tenant_id = ${ctx.tenantId}::uuid and id = ${charge.accountId}::uuid and not is_group and not is_control and archived_at is null
            and type = ${charge.class === "deposit" ? "asset" : "expense"}`);
        if (!account) throw new UserError(charge.class === "deposit" ? "Choose the asset account the deposit is held in." : "Choose the expense account the charge goes to.");
      }
      // Written column by column: what a charge amounts to is the database's to read from the bill.
      await tx.execute(sql`
        insert into shipment_charges (tenant_id, shipment_id, bill_line_id, class, basis, account_id, created_by)
        values (${ctx.tenantId}::uuid, ${stored.id}::uuid, ${charge.billLineId}::uuid, ${charge.class}, ${charge.basis}, ${charge.accountId}::uuid, ${ctx.userId}::uuid)`);
      await audit(tx, ctx, { action: "shipment.add_charge", entity: "shipment", entityId: stored.id, before: null, after: { number: stored.number, charge: line.label, kind: CHARGE_CLASS_LABELS[charge.class], spreadBy: charge.basis, amount: line.amount.toFixed(2) } });
      return { updatedAt: await touch(tx, ctx, stored.id) };
    });
  } catch (error) {
    throw shipmentRefusal(error, "") ?? error;
  }
}

/** Takes a charge off a shipment before it has been spread. */
export async function removeShipmentCharge(ctx: TenantContext, id: unknown, chargeId: unknown, loadedAt?: unknown): Promise<{ updatedAt: Date }> {
  requirePermission(ctx, "shipment.manage", ONLY_BOOKS);
  try {
    return await withTenant(ctx.userId, ctx.tenantId, async (tx) => {
      const stored = await lockShipment(tx, ctx, id, loadedAt);
      const charge = stored.charges.find((row) => row.id === chargeId);
      if (!charge) throw new UserError("That charge is no longer on the shipment. Reload the page.");
      if (charge.allocationId !== null) throw new UserError("That charge has been spread over the goods and stays as it is.");
      await tx.execute(sql`delete from shipment_charges where tenant_id = ${ctx.tenantId}::uuid and id = ${charge.id}::uuid`);
      await audit(tx, ctx, { action: "shipment.remove_charge", entity: "shipment", entityId: stored.id, before: { number: stored.number, charge: `${charge.billNumber}: ${charge.description}`, amount: charge.amount.toFixed(2) }, after: null });
      return { updatedAt: await touch(tx, ctx, stored.id) };
    });
  } catch (error) {
    throw shipmentRefusal(error, "") ?? error;
  }
}

/** Spreads every charge that is waiting over the shipment's goods, on a day, and closes the shipment. */
export async function allocateShipment(ctx: TenantContext, id: unknown, raw: { date?: unknown }, loadedAt?: unknown): Promise<{ allocationId: string }> {
  requirePermission(ctx, "shipment.manage", ONLY_BOOKS);
  if (!isIsoDate(raw.date)) throw new UserError("Enter the day the charges are spread.");
  const date = raw.date;
  if (date > todayIso(new Date())) throw new UserError("That date has not come yet.");
  try {
    return await withTenant(ctx.userId, ctx.tenantId, async (tx) => {
      const stored = await lockShipment(tx, ctx, id, loadedAt);
      if (stored.status === "cancelled") throw new UserError("This shipment was cancelled.");
      const waiting = stored.charges.filter((charge) => charge.allocationId === null);
      if (waiting.length === 0) throw new UserError("Every charge on this shipment has already been spread.");
      if (stored.goods.length === 0) throw new UserError("Put the goods on the shipment first: the goods received notes it brought.");
      const arrived = stored.receipts.reduce((latest, receipt) => (receipt.date > latest ? receipt.date : latest), "");
      if (date < arrived) throw new UserError(`Goods on this shipment arrived on ${dmy(arrived)}. Its charges cannot be spread before that day.`);
      const billed = waiting.reduce((latest, charge) => (charge.billDate > latest ? charge.billDate : latest), "");
      if (date < billed) throw new UserError(`A charge on this shipment was billed on ${dmy(billed)}. The charges cannot be spread before that day.`);
      // Said in plain words here; the database works the shares out again as it spreads them.
      const worked = previewSpread(waiting, stored.goods, new Map());
      if (!worked.ok) throw new UserError(worked.reason);
      const [row] = await tx.execute<{ id: string }>(sql`select app.allocate_shipment(${stored.id}::uuid, ${date}::date) as id`);
      return { allocationId: row.id };
    });
  } catch (error) {
    throw shipmentRefusal(error, date) ?? error;
  }
}

/** Cancels an open shipment that has nothing on it, with a reason. */
export async function cancelShipment(ctx: TenantContext, id: unknown, raw: { reason?: unknown }, loadedAt?: unknown): Promise<void> {
  requirePermission(ctx, "shipment.manage", ONLY_BOOKS);
  const why = typeof raw.reason === "string" ? raw.reason.trim().replace(/\s+/g, " ") : "";
  if (why.length < 3) throw new UserError("Say why the shipment is cancelled, in a few words.");
  if (why.length > 300) throw new UserError("The reason: use at most 300 characters.");
  try {
    await withTenant(ctx.userId, ctx.tenantId, async (tx) => {
      const stored = await lockShipment(tx, ctx, id, loadedAt);
      if (stored.status === "cancelled") throw new UserError("This shipment is already cancelled.");
      if (stored.status === "closed") throw new UserError("This shipment is closed: its charges have been spread over its goods. It cannot be cancelled.");
      if (stored.receipts.length > 0 || stored.charges.length > 0) throw new UserError("Take the goods and charges off the shipment first; then it can be cancelled.");
      await tx.execute(sql`select app.cancel_shipment(${stored.id}::uuid, ${why})`);
    });
  } catch (error) {
    throw shipmentRefusal(error, "") ?? error;
  }
}

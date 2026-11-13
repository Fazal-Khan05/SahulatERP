import "server-only";
import Decimal from "decimal.js";
import { and, eq, sql } from "drizzle-orm";
import { audit, isUuid, withTenant, type Tx } from "@/db";
import { UserError, pgCode } from "@/lib/errors";
import { AMOUNT_SCALE } from "@/lib/money";
import { todayIso } from "@/lib/format";
import { periodRefusal } from "@/modules/numbering/rules";
import { selectStockOnHand } from "@/modules/inventory/queries";
import { isIsoDate } from "@/modules/currencies/rules";
import { can, seesBranch, type TenantContext } from "@/modules/tenant/rules";
import { warehouses } from "@/modules/warehouses/schema";
import {
  asDraftLine,
  sameAsStored,
  selectBaseCurrency,
  selectCustomerCredit,
  selectLineItems,
  selectOrderLinesToDeliver,
  selectSalesCustomer,
  selectSalesDocument,
  selectSalesPeople,
  selectTaxContext,
  selectTaxFlags,
  type SalesCustomer,
  type SalesDocument,
} from "./queries";
import {
  KIND_LABELS,
  creditCheck,
  creditRefusal,
  deliveryLines,
  documentTotals,
  leadSalesperson,
  priceLine,
  readDelivery,
  readDraft,
  readReason,
  stockShortfall,
  type Draft,
  type DraftLine,
  type PricedLine,
  type RawDelivery,
  type RawDocument,
  type Share,
  type Totals,
} from "./rules";
import { salesDocumentLinks, salesDocuments, salesLineSalespeople, salesLines } from "./schema";

function requireManager(ctx: TenantContext): void {
  if (!can(ctx.role, "sales.manage")) throw new UserError("Your role cannot write sales documents.");
}

function requireDeliveryWriter(ctx: TenantContext): void {
  if (!can(ctx.role, "delivery.manage")) throw new UserError("Your role cannot write delivery notes.");
}

/** Who may write a document depends on what it is: the warehouse writes delivery notes and nothing else. */
function requireWriterOf(ctx: TenantContext, kind: SalesDocument["kind"]): void {
  if (kind === "delivery") requireDeliveryWriter(ctx);
  else requireManager(ctx);
}

const NOT_HERE = "That document is not in this company.";
const STALE = "Someone changed this document after you opened it. Reload the page and try again.";
const money = (amount: Decimal) => amount.toFixed(AMOUNT_SCALE);
const exactOrNull = (amount: Decimal | null) => (amount === null ? null : amount.toFixed(AMOUNT_SCALE));

/** The document, held for the rest of the transaction, or a refusal. */
async function lockDocument(tx: Tx, ctx: TenantContext, id: unknown, loadedAt?: unknown): Promise<SalesDocument> {
  if (!isUuid(id)) throw new UserError(NOT_HERE);
  const document = await selectSalesDocument(tx, ctx.tenantId, id, "update");
  if (!document) throw new UserError(NOT_HERE);
  // A screen opened before someone else's change must not act on what it no longer shows.
  const loaded = loadedAt instanceof Date ? loadedAt.toISOString() : loadedAt;
  if (typeof loaded === "string" && loaded !== "" && loaded !== document.updatedAt.toISOString()) throw new UserError(STALE);
  return document;
}

type Worked = { lines: PricedLine[]; totals: Totals; customer: SalesCustomer; branchId: string; currency: string; taxed: boolean; pricesIncludeTax: boolean };

/** Everything a document's lines are worked out from, read afresh, and the lines worked out. */
async function workOut(tx: Tx, ctx: TenantContext, facts: { customerId: string; warehouseId: string; date: string; furtherTaxExcluded: boolean; lines: readonly DraftLine[] }): Promise<Worked> {
  const customer = await selectSalesCustomer(tx, ctx.tenantId, facts.customerId);
  if (!customer) throw new UserError("Choose the customer.");
  if (customer.archived) throw new UserError(`${customer.name} is archived. Restore the customer before selling to it.`);
  if (!isUuid(facts.warehouseId)) throw new UserError("Choose the warehouse the goods leave from.");
  // Row-level security already hides the warehouses of branches this member does not work in.
  const [warehouse] = await tx.select({ branchId: warehouses.branchId }).from(warehouses).where(and(eq(warehouses.tenantId, ctx.tenantId), eq(warehouses.id, facts.warehouseId)));
  if (!warehouse || !seesBranch(ctx.branchIds, warehouse.branchId)) throw new UserError("Choose one of your warehouses.");
  const currency = await selectBaseCurrency(tx, ctx.tenantId);
  if (currency === null) throw new UserError("This company has no base currency yet. Finish setting the company up first.");
  const { context, categories } = await selectTaxContext(tx, ctx.tenantId, { customer, date: facts.date, currency, furtherTaxExcluded: facts.furtherTaxExcluded });
  const { items, prices } = await selectLineItems(tx, ctx.tenantId, { itemIds: facts.lines.map((line) => line.itemId), customerId: customer.id, date: facts.date, categories });
  const lines: PricedLine[] = [];
  for (const [index, line] of facts.lines.entries()) {
    const item = items.get(line.itemId);
    if (!item) throw new UserError(`Line ${index + 1}: choose an item.`);
    const priced = priceLine(line, item, prices.get(item.id) ?? null, context);
    if (!priced.ok) throw new UserError(`Line ${index + 1}: ${priced.reason}`);
    lines.push(priced.line);
  }
  return { lines, totals: documentTotals(lines), customer, branchId: warehouse.branchId, currency, taxed: context.seller.salesTaxRegistered, pricesIncludeTax: context.seller.pricesIncludeTax };
}

async function requireSalesPeople(tx: Tx, shares: readonly Share[]): Promise<void> {
  if (shares.length === 0) return;
  const team = await selectSalesPeople(tx);
  for (const share of shares) {
    if (!team.some((person) => person.userId === share.userId)) throw new UserError("Salespeople: choose an active owner, sales manager or salesperson of this company.");
  }
}

async function writeLines(tx: Tx, ctx: TenantContext, documentId: string, lines: readonly (PricedLine & { sourceLineId?: string })[], shares: readonly Share[]): Promise<void> {
  await tx.delete(salesLineSalespeople).where(and(eq(salesLineSalespeople.tenantId, ctx.tenantId), eq(salesLineSalespeople.documentId, documentId)));
  await tx.delete(salesLines).where(and(eq(salesLines.tenantId, ctx.tenantId), eq(salesLines.documentId, documentId)));
  if (lines.length === 0) return;
  const written = await tx
    .insert(salesLines)
    .values(
      lines.map((line, index) => ({
        tenantId: ctx.tenantId,
        documentId,
        lineNo: index + 1,
        itemId: line.itemId,
        description: line.description,
        unitId: line.unitId,
        unitFactor: line.unitFactor.toFixed(6),
        quantity: money(line.quantity),
        baseQuantity: money(line.baseQuantity),
        listPrice: exactOrNull(line.listPrice),
        priceSource: line.priceSource,
        unitPrice: money(line.unitPrice),
        discountPercent: line.discountPercent === null ? null : line.discountPercent.toFixed(4),
        discountAmount: money(line.discountAmount),
        taxCategoryId: line.taxCategoryId,
        taxKind: line.taxKind,
        taxRate: line.taxRate.toFixed(4),
        taxRateFrom: line.taxRateFrom,
        taxAmount: money(line.taxAmount),
        furtherTaxRate: line.furtherTaxRate.toFixed(4),
        furtherTaxAmount: money(line.furtherTaxAmount),
        furtherTaxReason: line.furtherTaxReason,
        extraTaxAmount: money(line.extraTaxAmount),
        retailPrice: exactOrNull(line.retailPrice),
        retailPriceBase: exactOrNull(line.retailPriceBase),
        saleType: line.saleType,
        sroScheduleNo: line.sroScheduleNo,
        sroItemSerial: line.sroItemSerial,
        fbrUomCode: line.fbrUomCode,
        hsCode: line.hsCode,
        value: money(line.value),
        total: money(line.total),
        sourceLineId: line.sourceLineId ?? null,
        createdBy: ctx.userId,
      })),
    )
    .returning({ id: salesLines.id });
  if (shares.length === 0) return;
  // Every line carries the document's shares, so a commission can later be worked out line by line.
  await tx.insert(salesLineSalespeople).values(
    written.flatMap((line) => shares.map((share) => ({ tenantId: ctx.tenantId, documentId, lineId: line.id, userId: share.userId, sharePercent: share.percent.toFixed(4), createdBy: ctx.userId }))),
  );
}

const header = (draft: Draft, worked: Worked, shares: readonly Share[]) => ({
  documentDate: draft.date,
  validUntil: draft.validUntil,
  customerId: worked.customer.id,
  warehouseId: draft.warehouseId,
  branchId: worked.branchId,
  currency: worked.currency,
  exchangeRate: "1",
  taxed: worked.taxed,
  pricesIncludeTax: worked.pricesIncludeTax,
  furtherTaxExcluded: draft.furtherTaxExcluded,
  customerReference: draft.customerReference,
  notes: draft.notes,
  salespersonId: leadSalesperson(shares),
  grossTotal: money(worked.totals.gross),
  discountTotal: money(worked.totals.discount),
  valueTotal: money(worked.totals.value),
  taxTotal: money(worked.totals.tax),
  furtherTaxTotal: money(worked.totals.furtherTax),
  extraTaxTotal: money(worked.totals.extraTax),
  total: money(worked.totals.total),
});

const describe = (kind: string, customer: string, date: string, lines: number, total: Decimal) => ({ kind, customer, date, lines, total: money(total) });
const describeStored = (document: SalesDocument) => describe(document.kind, document.customerName, document.date, document.lines.length, document.totals.total);

/** Lines whose price is not what the price lists gave, for the audit log: who sold what below or above the list. */
function priceChanges(lines: readonly PricedLine[]): { item: string; list: string | null; charged: string; discount: string | null }[] {
  return lines
    .filter((line) => line.discountPercent !== null || line.listPrice === null || !line.listPrice.eq(line.unitPrice))
    .map((line) => ({ item: line.description, list: line.listPrice === null ? null : money(line.listPrice), charged: money(line.unitPrice), discount: line.discountPercent === null ? null : `${line.discountPercent.toFixed()}%` }));
}

/**
 * Saves a quotation or a sales order as a draft: a new one, or an existing draft with its lines
 * replaced. Every line is worked out as it is saved (price, discount, tax), so a draft always
 * shows what it comes to. Returns its id.
 */
export async function saveSalesDraft(ctx: TenantContext, id: unknown, raw: RawDocument, loadedAt?: unknown): Promise<{ id: string; updatedAt: Date }> {
  requireManager(ctx);
  const read = readDraft(raw);
  if (!read.ok) throw new UserError(read.reason);
  const draft = read.draft;
  return withTenant(ctx.userId, ctx.tenantId, async (tx) => {
    const existing = id === null || id === undefined || id === "" ? null : await lockDocument(tx, ctx, id, loadedAt);
    if (existing && existing.status !== "draft") {
      throw new UserError(existing.status === "on_hold" ? "This order is waiting for approval. Take it back to a draft to change it." : "This document is submitted and cannot be changed. Cancel it and write a new one.");
    }
    if (existing && existing.kind !== draft.kind) throw new UserError(`This is a ${KIND_LABELS[existing.kind].toLowerCase()}; what a document is never changes.`);
    // A salesperson sees a document they wrote or one filed under them; giving away one they
    // did not write would take it out of their own sight halfway through the save.
    if (existing && ctx.role === "salesperson" && existing.createdBy !== ctx.userId && leadSalesperson(draft.shares) !== ctx.userId) {
      throw new UserError("Salespeople: this sale was written for you by someone else, so the largest share stays yours. A sales manager can give it to someone else.");
    }
    const worked = await workOut(tx, ctx, draft);
    await requireSalesPeople(tx, draft.shares);
    const changes = priceChanges(worked.lines);
    const after = { ...describe(draft.kind, worked.customer.name, draft.date, worked.lines.length, worked.totals.total), ...(changes.length > 0 ? { priceChanges: changes } : {}) };
    if (!existing) {
      const [row] = await tx
        .insert(salesDocuments)
        .values({ tenantId: ctx.tenantId, kind: draft.kind, ...header(draft, worked, draft.shares), createdBy: ctx.userId, updatedBy: ctx.userId })
        .returning({ id: salesDocuments.id, updatedAt: salesDocuments.updatedAt });
      await writeLines(tx, ctx, row.id, worked.lines, draft.shares);
      await audit(tx, ctx, { action: `sales_${draft.kind}.create`, entity: "sales_document", entityId: row.id, after });
      return row;
    }
    // The lines first: the header's row is held, and its totals must describe the lines it ends with.
    await writeLines(tx, ctx, existing.id, worked.lines, draft.shares);
    const [saved] = await tx
      .update(salesDocuments)
      .set({ ...header(draft, worked, draft.shares), updatedAt: sql`now()`, updatedBy: ctx.userId })
      .where(and(eq(salesDocuments.tenantId, ctx.tenantId), eq(salesDocuments.id, existing.id)))
      .returning({ id: salesDocuments.id, updatedAt: salesDocuments.updatedAt });
    await audit(tx, ctx, { action: `sales_${draft.kind}.update`, entity: "sales_document", entityId: existing.id, before: describeStored(existing), after });
    return saved;
  });
}

/** Throws a draft away. A submitted document is never removed. */
export async function discardSalesDraft(ctx: TenantContext, id: unknown, loadedAt?: unknown): Promise<{ kind: SalesDocument["kind"] }> {
  if (!can(ctx.role, "sales.manage")) requireDeliveryWriter(ctx);
  return withTenant(ctx.userId, ctx.tenantId, async (tx) => {
    const document = await lockDocument(tx, ctx, id, loadedAt);
    requireWriterOf(ctx, document.kind);
    if (document.status !== "draft") throw new UserError("Only a draft can be thrown away. A submitted document is cancelled instead.");
    await tx.delete(salesDocumentLinks).where(and(eq(salesDocumentLinks.tenantId, ctx.tenantId), eq(salesDocumentLinks.toDocumentId, document.id)));
    await tx.delete(salesLineSalespeople).where(and(eq(salesLineSalespeople.tenantId, ctx.tenantId), eq(salesLineSalespeople.documentId, document.id)));
    await tx.delete(salesLines).where(and(eq(salesLines.tenantId, ctx.tenantId), eq(salesLines.documentId, document.id)));
    await tx.delete(salesDocuments).where(and(eq(salesDocuments.tenantId, ctx.tenantId), eq(salesDocuments.id, document.id)));
    await audit(tx, ctx, { action: `sales_${document.kind}.discard`, entity: "sales_document", entityId: document.id, before: describeStored(document), after: null });
    return { kind: document.kind };
  });
}

/** Refused because an owner must first say why: the screen then asks for the reason. */
export class NeedsReason extends UserError {}

export type SubmitResult = { status: "submitted"; number: string } | { status: "on_hold"; message: string };

/** What the database's own refusals mean, for the few that can still happen after the checks here. */
function submitRefusal(error: unknown): UserError | null {
  const code = pgCode(error);
  if (code === "SE051") return new UserError("This order takes the customer over the credit limit. Only the owner can approve it.");
  if (code === "SE053") return new UserError("Give the reason for approving this order over the credit limit.");
  if (code === "SE052" || code === "SE050" || code === "SE054" || code === "SE056") return new UserError("This document could not be submitted as it stands. Open it again, save it, and submit it once more.");
  return null;
}

/**
 * Submits a draft: it takes its number and from then on never changes. Nothing is re-priced
 * here: the lines are worked out once more, and if a price, a rate or the customer's tax status
 * has changed since the draft was saved, the submit is refused so that nobody submits figures
 * they did not see.
 *
 * A sales order is weighed against the customer's credit limit. Under the limit it is
 * submitted. Over it, an owner submits it by giving a reason, which is kept on the order and in
 * the audit log; anyone else's order is put on hold for the owner instead.
 */
export async function submitSalesDocument(ctx: TenantContext, id: unknown, loadedAt?: unknown, raw: { reason?: unknown } = {}): Promise<SubmitResult> {
  requireManager(ctx);
  try {
    return await withTenant(ctx.userId, ctx.tenantId, (tx) => submitIn(tx, ctx, id, loadedAt, raw));
  } catch (error) {
    const refused = submitRefusal(error);
    if (refused) throw refused;
    throw error;
  }
}

class RolledBack extends Error {}

/**
 * Why a draft cannot be submitted as it stands, without submitting it: the submit is tried and
 * always undone. Null when it would go through, or would be put on hold. `needsReason` is true
 * when all that is missing is the owner's reason for approving it over the credit limit.
 */
export async function submitProblem(ctx: TenantContext, id: unknown): Promise<{ message: string; needsReason: boolean } | null> {
  if (!can(ctx.role, "sales.manage")) return null;
  try {
    await withTenant(ctx.userId, ctx.tenantId, async (tx) => {
      await submitIn(tx, ctx, id, undefined, {});
      throw new RolledBack();
    });
  } catch (error) {
    if (error instanceof RolledBack) return null;
    const refused = error instanceof UserError ? error : submitRefusal(error);
    if (refused) return { message: refused.message, needsReason: refused instanceof NeedsReason };
    throw error;
  }
  return null;
}

async function submitIn(tx: Tx, ctx: TenantContext, id: unknown, loadedAt: unknown, raw: { reason?: unknown }): Promise<SubmitResult> {
  const document = await lockDocument(tx, ctx, id, loadedAt);
  const label = KIND_LABELS[document.kind];
  if (document.kind === "delivery") throw new UserError("A delivery note is posted from its own page, which takes its goods out of stock.");
  if (document.status === "submitted" || document.status === "cancelled") throw new UserError(`This ${label.toLowerCase()} is already submitted.`);
  if (document.status === "on_hold" && !can(ctx.role, "sales.approve_credit")) throw new UserError("This order is waiting for the owner's approval.");
  if (document.lines.length === 0) throw new UserError(`A ${label.toLowerCase()} needs at least one line.`);
  const worked = await workOut(tx, ctx, { customerId: document.customerId, warehouseId: document.warehouseId, date: document.date, furtherTaxExcluded: document.furtherTaxExcluded, lines: document.lines.map(asDraftLine) });
  if (worked.taxed !== document.taxed || worked.pricesIncludeTax !== document.pricesIncludeTax || document.lines.some((line, index) => !sameAsStored(line, worked.lines[index]))) {
    throw new UserError(
      document.status === "on_hold"
        ? "A price or a tax rate has changed since this order was written. Send it back to a draft so it can be saved again."
        : "A price or a tax rate has changed since this draft was saved. Check it and save it again.",
    );
  }
  // Someone credited with the sale may have left the sales team since the draft was saved.
  await requireSalesPeople(tx, document.shares);
  const mine = and(eq(salesDocuments.tenantId, ctx.tenantId), eq(salesDocuments.id, document.id));

  let overrideReason: string | null = null;
  if (document.kind === "order") {
    // One order at a time per customer: the database takes the same lock when it checks again.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`credit:${ctx.tenantId}:${document.customerId}`}, 0))`);
    const credit = await selectCustomerCredit(tx, document.customerId, document.id);
    if (!credit) throw new UserError("Choose the customer.");
    const check = creditCheck(credit, document.totals.total.times(document.exchangeRate));
    if (check.over) {
      const why = creditRefusal(credit, document.totals.total) ?? "";
      if (!can(ctx.role, "sales.approve_credit")) {
        // The database writes the audit row for a hold, an approval, a submit and a cancel itself.
        await tx.update(salesDocuments).set({ status: "on_hold", heldAt: sql`now()`, heldBy: ctx.userId, updatedAt: sql`now()`, updatedBy: ctx.userId }).where(mine);
        return { status: "on_hold", message: `${why} It now waits for the owner's approval.` };
      }
      const reason = readReason(raw.reason, "why this order is approved over the credit limit");
      if (!reason.ok) throw new NeedsReason(`${why} As the owner you can approve it: ${reason.reason.charAt(0).toLowerCase()}${reason.reason.slice(1)}`);
      overrideReason = reason.reason;
    }
  }

  // The database takes the number from the series as it marks the document submitted, copies
  // the buyer from the customer and writes the audit row; a draft thrown away leaves no gap.
  try {
    const [submitted] = await tx
      .update(salesDocuments)
      .set({ status: "submitted", submittedAt: sql`now()`, submittedBy: ctx.userId, creditOverrideReason: overrideReason, creditOverrideBy: overrideReason === null ? null : ctx.userId, updatedAt: sql`now()`, updatedBy: ctx.userId })
      .where(mine)
      .returning({ number: salesDocuments.number });
    if (!submitted?.number) throw new UserError(NOT_HERE);
    return { status: "submitted", number: submitted.number };
  } catch (error) {
    const closed = periodRefusal(pgCode(error), document.date);
    if (closed) throw new UserError(closed);
    throw error;
  }
}

/** Takes an order that is waiting for approval back to a draft, so it can be changed. The owner sends it back the same way. */
export async function releaseSalesHold(ctx: TenantContext, id: unknown, loadedAt?: unknown): Promise<void> {
  requireManager(ctx);
  await withTenant(ctx.userId, ctx.tenantId, async (tx) => {
    const document = await lockDocument(tx, ctx, id, loadedAt);
    if (document.status !== "on_hold") throw new UserError("This order is not waiting for approval.");
    await tx
      .update(salesDocuments)
      .set({ status: "draft", heldAt: null, heldBy: null, updatedAt: sql`now()`, updatedBy: ctx.userId })
      .where(and(eq(salesDocuments.tenantId, ctx.tenantId), eq(salesDocuments.id, document.id)));
  });
}

/** Cancels a submitted quotation or order, with a reason. It keeps its number and stays readable. */
export async function cancelSalesDocument(ctx: TenantContext, id: unknown, raw: { reason?: unknown }, loadedAt?: unknown): Promise<void> {
  requireManager(ctx);
  const reason = readReason(raw.reason, "why it is cancelled");
  if (!reason.ok) throw new UserError(reason.reason);
  await withTenant(ctx.userId, ctx.tenantId, async (tx) => {
    const document = await lockDocument(tx, ctx, id, loadedAt);
    if (document.kind === "delivery") throw new UserError("A delivery note is cancelled from its own page, which puts its goods back into stock.");
    if (document.status === "cancelled") throw new UserError("This document is already cancelled.");
    if (document.status !== "submitted") throw new UserError("Only a submitted document is cancelled. A draft is simply thrown away.");
    if (document.kind === "order") {
      const delivered = (await selectOrderLinesToDeliver(tx, ctx.tenantId, document.id)).some((line) => line.delivered.gt(0));
      if (delivered) throw new UserError("Goods have been delivered against this order. Cancel its delivery notes first.");
    }
    await tx
      .update(salesDocuments)
      .set({ status: "cancelled", cancelledAt: sql`now()`, cancelledBy: ctx.userId, cancelReason: reason.reason, updatedAt: sql`now()`, updatedBy: ctx.userId })
      .where(and(eq(salesDocuments.tenantId, ctx.tenantId), eq(salesDocuments.id, document.id)));
  });
}

/**
 * Starts a sales order from a submitted quotation: a new draft with the quotation's customer,
 * lines, prices, discounts and salespeople, dated today. The tax is worked out afresh for the
 * new date. The order says which quotation it came from.
 */
export async function orderFromQuotation(ctx: TenantContext, quotationId: unknown, loadedAt?: unknown): Promise<{ id: string }> {
  requireManager(ctx);
  return withTenant(ctx.userId, ctx.tenantId, async (tx) => {
    const quotation = await lockDocument(tx, ctx, quotationId, loadedAt);
    if (quotation.kind !== "quotation") throw new UserError("An order is made from a quotation.");
    if (quotation.status !== "submitted") throw new UserError(quotation.status === "cancelled" ? "This quotation is cancelled." : "Submit the quotation first.");
    const draft: Draft = {
      kind: "order",
      date: todayIso(new Date()),
      validUntil: null,
      customerId: quotation.customerId,
      warehouseId: quotation.warehouseId,
      customerReference: quotation.customerReference,
      notes: quotation.notes,
      furtherTaxExcluded: quotation.furtherTaxExcluded,
      lines: quotation.lines.map(asDraftLine),
      shares: quotation.shares,
    };
    const worked = await workOut(tx, ctx, draft);
    await requireSalesPeople(tx, draft.shares);
    const [row] = await tx
      .insert(salesDocuments)
      .values({ tenantId: ctx.tenantId, kind: "order", ...header(draft, worked, draft.shares), createdBy: ctx.userId, updatedBy: ctx.userId })
      .returning({ id: salesDocuments.id });
    await writeLines(tx, ctx, row.id, worked.lines, draft.shares);
    await tx.insert(salesDocumentLinks).values({ tenantId: ctx.tenantId, fromDocumentId: quotation.id, toDocumentId: row.id, createdBy: ctx.userId });
    await audit(tx, ctx, { action: "sales_order.create", entity: "sales_document", entityId: row.id, after: { ...describe("order", worked.customer.name, draft.date, worked.lines.length, worked.totals.total), fromQuotation: quotation.number, ...(priceChanges(worked.lines).length > 0 ? { priceChanges: priceChanges(worked.lines) } : {}) } });
    return row;
  });
}

// ── Delivery notes ──────────────────────────────────────────────────────────────────────────────

const deliveryTotals = (lines: readonly PricedLine[]) => {
  const totals = documentTotals(lines);
  return {
    grossTotal: money(totals.gross),
    discountTotal: money(totals.discount),
    valueTotal: money(totals.value),
    taxTotal: "0",
    furtherTaxTotal: "0",
    extraTaxTotal: "0",
    total: money(totals.total),
  };
};

/**
 * Starts a delivery note from a submitted sales order: a draft that delivers everything the
 * order still has to deliver, from the order's warehouse, dated today. The quantities can then
 * be brought down for a part delivery. Nothing leaves stock until the note is posted.
 */
export async function startDelivery(ctx: TenantContext, orderId: unknown): Promise<{ id: string }> {
  requireDeliveryWriter(ctx);
  if (!isUuid(orderId)) throw new UserError(NOT_HERE);
  return withTenant(ctx.userId, ctx.tenantId, async (tx) => {
    // Read, not held: the warehouse may read an order but not change it. The database holds the order when the note is posted.
    const order = await selectSalesDocument(tx, ctx.tenantId, orderId);
    if (!order || order.kind !== "order") throw new UserError("A delivery note is made from a sales order.");
    if (order.status !== "submitted") throw new UserError(order.status === "cancelled" ? "This order is cancelled." : "Submit the order before delivering it.");
    const lines = await selectOrderLinesToDeliver(tx, ctx.tenantId, order.id);
    const wanted = lines.filter((line) => line.quantity.gt(line.delivered)).map((line) => ({ sourceLineId: line.id, quantity: line.quantity.minus(line.delivered) }));
    if (wanted.length === 0) throw new UserError("Everything on this order has been delivered.");
    const worked = deliveryLines(lines, wanted);
    if (!worked.ok) throw new UserError(worked.reason);
    const today = todayIso(new Date());
    const [row] = await tx
      .insert(salesDocuments)
      .values({
        tenantId: ctx.tenantId,
        kind: "delivery",
        // Never before the order it delivers.
        documentDate: today < order.date ? order.date : today,
        customerId: order.customerId,
        warehouseId: order.warehouseId,
        branchId: order.branchId,
        currency: order.currency,
        exchangeRate: "1",
        // As the company stands now, not as it stood when the order was written.
        ...(await selectTaxFlags(tx, ctx.tenantId)),
        // Filed under whoever the order is filed under, or failing that whoever wrote it, so
        // the people who see the order see its delivery notes. The database sets this itself.
        salespersonId: order.salespersonId ?? order.createdBy,
        sourceDocumentId: order.id,
        ...deliveryTotals(worked.lines),
        createdBy: ctx.userId,
        updatedBy: ctx.userId,
      })
      .returning({ id: salesDocuments.id });
    await writeLines(tx, ctx, row.id, worked.lines, []);
    await tx.insert(salesDocumentLinks).values({ tenantId: ctx.tenantId, fromDocumentId: order.id, toDocumentId: row.id, createdBy: ctx.userId });
    await audit(tx, ctx, { action: "sales_delivery.create", entity: "sales_document", entityId: row.id, after: { order: order.number, customer: order.customerName, lines: worked.lines.length } });
    return row;
  });
}

/** Saves a draft delivery note: its date, and how much of each line of the order it delivers. */
export async function saveDeliveryDraft(ctx: TenantContext, id: unknown, raw: RawDelivery, loadedAt?: unknown): Promise<{ id: string; updatedAt: Date }> {
  requireDeliveryWriter(ctx);
  const read = readDelivery(raw);
  if (!read.ok) throw new UserError(read.reason);
  const delivery = read.delivery;
  return withTenant(ctx.userId, ctx.tenantId, async (tx) => {
    const document = await lockDocument(tx, ctx, id, loadedAt);
    if (document.kind !== "delivery" || !document.source) throw new UserError("That is not a delivery note.");
    if (document.status !== "draft") throw new UserError("This delivery note is posted and cannot be changed. Cancel it and make a new one.");
    if (delivery.date < document.source.date) throw new UserError("A delivery note is dated on or after its order.");
    const worked = deliveryLines(await selectOrderLinesToDeliver(tx, ctx.tenantId, document.source.id), delivery.lines);
    if (!worked.ok) throw new UserError(worked.reason);
    await writeLines(tx, ctx, document.id, worked.lines, []);
    const [saved] = await tx
      .update(salesDocuments)
      .set({ documentDate: delivery.date, notes: delivery.notes, ...(await selectTaxFlags(tx, ctx.tenantId)), ...deliveryTotals(worked.lines), updatedAt: sql`now()`, updatedBy: ctx.userId })
      .where(and(eq(salesDocuments.tenantId, ctx.tenantId), eq(salesDocuments.id, document.id)))
      .returning({ id: salesDocuments.id, updatedAt: salesDocuments.updatedAt });
    await audit(tx, ctx, { action: "sales_delivery.update", entity: "sales_document", entityId: document.id, before: { date: document.date, lines: document.lines.length }, after: { date: delivery.date, lines: worked.lines.length } });
    return saved;
  });
}

/** What the database's refusals of a delivery mean, for the few that can still happen after the checks here. */
function deliveryRefusal(error: unknown, date: string): UserError | null {
  const code = pgCode(error);
  const closed = periodRefusal(code, date);
  if (closed) return new UserError(closed);
  if (code === "SE015") return new UserError("That date is before the day the books were opened.");
  if (code === "SE060") return new UserError("There is not enough in stock for this delivery note. Stock is entered first; a delivery never takes it below zero.");
  if (code === "SE061") return new UserError("This delivery note asks for more than its order still has to deliver. Open it again and check the quantities.");
  if (code === "SE066" || code === "SE067") return new UserError("The order behind this delivery note is no longer open, or is dated after the note.");
  if (code === "SE064") return new UserError("The chart of accounts has no stock or cost of goods sold account. Set the company up first.");
  if (code === "SE009") return new UserError("A delivery note is cancelled on or after its own date.");
  if (code === "SE050" || code === "SE052" || code === "SE056" || code === "SE063" || code === "SE068") return new UserError("This delivery note could not be posted as it stands. Open it again, save it, and post it once more.");
  return null;
}

/**
 * Posts a delivery note: the goods leave stock at their weighted-average cost, the cost goes to
 * cost of goods sold, and the note takes its number, all in one act of the database. Refused
 * when the warehouse does not hold enough of an item, or the order no longer has that much to
 * deliver.
 */
export async function postDelivery(ctx: TenantContext, id: unknown, loadedAt?: unknown): Promise<{ number: string }> {
  requireDeliveryWriter(ctx);
  return withTenant(ctx.userId, ctx.tenantId, async (tx) => {
    const document = await lockDocument(tx, ctx, id, loadedAt);
    if (document.kind !== "delivery" || !document.source) throw new UserError("That is not a delivery note.");
    if (document.status !== "draft") throw new UserError("This delivery note is already posted.");
    if (document.lines.length === 0) throw new UserError("Enter how much of at least one line to deliver.");
    // Said here in plain words; the database checks both again as it posts.
    const order = await selectOrderLinesToDeliver(tx, ctx.tenantId, document.source.id);
    const still = deliveryLines(order, document.lines.map((line) => ({ sourceLineId: line.sourceLineId ?? "", quantity: line.quantity })));
    if (!still.ok) throw new UserError(still.reason);
    const onHand = await selectStockOnHand(tx, ctx.tenantId, document.warehouseId, document.lines.map((line) => line.itemId));
    const short = stockShortfall(document.lines, onHand);
    if (short) {
      throw new UserError(`Not enough ${short.itemCode} in stock at ${document.warehouseName}: ${short.onHand.toFixed()} on hand, ${short.needed.toFixed()} needed. Stock is entered first; a delivery never takes it below zero.`);
    }
    try {
      const rows = await tx.execute<{ number: string }>(sql`select number from app.post_delivery(${document.id}::uuid)`);
      return { number: rows[0].number };
    } catch (error) {
      throw deliveryRefusal(error, document.date) ?? error;
    }
  });
}

/**
 * Cancels a posted delivery note, with a reason: its goods come back into stock at what they
 * went out at, its journal is reversed on the date given, and the order can be delivered again.
 */
export async function cancelDelivery(ctx: TenantContext, id: unknown, raw: { date?: unknown; reason?: unknown }, loadedAt?: unknown): Promise<void> {
  requireDeliveryWriter(ctx);
  const reason = readReason(raw.reason, "why it is cancelled");
  if (!reason.ok) throw new UserError(reason.reason);
  const date = raw.date;
  if (!isIsoDate(date)) throw new UserError("Enter the date the goods came back.");
  await withTenant(ctx.userId, ctx.tenantId, async (tx) => {
    const document = await lockDocument(tx, ctx, id, loadedAt);
    if (document.kind !== "delivery") throw new UserError("That is not a delivery note.");
    if (document.status === "cancelled") throw new UserError("This delivery note is already cancelled.");
    if (document.status !== "submitted") throw new UserError("Only a posted delivery note is cancelled. A draft is simply thrown away.");
    if (date < document.date) throw new UserError("A delivery note is cancelled on or after its own date.");
    try {
      await tx.execute(sql`select app.cancel_delivery(${document.id}::uuid, ${date}::date, ${reason.reason})`);
    } catch (error) {
      throw deliveryRefusal(error, date) ?? error;
    }
  });
}

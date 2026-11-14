import "server-only";
import Decimal from "decimal.js";
import { and, eq, sql } from "drizzle-orm";
import { audit, isUuid, withTenant, type Tx } from "@/db";
import { UserError, pgCode } from "@/lib/errors";
import { todayIso } from "@/lib/format";
import { AMOUNT_SCALE } from "@/lib/money";
import { isIsoDate } from "@/modules/currencies/rules";
import { periodRefusal } from "@/modules/numbering/rules";
import { selectOpenItems } from "@/modules/receipts/queries";
import { allocated, readAllocations, type RawReceipt } from "@/modules/receipts/rules";
import { selectSalesDocument, type SalesDocument } from "@/modules/sales/queries";
import { salesDocumentLinks, salesDocuments, salesLines } from "@/modules/sales/schema";
import { can, type TenantContext } from "@/modules/tenant/rules";
import { selectCreditNotesOf, selectReturnable, selectSettled, type ReturnableLine } from "./queries";
import { creditFigures, creditLeft, creditTotals, fitsBaseUnit, readCreditNote, type CreditFigures, type CreditNoteDraft, type RawCreditNote } from "./rules";

function requireWriter(ctx: TenantContext): void {
  if (!can(ctx.role, "credit_note.manage")) throw new UserError("Only an owner, an accountant or the sales manager can write a credit note.");
}

const NOT_HERE = "That document is not in this company.";
const STALE = "Someone changed this document after you opened it. Reload the page and try again.";
const money = (amount: Decimal) => amount.toFixed(AMOUNT_SCALE);
const plain = (quantity: Decimal) => quantity.toFixed();

/** The credit note, held for the rest of the transaction, or a refusal. */
async function lockCreditNote(tx: Tx, ctx: TenantContext, id: unknown, loadedAt?: unknown): Promise<SalesDocument & { source: NonNullable<SalesDocument["source"]> }> {
  if (!isUuid(id)) throw new UserError(NOT_HERE);
  const document = await selectSalesDocument(tx, ctx.tenantId, id, "update");
  if (!document) throw new UserError(NOT_HERE);
  if (document.kind !== "credit_note" || !document.source) throw new UserError("That is not a credit note.");
  // A screen opened before someone else's change must not act on what it no longer shows.
  const loaded = loadedAt instanceof Date ? loadedAt.toISOString() : loadedAt;
  if (typeof loaded === "string" && loaded !== "" && loaded !== document.updatedAt.toISOString()) throw new UserError(STALE);
  return { ...document, source: document.source };
}

type WorkedLine = { from: ReturnableLine; quantity: Decimal; damaged: Decimal; figures: CreditFigures };

/** The lines of a credit note worked out against the invoice as it stands now: what is left to return, and each line's share of what its invoice line billed. */
function workOut(returnable: readonly ReturnableLine[], wanted: CreditNoteDraft["lines"], pricesIncludeTax: boolean): WorkedLine[] {
  const lines: WorkedLine[] = [];
  for (const want of wanted) {
    const from = returnable.find((line) => line.id === want.sourceLineId);
    if (!from) throw new UserError("A line on the credit note is not a line of its invoice.");
    if (want.quantity.gt(from.left)) {
      throw new UserError(
        from.returned.quantity.isZero()
          ? `${from.itemCode}: the invoice billed ${plain(from.quantity)}, so ${plain(want.quantity)} cannot come back.`
          : `${from.itemCode}: the invoice billed ${plain(from.quantity)} and ${plain(from.returned.quantity)} has already come back, so only ${plain(from.left)} more can.`,
      );
    }
    if (!fitsBaseUnit(want.quantity, from.unitFactor) || !fitsBaseUnit(want.damaged, from.unitFactor)) throw new UserError(`${from.itemCode}: use a quantity the item's own unit can hold, with fewer decimals.`);
    lines.push({ from, quantity: want.quantity, damaged: want.damaged, figures: creditFigures(from, from.returned, want.quantity, pricesIncludeTax) });
  }
  // In the order of the invoice, whatever order they were typed in.
  return lines.sort((a, b) => a.from.lineNo - b.from.lineNo);
}

const totalsOf = (lines: readonly WorkedLine[]) => {
  const totals = creditTotals(lines.map((line) => line.figures));
  return {
    grossTotal: money(totals.gross),
    discountTotal: money(totals.discount),
    valueTotal: money(totals.value),
    taxTotal: money(totals.tax),
    furtherTaxTotal: money(totals.furtherTax),
    extraTaxTotal: money(totals.extraTax),
    total: money(totals.total),
  };
};

/**
 * Replaces the lines of a draft credit note. Each is its invoice line in everything but how
 * much, so it is copied from that line where it lies, with the quantity and what it comes to.
 */
async function writeLines(tx: Tx, ctx: TenantContext, documentId: string, lines: readonly WorkedLine[]): Promise<void> {
  await tx.delete(salesLines).where(and(eq(salesLines.tenantId, ctx.tenantId), eq(salesLines.documentId, documentId)));
  for (const [index, line] of lines.entries()) {
    const f = line.figures;
    await tx.execute(sql`
      insert into sales_lines (
        tenant_id, document_id, line_no, item_id, description, unit_id, unit_factor, quantity, base_quantity, list_price, price_source, unit_price,
        discount_percent, discount_amount, tax_category_id, tax_kind, tax_rate, tax_rate_from, tax_amount, further_tax_rate, further_tax_amount, further_tax_reason,
        extra_tax_amount, retail_price, retail_price_base, sale_type, sro_schedule_no, sro_item_serial, fbr_uom_code, hs_code, source_line_id, damaged_quantity,
        value, total, created_by)
      select o.tenant_id, ${documentId}::uuid, ${index + 1}, o.item_id, o.description, o.unit_id, o.unit_factor, ${money(line.quantity)}::numeric, ${money(line.quantity)}::numeric * o.unit_factor,
        o.list_price, o.price_source, o.unit_price,
        o.discount_percent, ${money(f.discountAmount)}::numeric, o.tax_category_id, o.tax_kind, o.tax_rate, o.tax_rate_from, ${money(f.taxAmount)}::numeric, o.further_tax_rate, ${money(f.furtherTaxAmount)}::numeric, o.further_tax_reason,
        ${money(f.extraTaxAmount)}::numeric, o.retail_price, o.retail_price_base, o.sale_type, o.sro_schedule_no, o.sro_item_serial, o.fbr_uom_code, o.hs_code, o.id, ${money(line.damaged)}::numeric,
        ${money(f.value)}::numeric, ${money(f.total)}::numeric, ${ctx.userId}::uuid
      from sales_lines o
      where o.tenant_id = ${ctx.tenantId}::uuid and o.id = ${line.from.id}::uuid`);
  }
}

/** The invoice a credit note is made from, read afresh: posted, and one this member may see. */
async function invoiceOf(tx: Tx, ctx: TenantContext, invoiceId: string): Promise<SalesDocument> {
  const invoice = await selectSalesDocument(tx, ctx.tenantId, invoiceId);
  if (!invoice || invoice.kind !== "invoice") throw new UserError("A credit note is made from a sales invoice.");
  if (invoice.status !== "submitted") throw new UserError("Post the invoice first. A draft invoice is simply changed or thrown away.");
  return invoice;
}

const describe = (customer: string, invoice: string | null, date: string, lines: readonly WorkedLine[]) => ({
  kind: "credit_note",
  customer,
  invoice,
  date,
  lines: lines.length,
  total: money(creditTotals(lines.map((line) => line.figures)).total),
});

/**
 * Starts a credit note for a posted sales invoice, as an empty draft dated today: what came
 * back is entered on its page. An invoice that already has a draft credit note opens that
 * draft again. Nothing reaches the books or the stock until the credit note is posted.
 */
export async function startCreditNote(ctx: TenantContext, invoiceId: unknown): Promise<{ id: string }> {
  requireWriter(ctx);
  if (!isUuid(invoiceId)) throw new UserError(NOT_HERE);
  return withTenant(ctx.userId, ctx.tenantId, async (tx) => {
    const invoice = await invoiceOf(tx, ctx, invoiceId);
    const existing = await selectCreditNotesOf(tx, ctx.tenantId, invoice.id);
    const draft = existing.find((note) => note.status === "draft");
    if (draft) return { id: draft.id };
    const returnable = await selectReturnable(tx, ctx.tenantId, invoice.id);
    if (!returnable.some((line) => line.left.gt(0))) throw new UserError("Everything on this invoice has already been returned.");
    const today = todayIso(new Date());
    const [row] = await tx
      .insert(salesDocuments)
      .values({
        tenantId: ctx.tenantId,
        kind: "credit_note",
        documentDate: today < invoice.date ? invoice.date : today,
        customerId: invoice.customerId,
        warehouseId: invoice.warehouseId,
        branchId: invoice.branchId,
        currency: invoice.currency,
        exchangeRate: "1",
        taxed: invoice.taxed,
        pricesIncludeTax: invoice.pricesIncludeTax,
        furtherTaxExcluded: invoice.furtherTaxExcluded,
        sourceDocumentId: invoice.id,
        createdBy: ctx.userId,
        updatedBy: ctx.userId,
      })
      .returning({ id: salesDocuments.id });
    await tx.insert(salesDocumentLinks).values({ tenantId: ctx.tenantId, fromDocumentId: invoice.id, toDocumentId: row.id, createdBy: ctx.userId });
    await audit(tx, ctx, { action: "sales_credit_note.create", entity: "sales_document", entityId: row.id, after: { from: invoice.number, customer: invoice.customerName } });
    return row;
  });
}

/**
 * Saves a draft credit note: its date, why, and for each line of the invoice how much came
 * back and how much of that is damaged. What each line comes to is its share of what the
 * invoice line billed, worked out against what earlier credit notes have already taken.
 * `changed` says whether the date, the lines or any figure is now different from what was
 * saved before.
 */
export async function saveCreditNoteDraft(ctx: TenantContext, id: unknown, raw: RawCreditNote, loadedAt?: unknown): Promise<{ id: string; updatedAt: Date; changed: boolean }> {
  requireWriter(ctx);
  const read = readCreditNote(raw);
  if (!read.ok) throw new UserError(read.reason);
  const typed = read.creditNote;
  return withTenant(ctx.userId, ctx.tenantId, async (tx) => {
    const document = await lockCreditNote(tx, ctx, id, loadedAt);
    if (document.status !== "draft") throw new UserError("This credit note is posted and cannot be changed.");
    if (typed.date < document.source.date) throw new UserError("A credit note is dated on or after its invoice.");
    const invoice = await invoiceOf(tx, ctx, document.source.id);
    const lines = workOut(await selectReturnable(tx, ctx.tenantId, invoice.id), typed.lines, invoice.pricesIncludeTax);
    let saved: { id: string; updatedAt: Date };
    try {
      // The lines first: the header's row is held, and its totals must describe the lines it ends with.
      await writeLines(tx, ctx, document.id, lines);
      [saved] = await tx
        .update(salesDocuments)
        .set({ documentDate: typed.date, notes: typed.notes, customerReference: typed.reference, ...totalsOf(lines), updatedAt: sql`now()`, updatedBy: ctx.userId })
        .where(and(eq(salesDocuments.tenantId, ctx.tenantId), eq(salesDocuments.id, document.id)))
        .returning({ id: salesDocuments.id, updatedAt: salesDocuments.updatedAt });
    } catch (error) {
      throw creditNoteRefusal(error, typed.date) ?? error;
    }
    await audit(tx, ctx, {
      action: "sales_credit_note.update",
      entity: "sales_document",
      entityId: document.id,
      before: { date: document.date, lines: document.lines.length, total: money(document.totals.total) },
      after: describe(invoice.customerName, invoice.number, typed.date, lines),
    });
    // Whether what the credit note comes to is still what the page showed before this save.
    const changed =
      document.date !== typed.date ||
      document.lines.length !== lines.length ||
      document.lines.some((stored, index) => {
        const now = lines[index];
        return stored.sourceLineId !== now.from.id || !stored.quantity.eq(now.quantity) || !(stored.damagedQuantity ?? new Decimal(0)).eq(now.damaged) || !stored.total.eq(now.figures.total) || !stored.taxAmount.eq(now.figures.taxAmount);
      });
    return { ...saved, changed };
  });
}

/** What the database's refusals of a credit note mean, for the few that can still happen after the checks here. */
function creditNoteRefusal(error: unknown, date: string): UserError | null {
  const code = pgCode(error);
  const closed = periodRefusal(code, date);
  if (closed) return new UserError(closed);
  if (code === "SE015") return new UserError("That date is before the day the books were opened.");
  if (code === "SE064") return new UserError("The chart of accounts is missing an account that credit notes post to. Set the company up first.");
  if (code === "SE102") return new UserError("One of the invoices cannot take that much: it is no longer unpaid by that amount, or is dated after this. Reload the page and check the amounts.");
  if (code === "SE108") return new UserError("That date is too early: credit is set against an invoice on or after the day of its credit note.");
  if (code === "SE111") return new UserError("That date has not come yet. Nothing is recorded before it happens.");
  if (code === "SE113") return new UserError("This credit note's invoice is no longer one it can be posted against, or is dated after the credit note.");
  if (code === "SE114") return new UserError("More is being returned than is left of what the invoice billed. Open the credit note again and check the quantities.");
  if (code === "SE115") return new UserError("Another credit note for this invoice was posted after this one was saved. Check it and save it again.");
  if (code === "SE118") return new UserError("That is more than is left of this credit. Reload the page and check the amounts.");
  if (code === "SE121") return new UserError("The books have no record of these goods leaving stock on this invoice, so they cannot be taken back here.");
  if (code === "42501") return new UserError("Your role cannot do that.");
  if (code === "SE050" || code === "SE052" || code === "SE056" || code === "SE112" || code === "SE117" || code === "SE120" || code === "SE074") {
    return new UserError("That could not be done to this credit note as it stands. Reload the page and try again.");
  }
  return null;
}

/**
 * Posts a credit note: it takes its number and goes into the books in one act of the database.
 * Sales and the tax on them come down; what the customer still owes on the invoice comes down,
 * and anything beyond that is left as the customer's credit; goods that can be sold again go
 * back into stock at the cost they left at, and damaged goods are written off. The figures are
 * worked out once more first: if another credit note for the invoice has been posted since the
 * draft was saved, the post is refused so that nobody posts figures they did not see.
 */
export async function postCreditNote(ctx: TenantContext, id: unknown, loadedAt?: unknown): Promise<{ number: string; setAgainstInvoice: Decimal; leftAsCredit: Decimal }> {
  requireWriter(ctx);
  return withTenant(ctx.userId, ctx.tenantId, async (tx) => {
    const document = await lockCreditNote(tx, ctx, id, loadedAt);
    if (document.status !== "draft") throw new UserError("This credit note is already posted.");
    if (document.lines.length === 0) throw new UserError("Enter how much of at least one line came back.");
    if (document.date > todayIso(new Date())) throw new UserError("That date has not come yet. Nothing is recorded before it happens.");
    const invoice = await invoiceOf(tx, ctx, document.source.id);
    const wanted = document.lines.map((line) => ({ sourceLineId: line.sourceLineId ?? "", quantity: line.quantity, damaged: line.damagedQuantity ?? new Decimal(0) }));
    const worked = workOut(await selectReturnable(tx, ctx.tenantId, invoice.id), wanted, invoice.pricesIncludeTax);
    const same = worked.every((line) => {
      const stored = document.lines.find((candidate) => candidate.sourceLineId === line.from.id);
      const f = line.figures;
      return stored && stored.value.eq(f.value) && stored.taxAmount.eq(f.taxAmount) && stored.furtherTaxAmount.eq(f.furtherTaxAmount) && stored.extraTaxAmount.eq(f.extraTaxAmount) && stored.discountAmount.eq(f.discountAmount);
    });
    if (!same) throw new UserError("Another credit note for this invoice was posted after this one was saved. Check it and save it again.");
    try {
      const [posted] = await tx.execute<{ number: string; set_against_invoice: string; left_as_credit: string }>(
        sql`select number, set_against_invoice::text, left_as_credit::text from app.post_credit_note(${document.id}::uuid)`,
      );
      return { number: posted.number, setAgainstInvoice: new Decimal(posted.set_against_invoice), leftAsCredit: new Decimal(posted.left_as_credit) };
    } catch (error) {
      throw creditNoteRefusal(error, document.date) ?? error;
    }
  });
}

/** Sets part or all of the credit a posted credit note left with the customer against the customer's unpaid invoices, from a day. */
export async function applyCredit(ctx: TenantContext, id: unknown, raw: { date?: unknown; allocations?: RawReceipt["allocations"] }): Promise<{ invoices: number }> {
  if (!can(ctx.role, "credit_note.apply")) throw new UserError("Only an owner or an accountant can set a customer's credit against invoices.");
  if (!isIsoDate(raw.date)) throw new UserError("Enter the date the credit is set against the invoices.");
  const date = raw.date;
  const read = readAllocations(raw.allocations);
  if (!read.ok) throw new UserError(read.reason);
  if (read.allocations.length === 0) throw new UserError("Enter how much of the credit goes against which invoice.");
  return withTenant(ctx.userId, ctx.tenantId, async (tx) => {
    if (!isUuid(id)) throw new UserError(NOT_HERE);
    // Read, not held: a posted document cannot be held by the app's role. The database's own function holds it.
    const document = await selectSalesDocument(tx, ctx.tenantId, id);
    if (!document) throw new UserError(NOT_HERE);
    if (document.kind !== "credit_note") throw new UserError("That is not a credit note.");
    if (document.status !== "submitted") throw new UserError("Only a posted credit note has credit to use.");
    if (date < document.date) throw new UserError("Credit is set against an invoice on or after the day of its credit note.");
    if (date > todayIso(new Date())) throw new UserError("That date has not come yet. Nothing is recorded before it happens.");
    const left = creditLeft(document.totals.total, await selectSettled(tx, document.id));
    if (allocated(read.allocations).gt(left)) throw new UserError(`This credit note has ${left.toFixed(2)} not yet set against an invoice. Lower the amounts.`);
    const open = new Map((await selectOpenItems(tx, document.customerId)).map((item) => [`${item.kind}:${item.id}`, item]));
    for (const row of read.allocations) {
      const item = open.get(`${row.kind}:${row.id}`);
      if (!item) throw new UserError("One of the invoices is not an unpaid invoice of this customer any more. Reload the page.");
      if (row.amount.gt(item.outstanding)) throw new UserError(`${item.number} has ${item.outstanding.toFixed(2)} left to pay, not ${row.amount.toFixed(2)}.`);
      if (item.date > date) throw new UserError(`${item.number} is dated after that day. Choose a day on or after the invoice.`);
    }
    const list = JSON.stringify(read.allocations.map((row) => ({ [row.kind === "invoice" ? "invoice_id" : "opening_balance_id"]: row.id, amount: row.amount.toFixed(AMOUNT_SCALE) })));
    try {
      const [row] = await tx.execute<{ invoices: number }>(sql`select app.apply_credit_note(${document.id}::uuid, ${date}::date, ${list}::jsonb) as invoices`);
      return { invoices: row.invoices };
    } catch (error) {
      throw creditNoteRefusal(error, date) ?? error;
    }
  });
}

import "server-only";
import { and, eq, sql } from "drizzle-orm";
import { audit, isUuid, withTenant, type Tx } from "@/db";
import { UserError, pgCode } from "@/lib/errors";
import { todayIso } from "@/lib/format";
import { QUANTITY_SCALE } from "@/modules/items/rules";
import { periodRefusal } from "@/modules/numbering/rules";
import { UNIT_COST_SCALE } from "@/modules/purchasing/rules";
import { can, type Permission, type TenantContext } from "@/modules/tenant/rules";
import { selectBill, selectBillSupplier, selectBillTables, selectReceiptLinesToBill, selectWithholdingOn, type SupplierBill } from "./queries";
import { figureBill, figureLines, readBill, type BillDraft, type RawBill } from "./rules";
import { purchaseSettings, supplierBillLines, supplierBills } from "./schema";

// The commands behind the supplier bill screens. A draft is written here, by the app, under
// row-level security. Posting a bill is not: the command only asks the database's own
// function, which takes the number, works the taxes out from the dated tables, writes what was
// withheld and posts the journal in the same transaction, or refuses.

function requirePermission(ctx: TenantContext, permission: Permission, refusal: string): void {
  if (!can(ctx.role, permission)) throw new UserError(refusal);
}

const ONLY_BOOKS = "Only an owner or an accountant can write supplier bills.";
const BILL_GONE = "That supplier bill is not in this company.";

/** A screen opened before someone else's change must not act on what it no longer shows. */
function requireFresh(updatedAt: Date, loadedAt: unknown): void {
  const loaded = loadedAt instanceof Date ? loadedAt.toISOString() : loadedAt;
  if (typeof loaded === "string" && loaded !== "" && loaded !== updatedAt.toISOString()) {
    throw new UserError("Someone changed this bill after you opened it. Reload the page and try again.");
  }
}

const isNew = (id: unknown) => id === null || id === undefined || id === "";

/** What to tell someone whose bill the database refused, or null for anything unexpected. */
export function billRefusal(error: unknown, date: string): UserError | null {
  const code = pgCode(error);
  const closed = periodRefusal(code, date);
  if (closed) return new UserError(closed);
  if (code === "SE015") return new UserError("That date is before the day the books were opened.");
  if (code === "SE064") return new UserError("The chart of accounts lacks an account a bill posts to (trade payables, goods received not invoiced, purchase price differences, input tax or a withholding account). Set the company up first.");
  if (code === "SE223") return new UserError(BILL_GONE);
  if (code === "SE227") return new UserError("The bill's figures are no longer what its lines and today's tax tables give: a rate, the supplier or the goods may have changed since it was saved. Open the draft, save it again, then post it.");
  if (code === "SE228") return new UserError("More has been entered than was received and is not yet billed. Another bill may have been posted since you opened this page; reload it and check the quantities.");
  if (code === "SE229") return new UserError("Sales tax can be entered only when your company is registered for sales tax and the supplier is registered with an STRN. Save the draft again with no sales tax on its lines.");
  if (code === "SE230") return new UserError("A tax rate or withholding line on this bill is not in force on the bill's date. Open the draft, choose again and save it.");
  if (code === "SE231") return new UserError("Your company does not withhold tax from suppliers. Remove the withholding lines from the bill, or switch withholding on under Purchases, Withholding tax.");
  if (code === "SE232") return new UserError("A bill with this supplier's invoice number has already been posted. Check that this is not the same invoice entered twice.");
  if (code === "SE233") return new UserError("That date has not come yet.");
  if (code === "SE234") return new UserError("A bill can charge an expense or asset account that takes plain entries: not a heading, a locked account or an archived one.");
  if (code === "SE011" || code === "SE012") return new UserError("An account on this bill is a heading or has been archived. Open the draft and choose another account.");
  if (code === "40P01") return new UserError("Someone else was working on the same supplier's bills at that moment. Nothing was changed; try again.");
  if (code === "42501") return new UserError("Your role cannot do that.");
  if (code === "SE224" || code === "SE225" || code === "SE226" || code === "SE219" || code === "23514" || code === "23503") {
    return new UserError("This bill could not be saved as it stands. Reload the page and try again.");
  }
  return null;
}

async function lockBill(tx: Tx, ctx: TenantContext, id: unknown, loadedAt?: unknown): Promise<SupplierBill> {
  if (!isUuid(id)) throw new UserError(BILL_GONE);
  const bill = await selectBill(tx, ctx.tenantId, id, true);
  if (!bill) throw new UserError(BILL_GONE);
  requireFresh(bill.updatedAt, loadedAt);
  return bill;
}

const describeDraft = (draft: BillDraft, supplier: string, figures: { amount: string; salesTax: string; provincialTax: string; total: string }, lines: number) => ({
  date: draft.date,
  supplier,
  invoice: draft.supplierInvoiceNo,
  dueDate: draft.dueDate,
  note: draft.note,
  withholding: [draft.incomeTaxCode, draft.salesTaxCode, draft.provincialTaxCode].filter(Boolean),
  lines,
  ...figures,
});

const describeStored = (bill: SupplierBill) => ({
  date: bill.date,
  supplier: bill.supplierName,
  invoice: bill.supplierInvoiceNo,
  dueDate: bill.dueDate,
  note: bill.note,
  withholding: [bill.incomeTaxCode, bill.salesTaxCode, bill.provincialTaxCode].filter(Boolean),
  lines: bill.lines.length,
  amount: bill.amount.toFixed(2),
  salesTax: bill.salesTax.toFixed(2),
  provincialTax: bill.provincialTax.toFixed(2),
  total: bill.total.toFixed(2),
});

/**
 * Saves a bill as a draft: a new one, or an existing draft with its lines replaced. Its lines
 * are worked out against what is left to bill of the goods received, and its taxes from the
 * tables in force on its date, so the draft shows what posting it will do.
 */
export async function saveBillDraft(ctx: TenantContext, id: unknown, raw: RawBill, loadedAt?: unknown): Promise<{ id: string; updatedAt: Date }> {
  requirePermission(ctx, "supplier_bill.manage", ONLY_BOOKS);
  const read = readBill(raw);
  if (!read.ok) throw new UserError(read.reason);
  const draft = read.bill;
  try {
    return await withTenant(ctx.userId, ctx.tenantId, (tx) => saveBillDraftIn(tx, ctx, id, draft, loadedAt));
  } catch (error) {
    throw billRefusal(error, draft.date) ?? error;
  }
}

/** The same, inside a transaction the caller holds: a quick market purchase writes its bill with it. */
export async function saveBillDraftIn(tx: Tx, ctx: TenantContext, id: unknown, draft: BillDraft, loadedAt?: unknown): Promise<{ id: string; updatedAt: Date }> {
  if (draft.date > todayIso(new Date())) throw new UserError("A bill cannot be dated on a day that has not come yet.");
  const stored = isNew(id) ? null : await lockBill(tx, ctx, id, loadedAt);
  if (stored && stored.status !== "draft") throw new UserError("This bill is posted and cannot be changed.");
  const supplier = await selectBillSupplier(tx, ctx.tenantId, draft.supplierId);
  if (!supplier) throw new UserError("Choose the supplier from the list.");
  if (!isUuid(draft.branchId)) throw new UserError("Choose the branch from your own branches.");
  const [branch] = await tx.execute<{ id: string }>(sql`select id from branches where tenant_id = ${ctx.tenantId}::uuid and id = ${draft.branchId}::uuid`);
  if (!branch) throw new UserError("Choose the branch from your own branches.");
  for (const line of draft.expenses) if (!isUuid(line.accountId)) throw new UserError("Choose each account from the list.");
  for (const line of [...draft.goods, ...draft.expenses]) if (line.taxCategoryId !== null && !isUuid(line.taxCategoryId)) throw new UserError("Choose each tax category from the list.");

  const [tables, toBill, withholds] = await Promise.all([selectBillTables(tx, ctx.tenantId), selectReceiptLinesToBill(tx, ctx.tenantId, supplier.id, draft.branchId), selectWithholdingOn(tx, ctx.tenantId)]);
  const figured = figureLines(draft, toBill, { inputTaxAllowed: tables.salesTaxRegistered && supplier.registered, categories: new Map(tables.categories.map((category) => [category.id, category])), rates: tables.rates });
  if (!figured.ok) throw new UserError(figured.reason);
  const lines = figured.lines;
  // A draft may be saved with nothing on it yet; whatever is on it must add up.
  const worked = lines.length === 0 ? null : figureBill(lines, { date: draft.date, incomeTaxCode: draft.incomeTaxCode, salesTaxCode: draft.salesTaxCode, provincialTaxCode: draft.provincialTaxCode }, tables.rules, { withholds, salesTaxRegistered: tables.salesTaxRegistered }, supplier.onActiveList);
  if (worked && !worked.ok) throw new UserError(worked.reason);
  if (!worked && (draft.incomeTaxCode || draft.salesTaxCode || draft.provincialTaxCode) && !withholds) throw new UserError("Your company does not withhold tax from suppliers.");
  const figures = { amount: (worked?.figures.amount ?? 0).toFixed(2), salesTax: (worked?.figures.salesTax ?? 0).toFixed(2), provincialTax: (worked?.figures.provincialTax ?? 0).toFixed(2), total: (worked?.figures.total ?? 0).toFixed(2) };
  const values = {
    billDate: draft.date,
    supplierId: supplier.id,
    branchId: draft.branchId,
    supplierInvoiceNo: draft.supplierInvoiceNo,
    dueDate: draft.dueDate,
    note: draft.note,
    incomeTaxCode: draft.incomeTaxCode,
    salesTaxCode: draft.salesTaxCode,
    provincialTaxCode: draft.provincialTaxCode,
    ...figures,
    updatedBy: ctx.userId,
  };
  let saved: { id: string; updatedAt: Date };
  let before: unknown = null;
  if (!stored) {
    [saved] = await tx
      .insert(supplierBills)
      .values({ tenantId: ctx.tenantId, createdBy: ctx.userId, ...values })
      .returning({ id: supplierBills.id, updatedAt: supplierBills.updatedAt });
  } else {
    before = describeStored(stored);
    await tx.delete(supplierBillLines).where(and(eq(supplierBillLines.tenantId, ctx.tenantId), eq(supplierBillLines.billId, stored.id)));
    [saved] = await tx
      .update(supplierBills)
      .set({ ...values, updatedAt: sql`now()` })
      .where(and(eq(supplierBills.tenantId, ctx.tenantId), eq(supplierBills.id, stored.id)))
      .returning({ id: supplierBills.id, updatedAt: supplierBills.updatedAt });
  }
  if (lines.length > 0) {
    await tx.insert(supplierBillLines).values(
      lines.map((line, index) => ({
        tenantId: ctx.tenantId,
        billId: saved.id,
        lineNo: index + 1,
        kind: line.kind,
        receiptLineId: line.receiptLineId,
        itemId: line.itemId,
        accountId: line.accountId,
        description: line.description,
        quantity: line.quantity?.toFixed(QUANTITY_SCALE) ?? null,
        unitPrice: line.unitPrice?.toFixed(UNIT_COST_SCALE) ?? null,
        amount: line.amount.toFixed(2),
        taxCategoryId: line.taxCategoryId,
        taxRate: line.taxRate?.toFixed(4) ?? null,
        salesTax: line.salesTax.toFixed(2),
        createdBy: ctx.userId,
      })),
    );
  }
  await audit(tx, ctx, { action: before === null ? "supplier_bill.create" : "supplier_bill.update", entity: "supplier_bill", entityId: saved.id, before, after: describeDraft(draft, supplier.name, figures, lines.length) });
  return saved;
}

/** Throws a draft bill away. A posted one is never removed. */
export async function discardBill(ctx: TenantContext, id: unknown, loadedAt?: unknown): Promise<void> {
  requirePermission(ctx, "supplier_bill.manage", ONLY_BOOKS);
  await withTenant(ctx.userId, ctx.tenantId, async (tx) => {
    const stored = await lockBill(tx, ctx, id, loadedAt);
    if (stored.status !== "draft") throw new UserError("This bill is posted and cannot be removed.");
    await tx.delete(supplierBillLines).where(and(eq(supplierBillLines.tenantId, ctx.tenantId), eq(supplierBillLines.billId, stored.id)));
    await tx.delete(supplierBills).where(and(eq(supplierBills.tenantId, ctx.tenantId), eq(supplierBills.id, stored.id)));
    await audit(tx, ctx, { action: "supplier_bill.discard", entity: "supplier_bill", entityId: stored.id, before: describeStored(stored), after: null });
  });
}

/** Posts a draft bill: it takes its number, the books are written, and what is left is owed to the supplier. */
export async function postBill(ctx: TenantContext, id: unknown, loadedAt?: unknown): Promise<{ number: string }> {
  requirePermission(ctx, "supplier_bill.manage", ONLY_BOOKS);
  const dated = { date: "" };
  try {
    return await withTenant(ctx.userId, ctx.tenantId, (tx) => postBillIn(tx, ctx, id, loadedAt, dated));
  } catch (error) {
    throw billRefusal(error, dated.date) ?? error;
  }
}

/** The same, inside a transaction the caller holds. */
export async function postBillIn(tx: Tx, ctx: TenantContext, id: unknown, loadedAt?: unknown, dated?: { date: string }): Promise<{ number: string }> {
  const stored = await lockBill(tx, ctx, id, loadedAt);
  if (stored.status !== "draft") throw new UserError("This bill is already posted.");
  if (stored.lines.length === 0) throw new UserError("Add at least one line to the bill, save it, then post it.");
  if (dated) dated.date = stored.date;
  const [row] = await tx.execute<{ number: string }>(sql`select app.post_supplier_bill(${stored.id}::uuid) as number`);
  return { number: row.number };
}

/** Switches withholding tax from suppliers on or off for the company. */
export async function setWithholding(ctx: TenantContext, on: unknown): Promise<void> {
  requirePermission(ctx, "supplier_bill.manage", "Only an owner or an accountant can change whether the company withholds tax.");
  const wanted = on === true || on === "on" || on === "true";
  await withTenant(ctx.userId, ctx.tenantId, async (tx) => {
    const before = await selectWithholdingOn(tx, ctx.tenantId);
    if (before === wanted) return;
    await tx
      .insert(purchaseSettings)
      .values({ tenantId: ctx.tenantId, withholdingOn: wanted, updatedBy: ctx.userId })
      .onConflictDoUpdate({ target: purchaseSettings.tenantId, set: { withholdingOn: wanted, updatedBy: ctx.userId, updatedAt: sql`now()` } });
    await audit(tx, ctx, { action: "purchase_settings.update", entity: "purchase_settings", before: { withholdingOn: before }, after: { withholdingOn: wanted } });
  });
}

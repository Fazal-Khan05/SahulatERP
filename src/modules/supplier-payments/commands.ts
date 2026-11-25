import "server-only";
import { and, eq, sql } from "drizzle-orm";
import { audit, isUuid, withTenant, type Tx } from "@/db";
import { UserError, pgCode } from "@/lib/errors";
import { todayIso } from "@/lib/format";
import { isIsoDate } from "@/modules/currencies/rules";
import { periodRefusal } from "@/modules/numbering/rules";
import { can, type Permission, type TenantContext } from "@/modules/tenant/rules";
import { selectBillsOwed, selectPayment, type SupplierPayment } from "./queries";
import { readAllocations, readChallan, readPayment, settle, type PaymentDraft, type RawAllocation, type RawChallan, type RawPayment } from "./rules";
import { supplierPayments } from "./schema";

// The commands behind the supplier payment screens. A draft is written here, by the app, under
// row-level security. Posting a payment, setting an advance against bills, cancelling a payment
// and recording a challan are not: each command only asks the database's own function, which
// takes the number and posts the journal in the same transaction, or refuses.

function requirePermission(ctx: TenantContext, permission: Permission, refusal: string): void {
  if (!can(ctx.role, permission)) throw new UserError(refusal);
}

const ONLY_BOOKS = "Only an owner or an accountant can pay suppliers.";
const PAYMENT_GONE = "That supplier payment is not in this company.";
const dmy = (date: string) => date.split("-").reverse().join("-");

/** A screen opened before someone else's change must not act on what it no longer shows. */
function requireFresh(updatedAt: Date, loadedAt: unknown): void {
  const loaded = loadedAt instanceof Date ? loadedAt.toISOString() : loadedAt;
  if (typeof loaded === "string" && loaded !== "" && loaded !== updatedAt.toISOString()) {
    throw new UserError("Someone changed this payment after you opened it. Reload the page and try again.");
  }
}

const isNew = (id: unknown) => id === null || id === undefined || id === "";

/** What to tell someone whose payment or challan the database refused, or null for anything unexpected. */
export function paymentRefusal(error: unknown, date: string): UserError | null {
  const code = pgCode(error);
  const closed = periodRefusal(code, date);
  if (closed) return new UserError(closed);
  if (code === "SE015") return new UserError("That date is before the day the books were opened.");
  if (code === "SE064") return new UserError("The chart of accounts lacks an account a payment posts to (trade payables, advances to suppliers or a withholding account). Set the company up first.");
  if (code === "SE235") return new UserError(PAYMENT_GONE);
  if (code === "SE239") return new UserError("More is set against a bill than is still owed on it. Another payment may have been posted since you opened this page; reload it and check the amounts.");
  if (code === "SE240") return new UserError("More is set against bills than there is money for. Reload the page and check the amounts.");
  if (code === "SE241") return new UserError("The money leaves a cash or bank account that is in use. Choose another account, or restore the one that was archived.");
  if (code === "SE242") return new UserError("That date has not come yet, or is before what it follows: a payment is cancelled, and an advance set against a bill, on or after the day of the payment and of the bill.");
  if (code === "SE243") return new UserError("A challan pays whole amounts withheld, of its own kind of tax, withheld on or before its date, each once. Another challan may have paid one of them since you opened this page; reload it.");
  if (code === "SE267") return new UserError("The market seller is paid only what is owed on a quick market purchase's bill, never in advance. Set the whole payment against its unpaid bills.");
  if (code === "SE244") return new UserError("Enter an amount against at least one bill, each bill once.");
  if (code === "SE245") return new UserError("Choose a foreign currency from the company's own currencies (Settings, Currencies), other than the one the books are kept in.");
  if (code === "SE011" || code === "SE012") return new UserError("The account chosen is a heading or has been archived. Choose another account.");
  if (code === "40P01") return new UserError("Someone else was working on the same supplier at that moment. Nothing was changed; try again.");
  if (code === "23505") return new UserError("One of those amounts withheld has just been paid under another challan. Reload the page.");
  if (code === "42501") return new UserError("Your role cannot do that.");
  if (code === "SE236" || code === "SE237" || code === "SE238" || code === "SE219" || code === "23514" || code === "23503") {
    return new UserError("This payment could not be saved as it stands. Reload the page and try again.");
  }
  return null;
}

async function lockPayment(tx: Tx, ctx: TenantContext, id: unknown, loadedAt?: unknown): Promise<SupplierPayment> {
  if (!isUuid(id)) throw new UserError(PAYMENT_GONE);
  const payment = await selectPayment(tx, ctx.tenantId, id, true);
  if (!payment) throw new UserError(PAYMENT_GONE);
  requireFresh(payment.updatedAt, loadedAt);
  return payment;
}

const describeDraft = (draft: PaymentDraft, supplier: string, account: string, settled: string) => ({
  date: draft.date,
  supplier,
  account,
  reference: draft.reference,
  note: draft.note,
  amount: draft.amount.toFixed(2),
  foreign: draft.foreign ? `${draft.foreign.currency} ${draft.foreign.amount.toFixed(2)}` : null,
  settled,
  bills: draft.allocations.length,
});

const describeStored = (payment: SupplierPayment) => ({
  date: payment.date,
  supplier: payment.supplierName,
  account: payment.accountName,
  reference: payment.reference,
  note: payment.note,
  amount: payment.amount.toFixed(2),
  foreign: payment.foreignCurrency ? `${payment.foreignCurrency} ${payment.foreignAmount?.toFixed(2)}` : null,
  settled: payment.settled.toFixed(2),
  bills: payment.allocations.length,
});

/** Saves a payment as a draft: a new one, or an existing draft with what it settles replaced. */
export async function savePaymentDraft(ctx: TenantContext, id: unknown, raw: RawPayment, loadedAt?: unknown): Promise<{ id: string; updatedAt: Date }> {
  requirePermission(ctx, "supplier_payment.manage", ONLY_BOOKS);
  const read = readPayment(raw);
  if (!read.ok) throw new UserError(read.reason);
  const draft = read.payment;
  try {
    return await withTenant(ctx.userId, ctx.tenantId, (tx) => savePaymentDraftIn(tx, ctx, id, draft, loadedAt));
  } catch (error) {
    throw paymentRefusal(error, draft.date) ?? error;
  }
}

/** The same, inside a transaction the caller holds: a quick market purchase writes its payment with it. */
export async function savePaymentDraftIn(tx: Tx, ctx: TenantContext, id: unknown, draft: PaymentDraft, loadedAt?: unknown): Promise<{ id: string; updatedAt: Date }> {
  if (draft.date > todayIso(new Date())) throw new UserError("A payment cannot be dated on a day that has not come yet.");
  const stored = isNew(id) ? null : await lockPayment(tx, ctx, id, loadedAt);
  if (stored && stored.status !== "draft") throw new UserError("This payment is posted and cannot be changed. Cancel it and enter it again.");
  if (!isUuid(draft.supplierId)) throw new UserError("Choose the supplier from the list.");
  const [supplier] = await tx.execute<{ name: string }>(sql`select name from suppliers where tenant_id = ${ctx.tenantId}::uuid and id = ${draft.supplierId}::uuid`);
  if (!supplier) throw new UserError("Choose the supplier from the list.");
  if (!isUuid(draft.branchId)) throw new UserError("Choose the branch from your own branches.");
  const [branch] = await tx.execute<{ id: string }>(sql`select id from branches where tenant_id = ${ctx.tenantId}::uuid and id = ${draft.branchId}::uuid`);
  if (!branch) throw new UserError("Choose the branch from your own branches.");
  if (!isUuid(draft.accountId)) throw new UserError("Choose the cash or bank account from the list.");
  const [account] = await tx.execute<{ name: string }>(sql`
    select code || ' ' || name as name from accounts
    where tenant_id = ${ctx.tenantId}::uuid and id = ${draft.accountId}::uuid and control_type in ('cash', 'bank') and not is_group and archived_at is null`);
  if (!account) throw new UserError("Choose the cash or bank account from the list.");
  if (draft.foreign) {
    const [currency] = await tx.execute<{ code: string }>(sql`select code from currencies where tenant_id = ${ctx.tenantId}::uuid and code = ${draft.foreign.currency} and not is_base`);
    if (!currency) throw new UserError("Choose a foreign currency from the company's own currencies (Settings, Currencies), other than the one the books are kept in.");
  }
  for (const line of draft.allocations) if (!isUuid(line.billId)) throw new UserError("A bill on the payment is not an unpaid bill of this supplier in this branch. Reload the page.");
  const worked = settle(draft.amount, draft.date, draft.allocations, await selectBillsOwed(tx, ctx.tenantId, draft.supplierId, draft.branchId), "the payment");
  if (!worked.ok) throw new UserError(worked.reason);

  const values = {
    paymentDate: draft.date,
    supplierId: draft.supplierId,
    branchId: draft.branchId,
    accountId: draft.accountId,
    reference: draft.reference,
    note: draft.note,
    amount: draft.amount.toFixed(2),
    foreignCurrency: draft.foreign?.currency ?? null,
    foreignAmount: draft.foreign?.amount.toFixed(2) ?? null,
    updatedBy: ctx.userId,
  };
  let saved: { id: string; updatedAt: Date };
  let before: unknown = null;
  if (!stored) {
    [saved] = await tx
      .insert(supplierPayments)
      .values({ tenantId: ctx.tenantId, createdBy: ctx.userId, ...values })
      .returning({ id: supplierPayments.id, updatedAt: supplierPayments.updatedAt });
  } else {
    before = describeStored(stored);
    await tx.execute(sql`delete from supplier_payment_allocations where tenant_id = ${ctx.tenantId}::uuid and payment_id = ${stored.id}::uuid`);
    [saved] = await tx
      .update(supplierPayments)
      .set({ ...values, updatedAt: sql`now()` })
      .where(and(eq(supplierPayments.tenantId, ctx.tenantId), eq(supplierPayments.id, stored.id)))
      .returning({ id: supplierPayments.id, updatedAt: supplierPayments.updatedAt });
  }
  // Written column by column: the app's role may not name the columns that say an advance was set against a bill.
  for (const line of draft.allocations) {
    await tx.execute(sql`
      insert into supplier_payment_allocations (tenant_id, payment_id, bill_id, amount, created_by)
      values (${ctx.tenantId}::uuid, ${saved.id}::uuid, ${line.billId}::uuid, ${line.amount.toFixed(2)}::numeric, ${ctx.userId}::uuid)`);
  }
  await audit(tx, ctx, { action: before === null ? "supplier_payment.create" : "supplier_payment.update", entity: "supplier_payment", entityId: saved.id, before, after: describeDraft(draft, supplier.name, account.name, worked.settled.toFixed(2)) });
  return saved;
}

/** Throws a draft payment away. A posted one is never removed; it is cancelled. */
export async function discardPayment(ctx: TenantContext, id: unknown, loadedAt?: unknown): Promise<void> {
  requirePermission(ctx, "supplier_payment.manage", ONLY_BOOKS);
  await withTenant(ctx.userId, ctx.tenantId, async (tx) => {
    const stored = await lockPayment(tx, ctx, id, loadedAt);
    if (stored.status !== "draft") throw new UserError("This payment is posted and cannot be removed. Cancel it instead.");
    await tx.execute(sql`delete from supplier_payment_allocations where tenant_id = ${ctx.tenantId}::uuid and payment_id = ${stored.id}::uuid`);
    await tx.delete(supplierPayments).where(and(eq(supplierPayments.tenantId, ctx.tenantId), eq(supplierPayments.id, stored.id)));
    await audit(tx, ctx, { action: "supplier_payment.discard", entity: "supplier_payment", entityId: stored.id, before: describeStored(stored), after: null });
  });
}

/** Posts a draft payment: it takes its number, the bills it names are settled, and the rest is an advance. */
export async function postPayment(ctx: TenantContext, id: unknown, loadedAt?: unknown): Promise<{ number: string }> {
  requirePermission(ctx, "supplier_payment.manage", ONLY_BOOKS);
  const dated = { date: "" };
  try {
    return await withTenant(ctx.userId, ctx.tenantId, (tx) => postPaymentIn(tx, ctx, id, loadedAt, dated));
  } catch (error) {
    throw paymentRefusal(error, dated.date) ?? error;
  }
}

/** The same, inside a transaction the caller holds. */
export async function postPaymentIn(tx: Tx, ctx: TenantContext, id: unknown, loadedAt?: unknown, dated?: { date: string }): Promise<{ number: string }> {
  const stored = await lockPayment(tx, ctx, id, loadedAt);
  if (stored.status !== "draft") throw new UserError("This payment is already posted.");
  if (dated) dated.date = stored.date;
  const [row] = await tx.execute<{ number: string }>(sql`select app.post_supplier_payment(${stored.id}::uuid) as number`);
  return { number: row.number };
}

/** Sets what is left of a posted payment (its advance) against bills of the same supplier, on a day. */
export async function applyAdvance(ctx: TenantContext, id: unknown, raw: { date?: unknown; allocations?: readonly RawAllocation[] }, loadedAt?: unknown): Promise<{ bills: number }> {
  requirePermission(ctx, "supplier_payment.manage", ONLY_BOOKS);
  if (!isIsoDate(raw.date)) throw new UserError("Enter the day the advance is set against the bills.");
  const date = raw.date;
  if (date > todayIso(new Date())) throw new UserError("That date has not come yet.");
  const read = readAllocations(raw.allocations);
  if (!read.ok) throw new UserError(read.reason);
  if (read.allocations.length === 0) throw new UserError("Enter an amount against at least one bill.");
  try {
    return await withTenant(ctx.userId, ctx.tenantId, async (tx) => {
      const stored = await lockPayment(tx, ctx, id, loadedAt);
      if (stored.status !== "posted") throw new UserError(stored.status === "draft" ? "Post the payment first; what it does not settle is then an advance." : "This payment was cancelled.");
      if (date < stored.date) throw new UserError(`The payment is dated ${dmy(stored.date)}. Its advance cannot be set against a bill before that.`);
      for (const line of read.allocations) if (!isUuid(line.billId)) throw new UserError("A bill named is not an unpaid bill of this supplier in this branch. Reload the page.");
      const worked = settle(stored.advance, date, read.allocations, await selectBillsOwed(tx, ctx.tenantId, stored.supplierId, stored.branchId), "what is left of the advance");
      if (!worked.ok) throw new UserError(worked.reason);
      const list = JSON.stringify(read.allocations.map((line) => ({ bill_id: line.billId, amount: line.amount.toFixed(2) })));
      const [row] = await tx.execute<{ bills: number }>(sql`select app.apply_supplier_advance(${stored.id}::uuid, ${date}::date, ${list}::jsonb) as bills`);
      return { bills: row.bills };
    });
  } catch (error) {
    throw paymentRefusal(error, date) ?? error;
  }
}

/** Takes back a payment entered by mistake: everything it posted is reversed on the day given, and its bills are owed again. */
export async function cancelPayment(ctx: TenantContext, id: unknown, raw: { date?: unknown; reason?: unknown }, loadedAt?: unknown): Promise<void> {
  requirePermission(ctx, "supplier_payment.manage", ONLY_BOOKS);
  if (!isIsoDate(raw.date)) throw new UserError("Enter the day the payment is cancelled.");
  const date = raw.date;
  if (date > todayIso(new Date())) throw new UserError("That date has not come yet.");
  const why = typeof raw.reason === "string" ? raw.reason.trim().replace(/\s+/g, " ") : "";
  if (why.length < 3) throw new UserError("Say why the payment is cancelled, in a few words.");
  if (why.length > 300) throw new UserError("The reason: use at most 300 characters.");
  try {
    await withTenant(ctx.userId, ctx.tenantId, async (tx) => {
      const stored = await lockPayment(tx, ctx, id, loadedAt);
      if (stored.status === "cancelled") throw new UserError("This payment is already cancelled.");
      if (stored.status !== "posted") throw new UserError("A draft is thrown away, not cancelled.");
      const last = stored.allocations.reduce((latest, line) => (line.appliedOn && line.appliedOn > latest ? line.appliedOn : latest), stored.date);
      if (date < last) throw new UserError(`This payment last posted something on ${dmy(last)}. It cannot be cancelled before that day.`);
      await tx.execute(sql`select app.cancel_supplier_payment(${stored.id}::uuid, ${date}::date, ${why})`);
    });
  } catch (error) {
    throw paymentRefusal(error, date) ?? error;
  }
}

/** Records a challan: tax withheld from suppliers, paid to the government out of a cash or bank account. */
export async function recordChallan(ctx: TenantContext, raw: RawChallan): Promise<{ number: string }> {
  requirePermission(ctx, "supplier_payment.manage", "Only an owner or an accountant can record a challan.");
  if (ctx.branchIds !== null) throw new UserError("A challan is for the whole company: only someone who works in every branch can record one.");
  const read = readChallan(raw);
  if (!read.ok) throw new UserError(read.reason);
  const challan = read.challan;
  if (challan.paidOn > todayIso(new Date())) throw new UserError("That date has not come yet.");
  if (!isUuid(challan.accountId)) throw new UserError("Choose the cash or bank account from the list.");
  for (const entry of challan.entryIds) if (!isUuid(entry)) throw new UserError("Tick the amounts withheld from the list.");
  try {
    return await withTenant(ctx.userId, ctx.tenantId, async (tx) => {
      const [row] = await tx.execute<{ number: string }>(sql`
        select app.record_withholding_challan(${challan.kind}, ${challan.paidOn}::date, ${challan.accountId}::uuid, ${challan.challanNo}, ${`{${challan.entryIds.join(",")}}`}::uuid[], ${challan.note}) as number`);
      return { number: row.number };
    });
  } catch (error) {
    throw paymentRefusal(error, challan.paidOn) ?? error;
  }
}

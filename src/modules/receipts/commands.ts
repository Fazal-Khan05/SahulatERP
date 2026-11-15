import "server-only";
import { and, eq, sql } from "drizzle-orm";
import { audit, isUuid, withTenant, type Tx } from "@/db";
import { UserError, pgCode } from "@/lib/errors";
import { AMOUNT_SCALE, parseAmount } from "@/lib/money";
import { isIsoDate } from "@/modules/currencies/rules";
import { periodRefusal } from "@/modules/numbering/rules";
import { customers } from "@/modules/parties/schema";
import { can, seesBranch, type TenantContext } from "@/modules/tenant/rules";
import { branches } from "@/modules/tenant/schema";
import { selectOpenItems, selectReceipt, type Receipt } from "./queries";
import { allocated, readAllocations, readReason, readReceipt, type Allocation, type RawReceipt, type ReceiptDraft } from "./rules";
import { receiptAllocations, receipts } from "./schema";
import { WALK_IN_AT_COUNTER, isWalkInCustomer } from "@/modules/counter-sales/queries";

// The commands behind the receipts screens. A draft is written here, by the app, under
// row-level security. Everything that changes the books is not: each of those commands only
// asks the database's own function, which posts, clears, bounces or cancels in one
// transaction, or refuses.

function requireManager(ctx: TenantContext): void {
  if (!can(ctx.role, "receipt.manage")) throw new UserError("Only an owner, an accountant or the recovery officer can record receipts.");
}

const NOT_HERE = "That receipt is not in this company.";

/** A screen opened before someone else's change must not act on what it no longer shows. */
function requireFresh(receipt: Receipt, loadedAt: unknown): void {
  const loaded = loadedAt instanceof Date ? loadedAt.toISOString() : loadedAt;
  if (typeof loaded === "string" && loaded !== "" && loaded !== receipt.updatedAt.toISOString()) {
    throw new UserError("Someone changed this receipt after you opened it. Reload the page and try again.");
  }
}

async function findReceipt(tx: Tx, ctx: TenantContext, id: unknown, loadedAt?: unknown): Promise<Receipt> {
  if (!isUuid(id)) throw new UserError(NOT_HERE);
  const receipt = await selectReceipt(tx, ctx.tenantId, id, true);
  if (!receipt) throw new UserError(NOT_HERE);
  requireFresh(receipt, loadedAt);
  return receipt;
}

/** A member limited to some branches records a receipt in one of them; anyone else may leave it to the whole company. */
async function requireBranch(tx: Tx, ctx: TenantContext, branchId: string | null): Promise<void> {
  if (branchId === null) {
    if (ctx.branchIds !== null) throw new UserError("Choose the branch the receipt belongs to.");
    return;
  }
  if (!isUuid(branchId) || !seesBranch(ctx.branchIds, branchId)) throw new UserError("Choose one of your branches.");
  const [found] = await tx.select({ id: branches.id }).from(branches).where(and(eq(branches.tenantId, ctx.tenantId), eq(branches.id, branchId)));
  if (!found) throw new UserError("Choose one of your branches.");
}

/**
 * Why these rows cannot be paid as asked, or null: each must be an unpaid invoice of the
 * customer, dated on or before the day, with at least that much left. The database asks the
 * same when it posts; this is so the person is told which invoice, in words.
 */
async function allocationProblem(tx: Tx, customerId: string, date: string, allocations: readonly Allocation[]): Promise<string | null> {
  if (allocations.length === 0) return null;
  const open = new Map((await selectOpenItems(tx, customerId)).map((item) => [`${item.kind}:${item.id}`, item]));
  for (const row of allocations) {
    const item = open.get(`${row.kind}:${row.id}`);
    if (!item) return "One of the invoices is not an unpaid invoice of this customer any more. Reload the page.";
    if (row.amount.gt(item.outstanding)) return `${item.number} has ${item.outstanding.toFixed(2)} left to pay, not ${row.amount.toFixed(2)}.`;
    if (item.date > date) return `${item.number} is dated after this receipt. Money received before an invoice is left as an advance and set against the invoice afterwards.`;
  }
  return null;
}

const describe = (draft: ReceiptDraft, customer: string) => ({
  date: draft.date,
  customer,
  method: draft.method,
  amount: draft.amount.toFixed(AMOUNT_SCALE),
  bankCharges: draft.bankCharges.toFixed(AMOUNT_SCALE),
  cheque: draft.cheque?.number ?? null,
  invoices: draft.allocations.length,
  setAgainstInvoices: allocated(draft.allocations).toFixed(AMOUNT_SCALE),
});
const describeStored = (receipt: Receipt) => ({
  date: receipt.date,
  customer: receipt.customerName,
  method: receipt.method,
  amount: receipt.amount.toFixed(AMOUNT_SCALE),
  bankCharges: receipt.bankCharges.toFixed(AMOUNT_SCALE),
  cheque: receipt.chequeNumber,
  invoices: receipt.paid.length,
  setAgainstInvoices: allocated(receipt.paid).toFixed(AMOUNT_SCALE),
});

/** What the database refused, in words for the person, or null for anything unexpected. */
export function receiptRefusal(error: unknown, date: string): UserError | null {
  const code = pgCode(error);
  const closed = periodRefusal(code, date);
  if (closed) return new UserError(closed);
  if (code === "SE015") return new UserError("That date is before the day the books were opened.");
  if (code === "SE064") return new UserError("The chart of accounts is missing an account that receipts post to. Set the company up first.");
  if (code === "SE102") return new UserError("One of the invoices cannot take that much: it is no longer unpaid by that amount, or is dated after this. Reload the page and check the amounts.");
  if (code === "SE103") return new UserError("The invoices come to more than the amount received.");
  if (code === "SE106") return new UserError("Choose a cash account for cash, or a bank account for a bank receipt or a cheque. An archived account cannot be used: restore it first under Chart of accounts.");
  if (code === "SE108") return new UserError("That date is too early: it is before the receipt, the date on the cheque, or the last thing that happened to it.");
  if (code === "SE110") return new UserError("That is more than is left of this advance. Reload the page and check the amounts.");
  if (code === "SE111") return new UserError("That date has not come yet. Nothing is recorded before it happens.");
  if (code === "42501") return new UserError("Your role cannot do that.");
  if (code === "SE100" || code === "SE101" || code === "SE104" || code === "SE105" || code === "SE107" || code === "SE074") {
    return new UserError("That could not be done to this receipt as it stands. Reload the page and try again.");
  }
  return null;
}

/** Saves a receipt as a draft: a new one, or an existing draft with what it pays replaced. */
export async function saveReceiptDraft(ctx: TenantContext, id: unknown, raw: RawReceipt, loadedAt?: unknown): Promise<{ id: string; updatedAt: Date }> {
  requireManager(ctx);
  const read = readReceipt(raw);
  if (!read.ok) throw new UserError(read.reason);
  const draft = read.draft;
  try {
    return await withTenant(ctx.userId, ctx.tenantId, async (tx) => {
      if (await isWalkInCustomer(tx, ctx.tenantId, draft.customerId)) throw new UserError(WALK_IN_AT_COUNTER);
      return saveReceiptDraftIn(tx, ctx, id, draft, loadedAt);
    });
  } catch (error) {
    throw savedRefusal(error, draft.date);
  }
}

/** What the database's refusals of a saved receipt mean. */
export function savedRefusal(error: unknown, date: string): unknown {
  // The table's own checks, for what a form cannot send: a cheque with an account, charges on cash.
  if (pgCode(error) === "23514") return new UserError("That receipt could not be saved as it stands. Check how the money came and where it went.");
  if (pgCode(error) === "23503") return new UserError("The account or the invoices named are not in this company. Reload the page.");
  return receiptRefusal(error, date) ?? error;
}

/** The work of saveReceiptDraft, in the caller's transaction. A counter sale (Step 22) writes its receipt with it. */
export async function saveReceiptDraftIn(tx: Tx, ctx: TenantContext, id: unknown, draft: ReceiptDraft, loadedAt?: unknown): Promise<{ id: string; updatedAt: Date }> {
  if (!isUuid(draft.customerId)) throw new UserError("Choose the customer.");
  const [customer] = await tx.select({ name: customers.name }).from(customers).where(and(eq(customers.tenantId, ctx.tenantId), eq(customers.id, draft.customerId)));
  if (!customer) throw new UserError("Choose the customer.");
  await requireBranch(tx, ctx, draft.branchId);
  if (draft.accountId !== null && !isUuid(draft.accountId)) throw new UserError("Choose the account the money went into.");
  const problem = await allocationProblem(tx, draft.customerId, draft.date, draft.allocations);
  if (problem) throw new UserError(problem);
  const values = {
    receiptDate: draft.date,
    customerId: draft.customerId,
    method: draft.method,
    accountId: draft.accountId,
    amount: draft.amount.toFixed(AMOUNT_SCALE),
    bankCharges: draft.bankCharges.toFixed(AMOUNT_SCALE),
    reference: draft.reference,
    note: draft.note,
    branchId: draft.branchId,
    chequeNumber: draft.cheque?.number ?? null,
    chequeBank: draft.cheque?.bank ?? null,
    chequeDate: draft.cheque?.date ?? null,
    updatedBy: ctx.userId,
  };
  let saved: { id: string; updatedAt: Date };
  let before: unknown = null;
  if (id === null || id === undefined || id === "") {
    [saved] = await tx
      .insert(receipts)
      .values({ tenantId: ctx.tenantId, createdBy: ctx.userId, ...values })
      .returning({ id: receipts.id, updatedAt: receipts.updatedAt });
  } else {
    const stored = await findReceipt(tx, ctx, id, loadedAt);
    if (stored.status !== "draft") throw new UserError("This receipt is posted and cannot be changed. Cancel it instead.");
    if (stored.customerId !== draft.customerId) throw new UserError("A receipt keeps its customer. Throw this draft away and start one for the other customer.");
    before = describeStored(stored);
    await tx.delete(receiptAllocations).where(and(eq(receiptAllocations.tenantId, ctx.tenantId), eq(receiptAllocations.receiptId, stored.id)));
    [saved] = await tx
      .update(receipts)
      .set({ ...values, updatedAt: sql`now()` })
      .where(and(eq(receipts.tenantId, ctx.tenantId), eq(receipts.id, stored.id)))
      .returning({ id: receipts.id, updatedAt: receipts.updatedAt });
  }
  // Written column by column: the app may name the invoice and the amount and nothing else.
  for (const row of draft.allocations) {
    await tx.execute(sql`
      insert into public.receipt_allocations (tenant_id, receipt_id, invoice_id, opening_balance_id, amount, created_by)
      values (${ctx.tenantId}, ${saved.id}, ${row.kind === "invoice" ? row.id : null}, ${row.kind === "opening" ? row.id : null}, ${row.amount.toFixed(AMOUNT_SCALE)}, ${ctx.userId})`);
  }
  await audit(tx, ctx, { action: before === null ? "receipt.create" : "receipt.update", entity: "receipt", entityId: saved.id, before, after: describe(draft, customer.name) });
  return saved;
}

/** Throws a draft receipt away. A posted one is never removed. */
export async function discardReceipt(ctx: TenantContext, id: unknown, loadedAt?: unknown): Promise<void> {
  requireManager(ctx);
  await withTenant(ctx.userId, ctx.tenantId, async (tx) => {
    const stored = await findReceipt(tx, ctx, id, loadedAt);
    if (stored.status !== "draft") throw new UserError("This receipt is posted and cannot be removed. Cancel it instead.");
    await tx.delete(receiptAllocations).where(and(eq(receiptAllocations.tenantId, ctx.tenantId), eq(receiptAllocations.receiptId, stored.id)));
    await tx.delete(receipts).where(and(eq(receipts.tenantId, ctx.tenantId), eq(receipts.id, stored.id)));
    await audit(tx, ctx, { action: "receipt.discard", entity: "receipt", entityId: stored.id, before: describeStored(stored), after: null });
  });
}

/**
 * One act on a receipt that the database itself performs and records. `date` is the day the act
 * is dated, for telling someone whose period is closed; null means the receipt's own date.
 */
async function act<T>(ctx: TenantContext, id: unknown, loadedAt: unknown, date: string | null, check: (receipt: Receipt) => void, call: (tx: Tx, receipt: Receipt) => Promise<T>): Promise<T> {
  requireManager(ctx);
  let when = date ?? "";
  try {
    return await withTenant(ctx.userId, ctx.tenantId, async (tx) => {
      const stored = await findReceipt(tx, ctx, id, loadedAt);
      when = date ?? stored.date;
      check(stored);
      return call(tx, stored);
    });
  } catch (error) {
    throw receiptRefusal(error, when) ?? error;
  }
}

/** Posts a draft receipt: it takes its number, the invoices it pays are paid by that much, and the journal is posted. */
export async function postReceipt(ctx: TenantContext, id: unknown, loadedAt?: unknown): Promise<{ number: string }> {
  return act(
    ctx,
    id,
    loadedAt,
    null,
    (receipt) => {
      if (receipt.status !== "draft") throw new UserError("This receipt is already posted.");
    },
    (tx, receipt) => postReceiptIn(tx, receipt.id),
  );
}

/** Posts a draft receipt in the caller's transaction: the database's own function does it, or refuses. */
export async function postReceiptIn(tx: Tx, receiptId: string): Promise<{ number: string }> {
  const [row] = await tx.execute<{ number: string }>(sql`select app.post_receipt(${receiptId}) as number`);
  return { number: row.number };
}

const readDay = (raw: unknown, what: string): string => {
  if (!isIsoDate(raw)) throw new UserError(`Enter the date ${what}.`);
  return raw;
};

/** A cheque in hand goes to the bank: which bank account, and when. Nothing is posted yet. */
export async function depositCheque(ctx: TenantContext, id: unknown, raw: { accountId?: unknown; date?: unknown }, loadedAt?: unknown): Promise<void> {
  const date = readDay(raw.date, "the cheque was deposited");
  const accountId = raw.accountId;
  if (!isUuid(accountId)) throw new UserError("Choose the bank account the cheque was deposited in.");
  await act(
    ctx,
    id,
    loadedAt,
    date,
    (receipt) => {
      if (receipt.chequeStage !== "received" || receipt.status !== "posted") throw new UserError("Only a cheque that is in hand can be deposited.");
      if (date < receipt.date || date < (receipt.chequeDate ?? date)) throw new UserError("A cheque is deposited on or after the day it was received, and not before the date written on it.");
    },
    (tx, receipt) => tx.execute(sql`select app.deposit_cheque(${receipt.id}, ${accountId}::uuid, ${date}::date)`),
  );
}

/** A deposited cheque has cleared: the money is in the bank, less anything the bank kept. */
export async function clearCheque(ctx: TenantContext, id: unknown, raw: { date?: unknown; bankCharges?: unknown }, loadedAt?: unknown): Promise<void> {
  const date = readDay(raw.date, "the cheque cleared");
  let charges = "0";
  if (typeof raw.bankCharges === "string" && raw.bankCharges.trim() !== "") {
    const parsed = parseAmount(raw.bankCharges);
    if (!parsed.ok) throw new UserError(`Bank charges: ${parsed.reason}`);
    charges = parsed.amount.toFixed(AMOUNT_SCALE);
  }
  await act(
    ctx,
    id,
    loadedAt,
    date,
    (receipt) => {
      if (receipt.chequeStage !== "deposited" || receipt.status !== "posted") throw new UserError("Only a cheque that has been deposited can be marked cleared.");
      if (date < (receipt.depositedOn ?? date)) throw new UserError("A cheque clears on or after the day it was deposited.");
      if (receipt.amount.lte(charges)) throw new UserError("The bank's charges must be less than the cheque.");
    },
    (tx, receipt) => tx.execute(sql`select app.clear_cheque(${receipt.id}, ${date}::date, ${charges}::numeric)`),
  );
}

/** A cheque came back unpaid: everything its receipt posted is reversed and the invoices it paid are unpaid again. */
export async function bounceCheque(ctx: TenantContext, id: unknown, raw: { date?: unknown; reason?: unknown }, loadedAt?: unknown): Promise<void> {
  const date = readDay(raw.date, "the cheque bounced");
  const reason = readReason(raw.reason, "why the cheque bounced");
  if (!reason.ok) throw new UserError(reason.reason);
  await act(
    ctx,
    id,
    loadedAt,
    date,
    (receipt) => {
      if (receipt.method !== "cheque" || receipt.status !== "posted") throw new UserError("Only a cheque that stands can bounce.");
      if (date < (receipt.clearedOn ?? receipt.depositedOn ?? receipt.date)) throw new UserError("A cheque bounces on or after the last thing that happened to it.");
    },
    (tx, receipt) => tx.execute(sql`select app.bounce_cheque(${receipt.id}, ${date}::date, ${reason.reason})`),
  );
}

/** Cancels a receipt entered by mistake: everything it posted is reversed and what it paid is unpaid again. */
export async function cancelReceipt(ctx: TenantContext, id: unknown, raw: { date?: unknown; reason?: unknown }, loadedAt?: unknown): Promise<void> {
  const date = readDay(raw.date, "of the cancellation");
  const reason = readReason(raw.reason, "why the receipt is cancelled");
  if (!reason.ok) throw new UserError(reason.reason);
  await act(
    ctx,
    id,
    loadedAt,
    date,
    (receipt) => {
      if (receipt.status === "draft") throw new UserError("This receipt is a draft. It can be changed or thrown away; only a posted receipt is cancelled.");
      if (receipt.status !== "posted") throw new UserError("This receipt has already been taken back.");
      if (receipt.method === "cheque" && receipt.chequeStage !== "received") throw new UserError("This cheque has gone to the bank. It clears or bounces; it is not cancelled.");
      if (date < receipt.date) throw new UserError("A receipt is cancelled on or after its own date.");
    },
    (tx, receipt) => tx.execute(sql`select app.cancel_receipt(${receipt.id}, ${date}::date, ${reason.reason})`),
  );
}

/** Sets part or all of a posted receipt's advance against the customer's unpaid invoices, from a day. */
export async function applyAdvance(ctx: TenantContext, id: unknown, raw: { date?: unknown; allocations?: RawReceipt["allocations"] }, loadedAt?: unknown): Promise<{ invoices: number }> {
  const date = readDay(raw.date, "the advance is set against the invoices");
  const read = readAllocations(raw.allocations);
  if (!read.ok) throw new UserError(read.reason);
  if (read.allocations.length === 0) throw new UserError("Enter how much of the advance goes against which invoice.");
  return act(
    ctx,
    id,
    loadedAt,
    date,
    (receipt) => {
      if (receipt.status !== "posted") throw new UserError("Only a receipt that stands has an advance to use.");
      if (date < receipt.date) throw new UserError("An advance is set against an invoice on or after the day it was received.");
      if (allocated(read.allocations).gt(receipt.advance)) throw new UserError(`This receipt has ${receipt.advance.toFixed(2)} not yet set against an invoice. Lower the amounts.`);
    },
    async (tx, receipt) => {
      const problem = await allocationProblem(tx, receipt.customerId, date, read.allocations);
      if (problem) throw new UserError(problem);
      const list = JSON.stringify(read.allocations.map((row) => ({ [row.kind === "invoice" ? "invoice_id" : "opening_balance_id"]: row.id, amount: row.amount.toFixed(AMOUNT_SCALE) })));
      const [row] = await tx.execute<{ invoices: number }>(sql`select app.apply_receipt_advance(${receipt.id}, ${date}::date, ${list}::jsonb) as invoices`);
      return { invoices: row.invoices };
    },
  );
}

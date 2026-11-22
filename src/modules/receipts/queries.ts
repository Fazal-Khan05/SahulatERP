import "server-only";
import Decimal from "decimal.js";
import { and, asc, desc, eq, inArray, or, sql } from "drizzle-orm";
import { isUuid, withTenant, type Tx } from "@/db";
import { UserError } from "@/lib/errors";
import { notWalkIn } from "@/modules/counter-sales/queries";
import { customers } from "@/modules/parties/schema";
import { can, type TenantContext } from "@/modules/tenant/rules";
import type { ChequeStage, OpenItem, ReceiptMethod, ReceiptStatus } from "./rules";
import { receipts } from "./schema";

// Receipts as the database holds them. Row-level security decides which receipts the reader
// sees; what a customer owes, the cash and bank accounts, and the invoices a receipt pays come
// from database functions that ask who is reading, because the recovery officer reads none of
// those tables directly.

export function requireReceiptAccess(ctx: TenantContext): void {
  if (!can(ctx.role, "receipt.read")) throw new UserError("Your role does not include receipts.");
}

export const RECEIPT_LIST_LIMIT = 200;

const exact = (value: string | null) => new Decimal(value ?? "0");

export type MoneyAccount = { id: string; code: string; name: string; kind: "cash" | "bank" };

/** The cash and bank accounts money can be received into. */
export async function listMoneyAccounts(ctx: TenantContext): Promise<MoneyAccount[]> {
  requireReceiptAccess(ctx);
  const rows = await withTenant(ctx.userId, ctx.tenantId, (tx) => tx.execute<{ id: string; code: string; name: string; kind: "cash" | "bank" }>(sql`select id, code, name, kind from app.receipt_accounts()`));
  return rows.map((row) => ({ id: row.id, code: row.code, name: row.name, kind: row.kind }));
}

type ItemRow = { kind: "invoice" | "opening"; id: string; number: string; document_date: string; due_date: string; total: string; settled: string; outstanding: string };

/** What a customer still has to pay, invoice by invoice, the one that fell due first before the next; inside a transaction the caller holds. */
export async function selectOpenItems(tx: Tx, customerId: string, all = false): Promise<OpenItem[]> {
  const rows = await tx.execute<ItemRow>(sql`
    select kind, id, number, document_date::text, due_date::text, total::text, settled::text, outstanding::text
    from app.receivables_open(${customerId}::uuid, ${all})`);
  return rows.map((row) => ({ kind: row.kind, id: row.id, number: row.number, date: row.document_date, dueDate: row.due_date, total: exact(row.total), settled: exact(row.settled), outstanding: exact(row.outstanding) }));
}

export async function listOpenItems(ctx: TenantContext, customerId: string): Promise<OpenItem[]> {
  requireReceiptAccess(ctx);
  if (!isUuid(customerId)) return [];
  return withTenant(ctx.userId, ctx.tenantId, (tx) => selectOpenItems(tx, customerId));
}

export type CustomerChoice = { id: string; code: string | null; name: string; archived: boolean };

/** Customers by part of their code or name, for choosing whose money it is. */
export async function findCustomers(ctx: TenantContext, typed: string): Promise<CustomerChoice[]> {
  requireReceiptAccess(ctx);
  const pattern = `%${typed.replace(/[^\P{Cc}]/gu, " ").trim().slice(0, 80).replace(/[\\%_]/g, "\\$&")}%`;
  const rows = await withTenant(ctx.userId, ctx.tenantId, (tx) =>
    tx
      .select({ id: customers.id, code: customers.code, name: customers.name, archivedAt: customers.archivedAt })
      .from(customers)
      .where(and(eq(customers.tenantId, ctx.tenantId), notWalkIn, or(sql`${customers.name} ilike ${pattern}`, sql`${customers.code} ilike ${pattern}`)))
      .orderBy(asc(sql`lower(${customers.name})`))
      .limit(25),
  );
  return rows.map((row) => ({ id: row.id, code: row.code, name: row.name, archived: row.archivedAt !== null }));
}

export type CustomerStanding = { id: string; code: string | null; name: string; owes: Decimal; items: OpenItem[] };

/** One customer, what the books say they owe (invoices less receipts and advances), and their unpaid invoices. */
export async function getCustomerStanding(ctx: TenantContext, customerId: string): Promise<CustomerStanding | null> {
  requireReceiptAccess(ctx);
  if (!isUuid(customerId)) return null;
  return withTenant(ctx.userId, ctx.tenantId, async (tx) => {
    const [customer] = await tx.select({ id: customers.id, code: customers.code, name: customers.name }).from(customers).where(and(eq(customers.tenantId, ctx.tenantId), eq(customers.id, customerId)));
    if (!customer) return null;
    const [credit] = await tx.execute<{ receivable: string }>(sql`select receivable::text from app.customer_credit(${customerId}::uuid)`);
    return { ...customer, owes: exact(credit?.receivable ?? "0"), items: await selectOpenItems(tx, customerId) };
  });
}

export type PaidRow = {
  id: string;
  kind: "invoice" | "opening";
  targetId: string;
  number: string | null;
  date: string | null;
  amount: Decimal;
  allocatedOn: string | null;
  /** False on a draft, and once the receipt has bounced or been cancelled. */
  counts: boolean;
  /** Set against the invoice after the receipt was posted, out of its advance. */
  later: boolean;
};

export type Receipt = {
  id: string;
  status: ReceiptStatus;
  date: string;
  customerId: string;
  customerName: string;
  method: ReceiptMethod;
  accountId: string | null;
  amount: Decimal;
  bankCharges: Decimal;
  reference: string | null;
  note: string | null;
  branchId: string | null;
  chequeNumber: string | null;
  chequeBank: string | null;
  chequeDate: string | null;
  chequeStage: ChequeStage | null;
  depositedOn: string | null;
  clearedOn: string | null;
  bouncedOn: string | null;
  bounceReason: string | null;
  number: string | null;
  journalId: string | null;
  cancelReason: string | null;
  updatedAt: Date;
  paid: PaidRow[];
  /** What the receipt holds that is not set against an invoice: the customer's advance while the receipt stands. */
  advance: Decimal;
};

const header = {
  id: receipts.id,
  status: receipts.status,
  date: receipts.receiptDate,
  customerId: receipts.customerId,
  customerName: customers.name,
  method: receipts.method,
  accountId: receipts.accountId,
  amount: receipts.amount,
  bankCharges: receipts.bankCharges,
  reference: receipts.reference,
  note: receipts.note,
  branchId: receipts.branchId,
  chequeNumber: receipts.chequeNumber,
  chequeBank: receipts.chequeBank,
  chequeDate: receipts.chequeDate,
  chequeStage: receipts.chequeStatus,
  depositedOn: receipts.depositedOn,
  clearedOn: receipts.clearedOn,
  bouncedOn: receipts.bouncedOn,
  bounceReason: receipts.bounceReason,
  number: receipts.number,
  journalId: receipts.journalId,
  cancelReason: receipts.cancelReason,
  updatedAt: receipts.updatedAt,
};

type PaidDbRow = { id: string; kind: "invoice" | "opening"; target_id: string; number: string | null; document_date: string | null; amount: string; allocated_on: string | null; counts: boolean; later: boolean };

/**
 * One receipt with what it pays, inside a transaction the caller holds; null when this member
 * may not see it. `lock` holds a draft's row: only a draft the member may write can be held by
 * the app, and nothing else needs to be, since the database's own functions hold the row and
 * look at its state again.
 */
export async function selectReceipt(tx: Tx, tenantId: string, id: string, lock = false): Promise<Receipt | null> {
  if (lock) await tx.execute(sql`select 1 from ${receipts} where ${receipts.tenantId} = ${tenantId} and ${receipts.id} = ${id} for update`);
  const [row] = await tx
    .select(header)
    .from(receipts)
    .innerJoin(customers, and(eq(customers.tenantId, receipts.tenantId), eq(customers.id, receipts.customerId)))
    .where(and(eq(receipts.tenantId, tenantId), eq(receipts.id, id)));
  if (!row) return null;
  const paid = await tx.execute<PaidDbRow>(sql`
    select id, kind, target_id, number, document_date::text, amount::text, allocated_on::text, counts, later from app.receipt_paid(${id}::uuid)`);
  const rows = paid.map((line) => ({ id: line.id, kind: line.kind, targetId: line.target_id, number: line.number, date: line.document_date, amount: exact(line.amount), allocatedOn: line.allocated_on, counts: line.counts, later: line.later }));
  const amount = exact(row.amount);
  const standing = row.status === "draft" || row.status === "posted";
  return {
    ...row,
    status: row.status as ReceiptStatus,
    method: row.method as ReceiptMethod,
    chequeStage: row.chequeStage as ChequeStage | null,
    amount,
    bankCharges: exact(row.bankCharges),
    paid: rows,
    advance: standing ? amount.minus(rows.filter((line) => row.status === "draft" || line.counts).reduce((sum, line) => sum.plus(line.amount), new Decimal(0))) : new Decimal(0),
  };
}

export async function getReceipt(ctx: TenantContext, id: string): Promise<Receipt | null> {
  requireReceiptAccess(ctx);
  if (!isUuid(id)) return null;
  return withTenant(ctx.userId, ctx.tenantId, (tx) => selectReceipt(tx, ctx.tenantId, id));
}

export type ReceiptRow = {
  id: string;
  status: ReceiptStatus;
  date: string;
  number: string | null;
  customerName: string;
  method: ReceiptMethod;
  amount: Decimal;
  chequeNumber: string | null;
  chequeBank: string | null;
  chequeDate: string | null;
  chequeStage: ChequeStage | null;
  depositedOn: string | null;
};

const listColumns = {
  id: receipts.id,
  status: receipts.status,
  date: receipts.receiptDate,
  number: receipts.number,
  customerName: customers.name,
  method: receipts.method,
  amount: receipts.amount,
  chequeNumber: receipts.chequeNumber,
  chequeBank: receipts.chequeBank,
  chequeDate: receipts.chequeDate,
  chequeStage: receipts.chequeStatus,
  depositedOn: receipts.depositedOn,
};
const asRow = (row: { status: string; method: string; chequeStage: string | null; amount: string } & Omit<ReceiptRow, "status" | "method" | "chequeStage" | "amount">): ReceiptRow => ({
  ...row,
  status: row.status as ReceiptStatus,
  method: row.method as ReceiptMethod,
  chequeStage: row.chequeStage as ChequeStage | null,
  amount: exact(row.amount),
});

/** The newest receipts first. At most RECEIPT_LIST_LIMIT. */
export async function listReceipts(ctx: TenantContext): Promise<{ rows: ReceiptRow[]; more: boolean }> {
  requireReceiptAccess(ctx);
  const found = await withTenant(ctx.userId, ctx.tenantId, (tx) =>
    tx
      .select(listColumns)
      .from(receipts)
      .innerJoin(customers, and(eq(customers.tenantId, receipts.tenantId), eq(customers.id, receipts.customerId)))
      .where(eq(receipts.tenantId, ctx.tenantId))
      .orderBy(desc(receipts.receiptDate), desc(receipts.createdAt))
      .limit(RECEIPT_LIST_LIMIT + 1),
  );
  return { more: found.length > RECEIPT_LIST_LIMIT, rows: found.slice(0, RECEIPT_LIST_LIMIT).map(asRow) };
}

/**
 * The cheques register: every cheque that still stands and has not cleared, in hand or at the
 * bank, by the date written on it, the earliest first. With `all`, cleared and bounced ones too.
 */
export async function listCheques(ctx: TenantContext, all = false): Promise<{ rows: ReceiptRow[]; more: boolean; inHand: Decimal; deposited: Decimal }> {
  requireReceiptAccess(ctx);
  const stages: ChequeStage[] = all ? ["received", "deposited", "cleared", "bounced"] : ["received", "deposited"];
  return withTenant(ctx.userId, ctx.tenantId, async (tx) => {
    const found = await tx
      .select(listColumns)
      .from(receipts)
      .innerJoin(customers, and(eq(customers.tenantId, receipts.tenantId), eq(customers.id, receipts.customerId)))
      .where(and(eq(receipts.tenantId, ctx.tenantId), eq(receipts.method, "cheque"), inArray(receipts.chequeStatus, stages), all ? undefined : eq(receipts.status, "posted")))
      .orderBy(asc(receipts.chequeDate), asc(receipts.receiptDate), asc(receipts.number))
      .limit(RECEIPT_LIST_LIMIT + 1);
    // What the Cheques in hand account should stand at: every cheque that stands and has not cleared.
    const [totals] = await tx
      .select({
        inHand: sql<string>`coalesce(sum(${receipts.amount}) filter (where ${receipts.chequeStatus} = 'received'), 0)`,
        deposited: sql<string>`coalesce(sum(${receipts.amount}) filter (where ${receipts.chequeStatus} = 'deposited'), 0)`,
      })
      .from(receipts)
      .where(and(eq(receipts.tenantId, ctx.tenantId), eq(receipts.method, "cheque"), eq(receipts.status, "posted")));
    return { more: found.length > RECEIPT_LIST_LIMIT, rows: found.slice(0, RECEIPT_LIST_LIMIT).map(asRow), inHand: exact(totals.inHand), deposited: exact(totals.deposited) };
  });
}

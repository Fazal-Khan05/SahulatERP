import "server-only";
import Decimal from "decimal.js";
import { sql } from "drizzle-orm";
import { isUuid, withTenant, type Tx } from "@/db";
import { UserError } from "@/lib/errors";
import type { WithholdingKind } from "@/modules/tax/rules";
import { can, type TenantContext } from "@/modules/tenant/rules";
import type { BillOwed, PaymentStatus } from "./rules";

// Reading supplier payments, advances and challans: for the owner and whoever keeps or checks
// the books, in the branches they work in.

export function requirePaymentAccess(ctx: TenantContext): void {
  if (!can(ctx.role, "supplier_payment.read")) throw new UserError("Your role does not include supplier payments.");
}

const d = (value: string | null) => new Decimal(value ?? "0");

type OwedRow = { bill_id: string; number: string; supplier_invoice_no: string; bill_date: string; due_date: string | null; payable: string; owed: string };

/** The posted bills of a supplier in a branch that are still owed something, oldest first. */
export async function selectBillsOwed(tx: Tx, tenantId: string, supplierId: string, branchId: string): Promise<BillOwed[]> {
  if (!isUuid(supplierId) || !isUuid(branchId)) return [];
  const rows = await tx.execute<OwedRow>(sql`
    select b.id as bill_id, b.number, b.supplier_invoice_no, b.bill_date::text, b.due_date::text, b.payable::text, (b.payable - paid.amount - back.amount)::text as owed
    from supplier_bills b
    cross join lateral (
      select coalesce(sum(a.amount), 0) as amount from supplier_payment_allocations a
      join supplier_payments p on p.tenant_id = a.tenant_id and p.id = a.payment_id
      where a.tenant_id = b.tenant_id and a.bill_id = b.id and p.status = 'posted') paid
    -- What goods sent back (Step 27) have taken off the bill.
    cross join lateral (
      select coalesce(sum(r.amount), 0) as amount from supplier_return_allocations r
      where r.tenant_id = b.tenant_id and r.bill_id = b.id) back
    where b.tenant_id = ${tenantId}::uuid and b.status = 'posted' and b.supplier_id = ${supplierId}::uuid and b.branch_id = ${branchId}::uuid and b.payable > paid.amount + back.amount
    order by b.bill_date, b.number`);
  return rows.map((row) => ({ billId: row.bill_id, number: row.number, supplierInvoiceNo: row.supplier_invoice_no, date: row.bill_date, dueDate: row.due_date, payable: d(row.payable), owed: d(row.owed) }));
}

export type PaymentAllocation = { id: string; billId: string; billNumber: string; supplierInvoiceNo: string; amount: Decimal; appliedOn: string | null };

export type SupplierPayment = {
  id: string;
  status: PaymentStatus;
  number: string | null;
  date: string;
  supplierId: string;
  supplierName: string;
  branchId: string;
  branchName: string;
  accountId: string;
  accountName: string;
  reference: string | null;
  note: string | null;
  amount: Decimal;
  foreignCurrency: string | null;
  foreignAmount: Decimal | null;
  journalId: string | null;
  cancelledOn: string | null;
  cancelReason: string | null;
  updatedAt: Date;
  allocations: PaymentAllocation[];
  /** What the payment has settled of bills, and what is left of it as an advance. */
  settled: Decimal;
  advance: Decimal;
};

type PaymentRow = {
  id: string; status: PaymentStatus; number: string | null; payment_date: string; supplier_id: string; supplier_name: string; branch_id: string; branch_name: string;
  account_id: string; account_name: string; reference: string | null; note: string | null; amount: string; foreign_currency: string | null; foreign_amount: string | null;
  journal_id: string | null; cancelled_on: string | null; cancel_reason: string | null; updated_at: Date;
};

/** One payment with what it settles, inside a transaction the caller holds. Null when it is not one this member may read. `lock` holds a draft's row. */
export async function selectPayment(tx: Tx, tenantId: string, id: string, lock = false): Promise<SupplierPayment | null> {
  // A row can be held only where it can be changed: a draft. Anything else is read as it is.
  if (lock) await tx.execute(sql`select 1 from supplier_payments where tenant_id = ${tenantId}::uuid and id = ${id}::uuid for update`);
  const [row] = await tx.execute<PaymentRow>(sql`
    select p.id, p.status, p.number, p.payment_date::text, p.supplier_id, s.name as supplier_name, p.branch_id, br.name as branch_name, p.account_id,
           a.code || ' ' || a.name as account_name, p.reference, p.note, p.amount::text, p.foreign_currency, p.foreign_amount::text, p.journal_id,
           p.cancelled_on::text, p.cancel_reason, p.updated_at
    from supplier_payments p
    join suppliers s on s.tenant_id = p.tenant_id and s.id = p.supplier_id
    join branches br on br.tenant_id = p.tenant_id and br.id = p.branch_id
    join accounts a on a.tenant_id = p.tenant_id and a.id = p.account_id
    where p.tenant_id = ${tenantId}::uuid and p.id = ${id}::uuid`);
  if (!row) return null;
  const lines = await tx.execute<{ id: string; bill_id: string; bill_number: string; supplier_invoice_no: string; amount: string; applied_on: string | null }>(sql`
    select a.id, a.bill_id, b.number as bill_number, b.supplier_invoice_no, a.amount::text, a.applied_on::text
    from supplier_payment_allocations a join supplier_bills b on b.tenant_id = a.tenant_id and b.id = a.bill_id
    where a.tenant_id = ${tenantId}::uuid and a.payment_id = ${id}::uuid
    order by a.applied_on nulls first, b.bill_date, b.number`);
  const allocations = lines.map((line) => ({ id: line.id, billId: line.bill_id, billNumber: line.bill_number, supplierInvoiceNo: line.supplier_invoice_no, amount: d(line.amount), appliedOn: line.applied_on }));
  const amount = d(row.amount);
  const settled = allocations.reduce((sum, line) => sum.plus(line.amount), new Decimal(0));
  return {
    id: row.id,
    status: row.status,
    number: row.number,
    date: row.payment_date,
    supplierId: row.supplier_id,
    supplierName: row.supplier_name,
    branchId: row.branch_id,
    branchName: row.branch_name,
    accountId: row.account_id,
    accountName: row.account_name,
    reference: row.reference,
    note: row.note,
    amount,
    foreignCurrency: row.foreign_currency,
    foreignAmount: row.foreign_amount === null ? null : d(row.foreign_amount),
    journalId: row.journal_id,
    cancelledOn: row.cancelled_on,
    cancelReason: row.cancel_reason,
    updatedAt: new Date(row.updated_at),
    allocations,
    settled,
    advance: amount.minus(settled),
  };
}

/** One payment for its own page, with the supplier's bills that are still owed (for a draft, and for setting an advance against them). */
export async function getPayment(ctx: TenantContext, id: string): Promise<(SupplierPayment & { billsOwed: BillOwed[] }) | null> {
  requirePaymentAccess(ctx);
  if (!isUuid(id)) return null;
  return withTenant(ctx.userId, ctx.tenantId, async (tx) => {
    const payment = await selectPayment(tx, ctx.tenantId, id);
    if (!payment) return null;
    const billsOwed = payment.status === "cancelled" ? [] : await selectBillsOwed(tx, ctx.tenantId, payment.supplierId, payment.branchId);
    return { ...payment, billsOwed };
  });
}

export const PAYMENT_LIST_LIMIT = 200;

export type PaymentRowSummary = { id: string; status: PaymentStatus; number: string | null; date: string; supplierName: string; accountName: string; amount: Decimal; advance: Decimal };

/** The newest payments, each with what is left of it as an advance. */
export async function listPayments(ctx: TenantContext): Promise<{ rows: PaymentRowSummary[]; more: boolean }> {
  requirePaymentAccess(ctx);
  const found = await withTenant(ctx.userId, ctx.tenantId, (tx) =>
    tx.execute<{ id: string; status: PaymentStatus; number: string | null; payment_date: string; supplier_name: string; account_name: string; amount: string; settled: string }>(sql`
      select p.id, p.status, p.number, p.payment_date::text, s.name as supplier_name, a.name as account_name, p.amount::text,
             coalesce((select sum(x.amount) from supplier_payment_allocations x where x.tenant_id = p.tenant_id and x.payment_id = p.id), 0)::text as settled
      from supplier_payments p
      join suppliers s on s.tenant_id = p.tenant_id and s.id = p.supplier_id
      join accounts a on a.tenant_id = p.tenant_id and a.id = p.account_id
      where p.tenant_id = ${ctx.tenantId}::uuid
      order by p.payment_date desc, p.created_at desc
      limit ${PAYMENT_LIST_LIMIT + 1}`),
  );
  return {
    more: found.length > PAYMENT_LIST_LIMIT,
    rows: found.slice(0, PAYMENT_LIST_LIMIT).map((row) => ({ id: row.id, status: row.status, number: row.number, date: row.payment_date, supplierName: row.supplier_name, accountName: row.account_name, amount: d(row.amount), advance: row.status === "posted" ? d(row.amount).minus(d(row.settled)) : new Decimal(0) })),
  };
}

export type Choice = { id: string; label: string };

/** The suppliers, branches, cash and bank accounts and foreign currencies a payment can name. */
export async function getPaymentChoices(ctx: TenantContext): Promise<{ suppliers: Choice[]; branches: Choice[]; accounts: Choice[]; currencies: string[] }> {
  requirePaymentAccess(ctx);
  return withTenant(ctx.userId, ctx.tenantId, async (tx) => {
    const [suppliers, branches, accounts, currencies] = await Promise.all([
      tx.execute<{ id: string; name: string; code: string | null }>(sql`select id, name, code from suppliers where tenant_id = ${ctx.tenantId}::uuid and archived_at is null order by lower(name) limit 1000`),
      tx.execute<{ id: string; name: string }>(sql`select id, name from branches where tenant_id = ${ctx.tenantId}::uuid order by created_at`),
      tx.execute<{ id: string; code: string; name: string }>(sql`
        select id, code, name from accounts
        where tenant_id = ${ctx.tenantId}::uuid and control_type in ('cash', 'bank') and not is_group and archived_at is null order by code`),
      tx.execute<{ code: string }>(sql`select code from currencies where tenant_id = ${ctx.tenantId}::uuid and not is_base order by code`),
    ]);
    return {
      suppliers: suppliers.map((row) => ({ id: row.id, label: row.code ? `${row.name} (${row.code})` : row.name })),
      branches: branches.map((row) => ({ id: row.id, label: row.name })),
      accounts: accounts.map((row) => ({ id: row.id, label: `${row.code} ${row.name}` })),
      currencies: currencies.map((row) => row.code),
    };
  });
}

/** What can be paid of one supplier's bills in one branch: for the page that writes a payment. */
export async function listBillsOwed(ctx: TenantContext, supplierId: string, branchId: string): Promise<BillOwed[]> {
  requirePaymentAccess(ctx);
  return withTenant(ctx.userId, ctx.tenantId, (tx) => selectBillsOwed(tx, ctx.tenantId, supplierId, branchId));
}

// ── Tax withheld, and the challans it was paid under ────────────────────────────────────────────

export type WithheldUnpaid = { entryId: string; kind: WithholdingKind; date: string; supplierName: string; billNumber: string; label: string; amount: Decimal };
export type Challan = { id: string; number: string; kind: WithholdingKind; challanNo: string; paidOn: string; accountName: string; amount: Decimal; entries: number; journalId: string };

/** Tax withheld that no challan has paid yet, oldest first; and the challans recorded, newest first. */
export async function getWithholdingPosition(ctx: TenantContext): Promise<{ unpaid: WithheldUnpaid[]; challans: Challan[] }> {
  requirePaymentAccess(ctx);
  return withTenant(ctx.userId, ctx.tenantId, async (tx) => {
    const [unpaid, challans] = await Promise.all([
      tx.execute<{ entry_id: string; kind: WithholdingKind; entry_date: string; supplier_name: string; bill_number: string; label: string; amount: string }>(sql`
        select e.id as entry_id, e.kind, e.entry_date::text, s.name as supplier_name, b.number as bill_number, w.label, e.amount::text
        from withholding_entries e
        join supplier_bills b on b.tenant_id = e.tenant_id and b.id = e.bill_id
        join suppliers s on s.tenant_id = e.tenant_id and s.id = e.supplier_id
        join withholding_rules w on w.tenant_id = e.tenant_id and w.id = e.rule_id
        where e.tenant_id = ${ctx.tenantId}::uuid
          and not exists (select 1 from withholding_challan_entries c where c.tenant_id = e.tenant_id and c.entry_id = e.id)
        order by e.entry_date, b.number, e.kind
        limit 1000`),
      tx.execute<{ id: string; number: string; kind: WithholdingKind; challan_no: string; paid_on: string; account_name: string; amount: string; entries: number; journal_id: string }>(sql`
        select c.id, c.number, c.kind, c.challan_no, c.paid_on::text, a.name as account_name, c.amount::text, c.journal_id,
               (select count(*)::int from withholding_challan_entries x where x.tenant_id = c.tenant_id and x.challan_id = c.id) as entries
        from withholding_challans c join accounts a on a.tenant_id = c.tenant_id and a.id = c.account_id
        where c.tenant_id = ${ctx.tenantId}::uuid
        order by c.paid_on desc, c.number desc
        limit 200`),
    ]);
    return {
      unpaid: unpaid.map((row) => ({ entryId: row.entry_id, kind: row.kind, date: row.entry_date, supplierName: row.supplier_name, billNumber: row.bill_number, label: row.label, amount: d(row.amount) })),
      challans: challans.map((row) => ({ id: row.id, number: row.number, kind: row.kind, challanNo: row.challan_no, paidOn: row.paid_on, accountName: row.account_name, amount: d(row.amount), entries: row.entries, journalId: row.journal_id })),
    };
  });
}

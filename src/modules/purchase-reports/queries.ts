import "server-only";
import Decimal from "decimal.js";
import { sql } from "drizzle-orm";
import { withTenant, type Tx } from "@/db";
import { UserError } from "@/lib/errors";
import { SUPPLIER_TYPE_LABELS } from "@/modules/parties/rules";
import { getGrni } from "@/modules/purchasing/queries";
import type { ReportTable } from "@/modules/reports/rules";
import type { WithholdingKind } from "@/modules/tax/rules";
import { can, type TenantContext } from "@/modules/tenant/rules";
import {
  PURCHASE_REPORTS,
  agedPayablesTable,
  grniTable,
  section165Table,
  supplierStatementTable,
  withholdingRegisterTable,
  type PurchaseFilter,
  type PurchaseReportKey,
  type WithheldEntry,
  type WithheldPosition,
} from "./rules";

// The buying reports, read from posted bills, payments, returns, the journal lines kept against
// suppliers, and the tax withheld. Row-level security decides what the reader sees: the owner
// and whoever keeps or checks the books, in the branches they work in.

const d = (value: string | null | undefined) => new Decimal(value ?? "0");

/** Refuses a member who may not read this report. */
export function requirePurchaseReport(ctx: TenantContext, report: PurchaseReportKey): void {
  if (!can(ctx.role, PURCHASE_REPORTS[report].permission)) throw new UserError("Only an owner, an accountant or an auditor can see what is owed to suppliers.");
}

async function agedPayables(tx: Tx, ctx: TenantContext, filter: PurchaseFilter): Promise<ReportTable> {
  const on = filter.to;
  // A payment that was cancelled later still counted on the day of the report.
  const counted = sql`(p.status = 'posted' or (p.status = 'cancelled' and p.cancelled_on > ${on}::date))`;
  const [bills, opening, held, [books]] = await Promise.all([
    tx.execute<{ supplier_id: string; supplier_name: string; document: string; reference: string | null; date: string; due: string; owed: string }>(sql`
      select s.id as supplier_id, s.name as supplier_name, b.number as document, b.supplier_invoice_no as reference, b.bill_date::text as date,
             coalesce(b.due_date, b.bill_date)::text as due, (b.payable - paid.amount - back.amount)::text as owed
      from public.supplier_bills b
      join public.suppliers s on s.tenant_id = b.tenant_id and s.id = b.supplier_id
      cross join lateral (
        select coalesce(sum(a.amount), 0) as amount from public.supplier_payment_allocations a
        join public.supplier_payments p on p.tenant_id = a.tenant_id and p.id = a.payment_id
        where a.tenant_id = b.tenant_id and a.bill_id = b.id and ${counted} and coalesce(a.applied_on, p.payment_date) <= ${on}::date) paid
      cross join lateral (
        select coalesce(sum(r.amount), 0) as amount from public.supplier_return_allocations r
        where r.tenant_id = b.tenant_id and r.bill_id = b.id and r.applied_on <= ${on}::date) back
      where b.tenant_id = ${ctx.tenantId} and b.status = 'posted' and b.bill_date <= ${on}::date
        and (${filter.branchId}::uuid is null or b.branch_id = ${filter.branchId}::uuid)
        and (${filter.supplierId}::uuid is null or b.supplier_id = ${filter.supplierId}::uuid)
        and b.payable <> paid.amount + back.amount
      order by b.bill_date, b.number`),
    // Bills that were unpaid when the books were opened. They belong to no branch.
    filter.branchId !== null
      ? Promise.resolve([])
      : tx.execute<{ supplier_id: string; supplier_name: string; document: string; date: string; due: string; owed: string }>(sql`
          select s.id as supplier_id, s.name as supplier_name, 'Opening: ' || o.document_number as document, o.document_date::text as date,
                 coalesce(o.due_date, o.document_date)::text as due, o.credit::text as owed
          from public.opening_balances o
          join public.opening_entries e on e.tenant_id = o.tenant_id and e.id = o.opening_entry_id
          join public.suppliers s on s.tenant_id = o.tenant_id and s.id = o.supplier_id
          where o.tenant_id = ${ctx.tenantId} and o.kind = 'payable' and e.status = 'posted' and e.opening_date <= ${on}::date
            and (${filter.supplierId}::uuid is null or o.supplier_id = ${filter.supplierId}::uuid)
          order by o.document_date, o.document_number`),
    tx.execute<{ supplier_id: string; supplier_name: string; advances: string; credits: string }>(sql`
      select s.id as supplier_id, s.name as supplier_name,
        coalesce((
          select sum(p.amount - coalesce((
            select sum(a.amount) from public.supplier_payment_allocations a
            where a.tenant_id = p.tenant_id and a.payment_id = p.id and coalesce(a.applied_on, p.payment_date) <= ${on}::date), 0))
          from public.supplier_payments p
          where p.tenant_id = s.tenant_id and p.supplier_id = s.id and ${counted} and p.payment_date <= ${on}::date
            and (${filter.branchId}::uuid is null or p.branch_id = ${filter.branchId}::uuid)), 0)::text as advances,
        coalesce((
          select sum(r.credit - coalesce((
            select sum(a.amount) from public.supplier_return_allocations a
            where a.tenant_id = r.tenant_id and a.return_id = r.id and a.applied_on <= ${on}::date), 0))
          from public.supplier_returns r
          where r.tenant_id = s.tenant_id and r.supplier_id = s.id and r.status = 'posted' and r.return_date <= ${on}::date
            and (${filter.branchId}::uuid is null or r.branch_id = ${filter.branchId}::uuid)), 0)::text as credits
      from public.suppliers s
      where s.tenant_id = ${ctx.tenantId} and (${filter.supplierId}::uuid is null or s.id = ${filter.supplierId}::uuid)`),
    tx.execute<{ net: string }>(sql`
      select coalesce(sum(jl.credit - jl.debit), 0)::text as net
      from public.journal_lines jl
      join public.journals j on j.tenant_id = jl.tenant_id and j.id = jl.journal_id
      join public.accounts a on a.tenant_id = jl.tenant_id and a.id = jl.account_id
      where jl.tenant_id = ${ctx.tenantId} and a.is_control and a.control_type in ('ap', 'supplier_advances') and j.journal_date <= ${on}::date
        and (${filter.branchId}::uuid is null or j.branch_id = ${filter.branchId}::uuid)
        and (${filter.supplierId}::uuid is null or jl.supplier_id = ${filter.supplierId}::uuid)`),
  ]);
  const items = [...opening.map((row) => ({ ...row, reference: null })), ...bills].map((row) => ({ supplierId: row.supplier_id, supplierName: row.supplier_name, document: row.document, reference: row.reference, date: row.date, due: row.due, owed: d(row.owed) }));
  const credits = held.map((row) => ({ supplierId: row.supplier_id, supplierName: row.supplier_name, advances: d(row.advances), credits: d(row.credits) }));
  const notes = filter.branchId !== null ? ["Shown for one branch: bills that were unpaid when the books were opened belong to no branch and are left out."] : [];
  return agedPayablesTable(items, credits, d(books?.net), filter, filter.supplierId !== null, notes);
}

const DOCUMENT_WORDS: Record<string, string> = {
  supplier_bill: "Bill",
  supplier_payment: "Payment",
  supplier_return: "Goods sent back",
  opening_balance: "Opening balance",
  reversal: "Cancelled",
  manual: "Journal",
};

async function supplierStatement(tx: Tx, ctx: TenantContext, filter: PurchaseFilter): Promise<ReportTable> {
  if (filter.supplierId === null) return supplierStatementTable(null, new Decimal(0), [], filter);
  const [supplier] = await tx.execute<{ name: string }>(sql`select name from public.suppliers where tenant_id = ${ctx.tenantId} and id = ${filter.supplierId}::uuid`);
  if (!supplier) return supplierStatementTable(null, new Decimal(0), [], filter);
  // What the books hold against the supplier, in Trade payables and in Advances to suppliers, journal by journal.
  const entries = sql`
    from public.journal_lines jl
    join public.journals j on j.tenant_id = jl.tenant_id and j.id = jl.journal_id
    join public.accounts a on a.tenant_id = jl.tenant_id and a.id = jl.account_id
    where jl.tenant_id = ${ctx.tenantId} and jl.supplier_id = ${filter.supplierId}::uuid and a.is_control and a.control_type in ('ap', 'supplier_advances')
      and (${filter.branchId}::uuid is null or j.branch_id = ${filter.branchId}::uuid)`;
  const [[opening], lines] = await Promise.all([
    tx.execute<{ amount: string }>(sql`select coalesce(sum(jl.credit - jl.debit), 0)::text as amount ${entries} and j.journal_date < ${filter.from}::date`),
    tx.execute<{ journal_date: string; source_type: string; document_number: string | null; memo: string | null; amount: string }>(sql`
      select j.journal_date::text, j.source_type, j.document_number, j.memo, sum(jl.credit - jl.debit)::text as amount
      ${entries} and j.journal_date between ${filter.from}::date and ${filter.to}::date
      group by j.id, j.journal_date, j.created_at, j.source_type, j.document_number, j.memo
      -- An advance set against a bill moves an amount between the two accounts and changes nothing owed.
      having sum(jl.credit - jl.debit) <> 0
      order by j.journal_date, j.created_at, j.id`),
  ]);
  return supplierStatementTable(
    supplier.name,
    d(opening?.amount),
    lines.map((line) => ({ date: line.journal_date, document: [DOCUMENT_WORDS[line.source_type] ?? "Entry", line.document_number].filter(Boolean).join(" "), details: line.memo ?? "", amount: d(line.amount) })),
    filter,
  );
}

async function selectWithheld(tx: Tx, ctx: TenantContext, filter: PurchaseFilter): Promise<WithheldEntry[]> {
  const rows = await tx.execute<{
    entry_date: string; kind: WithholdingKind; supplier_name: string; supplier_type: string; ntn: string | null; cnic: string | null; bill_number: string; supplier_invoice_no: string;
    label: string; legal_reference: string; on_active_list: boolean; base_amount: string; rate: string; amount: string; challan_no: string | null; paid_on: string | null;
  }>(sql`
    select e.entry_date::text, e.kind, s.name as supplier_name, s.supplier_type, s.ntn, s.cnic, b.number as bill_number, b.supplier_invoice_no, w.label, e.legal_reference,
           e.on_active_list, e.base_amount::text, e.rate::text, e.amount::text, c.challan_no, c.paid_on::text
    from public.withholding_entries e
    join public.supplier_bills b on b.tenant_id = e.tenant_id and b.id = e.bill_id
    join public.suppliers s on s.tenant_id = e.tenant_id and s.id = e.supplier_id
    join public.withholding_rules w on w.tenant_id = e.tenant_id and w.id = e.rule_id
    left join public.withholding_challan_entries x on x.tenant_id = e.tenant_id and x.entry_id = e.id
    left join public.withholding_challans c on c.tenant_id = x.tenant_id and c.id = x.challan_id
    where e.tenant_id = ${ctx.tenantId} and e.entry_date between ${filter.from}::date and ${filter.to}::date
      and (${filter.branchId}::uuid is null or b.branch_id = ${filter.branchId}::uuid)
      and (${filter.supplierId}::uuid is null or e.supplier_id = ${filter.supplierId}::uuid)
    order by e.entry_date, b.number, e.kind`);
  return rows.map((row) => ({
    date: row.entry_date, kind: row.kind, supplierName: row.supplier_name, supplierType: row.supplier_type, ntn: row.ntn, cnic: row.cnic, billNumber: row.bill_number, supplierInvoiceNo: row.supplier_invoice_no,
    label: row.label, legalReference: row.legal_reference, onActiveList: row.on_active_list, base: d(row.base_amount), rate: d(row.rate), amount: d(row.amount), challanNo: row.challan_no, paidOn: row.paid_on,
  }));
}

const CONTROL_OF: Record<WithholdingKind, string> = { income_tax: "wht_income_tax", sales_tax: "wht_sales_tax", provincial_sales_tax: "wht_provincial_tax" };

/** What is still to be paid over at the end of a day, and what the withholding payable accounts hold that day: for the whole company. */
async function selectWithheldPosition(tx: Tx, ctx: TenantContext, on: string): Promise<WithheldPosition> {
  const [unpaid, books] = await Promise.all([
    tx.execute<{ kind: WithholdingKind; amount: string }>(sql`
      select e.kind, sum(e.amount)::text as amount
      from public.withholding_entries e
      where e.tenant_id = ${ctx.tenantId} and e.entry_date <= ${on}::date and not exists (
        select 1 from public.withholding_challan_entries x
        join public.withholding_challans c on c.tenant_id = x.tenant_id and c.id = x.challan_id
        where x.tenant_id = e.tenant_id and x.entry_id = e.id and c.paid_on <= ${on}::date)
      group by e.kind`),
    tx.execute<{ control_type: string; amount: string }>(sql`
      select a.control_type, sum(jl.credit - jl.debit)::text as amount
      from public.journal_lines jl
      join public.journals j on j.tenant_id = jl.tenant_id and j.id = jl.journal_id
      join public.accounts a on a.tenant_id = jl.tenant_id and a.id = jl.account_id
      where jl.tenant_id = ${ctx.tenantId} and a.is_control and a.control_type in ('wht_income_tax', 'wht_sales_tax', 'wht_provincial_tax') and j.journal_date <= ${on}::date
      group by a.control_type`),
  ]);
  const zero = () => ({ income_tax: new Decimal(0), sales_tax: new Decimal(0), provincial_sales_tax: new Decimal(0) });
  const position: WithheldPosition = { unpaid: zero(), books: zero() };
  for (const row of unpaid) position.unpaid[row.kind] = d(row.amount);
  for (const kind of Object.keys(CONTROL_OF) as WithholdingKind[]) position.books[kind] = d(books.find((row) => row.control_type === CONTROL_OF[kind])?.amount);
  return position;
}

async function withholdingRegister(tx: Tx, ctx: TenantContext, filter: PurchaseFilter): Promise<ReportTable> {
  const whole = filter.branchId === null && filter.supplierId === null && ctx.branchIds === null;
  const [entries, position] = await Promise.all([selectWithheld(tx, ctx, filter), whole ? selectWithheldPosition(tx, ctx, filter.to) : Promise.resolve(null)]);
  return withholdingRegisterTable(entries, position, filter);
}

/** One buying report, as a table. */
export async function getPurchaseReport(ctx: TenantContext, report: PurchaseReportKey, filter: PurchaseFilter): Promise<ReportTable> {
  requirePurchaseReport(ctx, report);
  if (report === "grni") {
    const { rows, total, ledger } = await getGrni(ctx);
    return grniTable(rows, total, ledger);
  }
  return withTenant(ctx.userId, ctx.tenantId, async (tx) => {
    switch (report) {
      case "aged-payables":
        return agedPayables(tx, ctx, filter);
      case "supplier-statement":
        return supplierStatement(tx, ctx, filter);
      case "withholding-register":
        return withholdingRegister(tx, ctx, filter);
      case "section-165":
        return section165Table(await selectWithheld(tx, ctx, { ...filter, supplierId: null }), filter, SUPPLIER_TYPE_LABELS);
    }
  });
}

/** The suppliers a report can be narrowed to. */
export async function listPurchaseReportChoices(ctx: TenantContext): Promise<{ suppliers: { id: string; label: string }[] }> {
  if (!can(ctx.role, "supplier_bill.read")) return { suppliers: [] };
  return withTenant(ctx.userId, ctx.tenantId, async (tx) => {
    const suppliers = await tx.execute<{ id: string; name: string; code: string | null }>(sql`select id, name, code from public.suppliers where tenant_id = ${ctx.tenantId} order by lower(name) limit 2000`);
    return { suppliers: suppliers.map((row) => ({ id: row.id, label: row.code ? `${row.name} (${row.code})` : row.name })) };
  });
}

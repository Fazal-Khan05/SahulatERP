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
  purchaseRegisterTable,
  purchasesTable,
  section165Table,
  supplierStatementTable,
  withholdingRegisterTable,
  type PurchaseFilter,
  type PurchaseRegisterRow,
  type PurchaseReportKey,
  type SalaryTaxLine,
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
    select e.entry_date::text, e.kind::text as kind, s.name as supplier_name, s.supplier_type, s.ntn, s.cnic, b.number as bill_number, b.supplier_invoice_no, w.label, e.legal_reference,
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
    union all
    -- Tax withheld from a supplier on an expense paid out of cash or the bank (Step 34): the
    -- expense's own rows. An expense cancelled by the end of the period has given its tax back.
    select x.entry_date::text, x.kind, s.name, s.supplier_type, s.ntn, s.cnic, e.number, coalesce(e.reference, ''), w.label, x.legal_reference,
           x.on_active_list, x.base_amount::text, x.rate::text, x.amount::text, xc.challan_no, xc.paid_on::text
    from public.expense_withholdings x
    join public.expenses e on e.tenant_id = x.tenant_id and e.id = x.expense_id
    join public.suppliers s on s.tenant_id = x.tenant_id and s.id = x.supplier_id
    join public.withholding_rules w on w.tenant_id = x.tenant_id and w.id = x.rule_id
    left join public.challan_expense_entries xe on xe.tenant_id = x.tenant_id and xe.entry_id = x.id
    left join public.withholding_challans xc on xc.tenant_id = xe.tenant_id and xc.id = xe.challan_id
    left join public.journals r on r.tenant_id = e.tenant_id and r.id = e.reversal_journal_id
    where x.tenant_id = ${ctx.tenantId} and x.entry_date between ${filter.from}::date and ${filter.to}::date
      and (r.id is null or r.journal_date > ${filter.to}::date)
      and (${filter.branchId}::uuid is null or e.branch_id = ${filter.branchId}::uuid)
      and (${filter.supplierId}::uuid is null or x.supplier_id = ${filter.supplierId}::uuid)
    order by 1, 7, 2`);
  return rows.map((row) => ({
    date: row.entry_date, kind: row.kind, supplierName: row.supplier_name, supplierType: row.supplier_type, ntn: row.ntn, cnic: row.cnic, billNumber: row.bill_number, supplierInvoiceNo: row.supplier_invoice_no,
    label: row.label, legalReference: row.legal_reference, onActiveList: row.on_active_list, base: d(row.base_amount), rate: d(row.rate), amount: d(row.amount), challanNo: row.challan_no, paidOn: row.paid_on,
  }));
}

const CONTROL_OF: Record<WithholdingKind, string> = { income_tax: "wht_income_tax", sales_tax: "wht_sales_tax", provincial_sales_tax: "wht_provincial_tax" };

/** The income tax the payroll runs approved in the period deducted from pay, run by run: the runs' own figures. */
async function selectSalaryTax(tx: Tx, ctx: TenantContext, filter: PurchaseFilter): Promise<SalaryTaxLine[]> {
  const rows = await tx.execute<{ journal_date: string; month: string; number: string; people: number; taxable: string; tax: string; challan_no: string | null; paid_on: string | null }>(sql`
    select r.journal_date::text, r.month::text, r.number, r.tax::text, c.challan_no, c.paid_on::text,
      (select count(*)::int from public.payslips p where p.tenant_id = r.tenant_id and p.run_id = r.id and p.tax > 0) as people,
      (select coalesce(sum(p.taxable), 0)::text from public.payslips p where p.tenant_id = r.tenant_id and p.run_id = r.id and p.tax > 0) as taxable
    from public.payroll_runs r
    left join public.challan_payroll_runs cr on cr.tenant_id = r.tenant_id and cr.run_id = r.id
    left join public.withholding_challans c on c.tenant_id = cr.tenant_id and c.id = cr.challan_id
    where r.tenant_id = ${ctx.tenantId} and r.status in ('approved', 'paid') and r.tax > 0 and r.journal_date between ${filter.from}::date and ${filter.to}::date
    order by r.journal_date, r.number`);
  return rows.map((row) => ({ date: row.journal_date, month: row.month, runNumber: row.number, people: row.people, taxable: d(row.taxable), amount: d(row.tax), challanNo: row.challan_no, paidOn: row.paid_on }));
}

/** What is still to be paid over at the end of a day, and what the withholding payable accounts hold that day: for the whole company. */
async function selectWithheldPosition(tx: Tx, ctx: TenantContext, on: string): Promise<WithheldPosition> {
  const [unpaid, books, onExpenses, [salaries]] = await Promise.all([
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
    // Withheld on expenses that stood that day, and that no challan had paid by then.
    tx.execute<{ kind: WithholdingKind; amount: string }>(sql`
      select x.kind, sum(x.amount)::text as amount
      from public.expense_withholdings x
      join public.expenses e on e.tenant_id = x.tenant_id and e.id = x.expense_id
      left join public.journals r on r.tenant_id = e.tenant_id and r.id = e.reversal_journal_id
      where x.tenant_id = ${ctx.tenantId} and x.entry_date <= ${on}::date and (r.id is null or r.journal_date > ${on}::date)
        and not exists (
          select 1 from public.challan_expense_entries xe
          join public.withholding_challans c on c.tenant_id = xe.tenant_id and c.id = xe.challan_id
          where xe.tenant_id = x.tenant_id and xe.entry_id = x.id and c.paid_on <= ${on}::date)
      group by x.kind`),
    // Deducted from pay by the payroll runs approved by that day (section 149), credited to the
    // income tax account, and not paid over by then.
    tx.execute<{ amount: string }>(sql`
      select coalesce(sum(r.tax), 0)::text as amount from public.payroll_runs r
      where r.tenant_id = ${ctx.tenantId} and r.status in ('approved', 'paid') and r.journal_date <= ${on}::date
        and not exists (
          select 1 from public.challan_payroll_runs cr
          join public.withholding_challans c on c.tenant_id = cr.tenant_id and c.id = cr.challan_id
          where cr.tenant_id = r.tenant_id and cr.run_id = r.id and c.paid_on <= ${on}::date)`),
  ]);
  const zero = () => ({ income_tax: new Decimal(0), sales_tax: new Decimal(0), provincial_sales_tax: new Decimal(0) });
  const position: WithheldPosition = { unpaid: zero(), books: zero(), salaries: d(salaries?.amount) };
  for (const row of unpaid) position.unpaid[row.kind] = d(row.amount);
  for (const row of onExpenses) position.unpaid[row.kind] = position.unpaid[row.kind].plus(d(row.amount));
  for (const kind of Object.keys(CONTROL_OF) as WithholdingKind[]) position.books[kind] = d(books.find((row) => row.control_type === CONTROL_OF[kind])?.amount);
  return position;
}

async function withholdingRegister(tx: Tx, ctx: TenantContext, filter: PurchaseFilter): Promise<ReportTable> {
  const whole = filter.branchId === null && filter.supplierId === null && ctx.branchIds === null;
  // Payroll belongs to the whole company: salary tax is shown, and set beside the books, only when nothing narrows the report.
  const [entries, position, salaries] = await Promise.all([
    selectWithheld(tx, ctx, filter),
    whole ? selectWithheldPosition(tx, ctx, filter.to) : Promise.resolve(null),
    whole ? selectSalaryTax(tx, ctx, filter) : Promise.resolve([]),
  ]);
  return withholdingRegisterTable(entries, position, filter, salaries);
}

/** Purchases by supplier: posted bills in the period less goods sent back that a bill had taken, before tax. */
async function purchasesBySupplier(tx: Tx, ctx: TenantContext, filter: PurchaseFilter): Promise<ReportTable> {
  const rows = await tx.execute<{ label: string; billed: string; returned: string }>(sql`
    with moved as (
      select b.supplier_id, b.amount as billed, 0::numeric as returned
      from public.supplier_bills b
      where b.tenant_id = ${ctx.tenantId} and b.status = 'posted' and b.bill_date between ${filter.from}::date and ${filter.to}::date
        and (${filter.branchId}::uuid is null or b.branch_id = ${filter.branchId}::uuid)
      union all
      select r.supplier_id, 0, r.billed_amount
      from public.supplier_returns r
      where r.tenant_id = ${ctx.tenantId} and r.status = 'posted' and r.return_date between ${filter.from}::date and ${filter.to}::date
        and (${filter.branchId}::uuid is null or r.branch_id = ${filter.branchId}::uuid)
    )
    select max(s.name) || coalesce(' (' || max(s.code) || ')', '') as label, sum(m.billed)::text as billed, sum(m.returned)::text as returned
    from moved m join public.suppliers s on s.tenant_id = ${ctx.tenantId} and s.id = m.supplier_id
    where (${filter.supplierId}::uuid is null or m.supplier_id = ${filter.supplierId}::uuid)
    group by m.supplier_id`);
  return purchasesTable("purchases-by-supplier", rows.map((row) => ({ label: row.label, detail: null, unit: null, quantity: null, billed: d(row.billed), returned: d(row.returned) })), filter);
}

/** Purchases by item: the goods lines of posted bills (quantity in the item's base unit), less the lines of goods sent back that a bill had taken; charges that are not for an item on a line of their own. */
async function purchasesByItem(tx: Tx, ctx: TenantContext, filter: PurchaseFilter): Promise<ReportTable> {
  const rows = await tx.execute<{ label: string; detail: string | null; unit: string | null; quantity: string | null; billed: string; returned: string; other: boolean }>(sql`
    with moved as (
      select l.item_id, l.quantity * g.unit_factor as quantity, l.amount as billed, 0::numeric as returned
      from public.supplier_bill_lines l
      join public.supplier_bills b on b.tenant_id = l.tenant_id and b.id = l.bill_id
      left join public.goods_receipt_lines g on g.tenant_id = l.tenant_id and g.id = l.receipt_line_id
      where l.tenant_id = ${ctx.tenantId} and b.status = 'posted' and b.bill_date between ${filter.from}::date and ${filter.to}::date
        and (${filter.branchId}::uuid is null or b.branch_id = ${filter.branchId}::uuid)
        and (${filter.supplierId}::uuid is null or b.supplier_id = ${filter.supplierId}::uuid)
      union all
      select l.item_id, -l.base_quantity, 0, l.amount
      from public.supplier_return_lines l
      join public.supplier_returns r on r.tenant_id = l.tenant_id and r.id = l.return_id
      where l.tenant_id = ${ctx.tenantId} and r.status = 'posted' and l.bill_line_id is not null and r.return_date between ${filter.from}::date and ${filter.to}::date
        and (${filter.branchId}::uuid is null or r.branch_id = ${filter.branchId}::uuid)
        and (${filter.supplierId}::uuid is null or r.supplier_id = ${filter.supplierId}::uuid)
    )
    select coalesce(max(i.code), 'Other') as label, coalesce(max(i.name), 'Charges on bills that are not for an item') as detail, max(u.code) as unit,
           sum(m.quantity)::text as quantity, sum(m.billed)::text as billed, sum(m.returned)::text as returned, m.item_id is null as other
    from moved m
    left join public.items i on i.tenant_id = ${ctx.tenantId} and i.id = m.item_id
    left join public.units u on u.tenant_id = i.tenant_id and u.id = i.base_unit_id
    group by m.item_id`);
  return purchasesTable("purchases-by-item", rows.map((row) => ({ label: row.label, detail: row.detail, unit: row.unit, quantity: row.other || row.quantity === null ? null : d(row.quantity), billed: d(row.billed), returned: d(row.returned) })), filter);
}

async function purchaseRegister(tx: Tx, ctx: TenantContext, filter: PurchaseFilter): Promise<ReportTable> {
  const rows = await tx.execute<{ date: string; kind: "bill" | "return"; number: string; supplier: string; reference: string | null; amount: string; tax: string; total: string }>(sql`
    select b.bill_date::text as date, 'bill' as kind, b.number, s.name as supplier, b.supplier_invoice_no as reference,
           b.amount::text, (b.total - b.amount)::text as tax, b.total::text as total
    from public.supplier_bills b join public.suppliers s on s.tenant_id = b.tenant_id and s.id = b.supplier_id
    where b.tenant_id = ${ctx.tenantId} and b.status = 'posted' and b.bill_date between ${filter.from}::date and ${filter.to}::date
      and (${filter.branchId}::uuid is null or b.branch_id = ${filter.branchId}::uuid)
      and (${filter.supplierId}::uuid is null or b.supplier_id = ${filter.supplierId}::uuid)
    union all
    select r.return_date::text, 'return', r.number, s.name, r.supplier_reference, (-r.billed_amount)::text, (-r.sales_tax)::text, (-r.credit)::text
    from public.supplier_returns r join public.suppliers s on s.tenant_id = r.tenant_id and s.id = r.supplier_id
    where r.tenant_id = ${ctx.tenantId} and r.status = 'posted' and r.return_date between ${filter.from}::date and ${filter.to}::date
      and (${filter.branchId}::uuid is null or r.branch_id = ${filter.branchId}::uuid)
      and (${filter.supplierId}::uuid is null or r.supplier_id = ${filter.supplierId}::uuid)
    order by 1, 3`);
  return purchaseRegisterTable(rows.map((row): PurchaseRegisterRow => ({ date: row.date, kind: row.kind, number: row.number, supplier: row.supplier, reference: row.reference ?? "", amount: d(row.amount), tax: d(row.tax), total: d(row.total) })), filter);
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
      case "purchases-by-supplier":
        return purchasesBySupplier(tx, ctx, filter);
      case "purchases-by-item":
        return purchasesByItem(tx, ctx, filter);
      case "purchase-register":
        return purchaseRegister(tx, ctx, filter);
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

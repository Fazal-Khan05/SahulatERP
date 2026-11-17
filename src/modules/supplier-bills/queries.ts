import "server-only";
import Decimal from "decimal.js";
import { sql } from "drizzle-orm";
import { isUuid, withTenant, type Tx } from "@/db";
import { UserError } from "@/lib/errors";
import type { TaxCategoryKind, WithholdingBase, WithholdingKind } from "@/modules/tax/rules";
import { can, type TenantContext } from "@/modules/tenant/rules";
import { figureBill, type BillFigures, type BillStatus, type BillTaxTables, type ReceiptLineToBill, type WithholdingRule } from "./rules";

// Reading supplier bills. They carry what goods and services cost and what was withheld: read
// by the owner and whoever keeps or checks the books, in the branches they work in.

export function requireBillAccess(ctx: TenantContext): void {
  if (!can(ctx.role, "supplier_bill.read")) throw new UserError("Your role does not include supplier bills.");
}

const d = (value: string | null) => new Decimal(value ?? "0");

// ── What a bill is worked out from ──────────────────────────────────────────────────────────────

export type BillSupplier = { id: string; name: string; type: "company" | "individual" | "aop"; registered: boolean; onActiveList: boolean; creditDays: number | null };

/** Whether the company withholds tax from its suppliers. Off until an owner or an accountant switches it on. */
export async function selectWithholdingOn(tx: Tx, tenantId: string): Promise<boolean> {
  const [row] = await tx.execute<{ withholding_on: boolean }>(sql`select withholding_on from purchase_settings where tenant_id = ${tenantId}::uuid`);
  return row?.withholding_on ?? false;
}

export async function getPurchaseSettings(ctx: TenantContext): Promise<{ withholdingOn: boolean }> {
  requireBillAccess(ctx);
  return withTenant(ctx.userId, ctx.tenantId, async (tx) => ({ withholdingOn: await selectWithholdingOn(tx, ctx.tenantId) }));
}

/** The supplier as a bill needs it, or null when it is not one of the company's. */
export async function selectBillSupplier(tx: Tx, tenantId: string, supplierId: string): Promise<BillSupplier | null> {
  if (!isUuid(supplierId)) return null;
  const [row] = await tx.execute<{ id: string; name: string; supplier_type: BillSupplier["type"]; registered: boolean; on_list: boolean; credit_days: number | null }>(sql`
    select id, name, supplier_type, (registration_type = 'registered' and strn is not null) as registered, (atl_status = 'active') as on_list, credit_days
    from suppliers where tenant_id = ${tenantId}::uuid and id = ${supplierId}::uuid`);
  return row ? { id: row.id, name: row.name, type: row.supplier_type, registered: row.registered, onActiveList: row.on_list, creditDays: row.credit_days } : null;
}

export type TaxCategoryChoice = { id: string; name: string; kind: TaxCategoryKind };

/** The dated tax tables a bill reads: sales tax categories and their rates, and the withholding lines. */
export async function selectBillTables(tx: Tx, tenantId: string): Promise<{ salesTaxRegistered: boolean; categories: TaxCategoryChoice[]; rates: BillTaxTables["rates"]; rules: WithholdingRule[] }> {
  const [[company], categories, rates, rules] = await Promise.all([
    tx.execute<{ sales_tax_registered: boolean }>(sql`select sales_tax_registered from company_setup where tenant_id = ${tenantId}::uuid`),
    tx.execute<{ id: string; name: string; kind: TaxCategoryKind }>(sql`select id, name, kind::text as kind from tax_categories where tenant_id = ${tenantId}::uuid order by created_at, name`),
    tx.execute<{ category_id: string; effective_from: string; rate: string }>(sql`select category_id, effective_from::text, rate::text from tax_rates where tenant_id = ${tenantId}::uuid`),
    tx.execute<{ id: string; kind: WithholdingKind; code: string; label: string; effective_from: string; base: WithholdingBase; rate: string; rate_non_atl: string | null; legal_reference: string }>(sql`
      select id, kind::text as kind, code, label, effective_from::text, base::text as base, rate::text, rate_non_atl::text, legal_reference
      from withholding_rules where tenant_id = ${tenantId}::uuid order by kind, label, effective_from`),
  ]);
  return {
    salesTaxRegistered: company?.sales_tax_registered ?? false,
    categories: categories.map((row) => ({ id: row.id, name: row.name, kind: row.kind })),
    rates: rates.map((row) => ({ categoryId: row.category_id, effectiveFrom: row.effective_from, rate: d(row.rate) })),
    rules: rules.map((row) => ({ id: row.id, kind: row.kind, code: row.code, label: row.label, effectiveFrom: row.effective_from, base: row.base, rate: d(row.rate), rateNonAtl: row.rate_non_atl === null ? null : d(row.rate_non_atl), legalReference: row.legal_reference })),
  };
}

type ToBillRow = { receipt_line_id: string; receipt_number: string; receipt_date: string; order_number: string; item_id: string; item_code: string; description: string; unit_code: string; received: string; billed: string; order_cost: string; tax_category_id: string | null };

/**
 * The lines of posted goods received from a supplier into a branch, with what posted bills
 * have billed of each. With `open` only those with something left to bill.
 */
export async function selectReceiptLinesToBill(tx: Tx, tenantId: string, supplierId: string, branchId: string, open = true): Promise<ReceiptLineToBill[]> {
  if (!isUuid(supplierId) || !isUuid(branchId)) return [];
  const rows = await tx.execute<ToBillRow>(sql`
    select g.id as receipt_line_id, r.number as receipt_number, r.receipt_date::text, o.number as order_number, g.item_id, i.code as item_code,
           ol.description, u.code as unit_code, g.quantity::text as received, ol.unit_cost::text as order_cost, i.tax_category_id,
           coalesce((select sum(bl.quantity) from supplier_bill_lines bl join supplier_bills b on b.tenant_id = bl.tenant_id and b.id = bl.bill_id
                     where bl.tenant_id = g.tenant_id and bl.receipt_line_id = g.id and b.status = 'posted'), 0)::text as billed
    from goods_receipts r
    join goods_receipt_lines g on g.tenant_id = r.tenant_id and g.receipt_id = r.id
    join warehouses w on w.tenant_id = r.tenant_id and w.id = r.warehouse_id
    join purchase_orders o on o.tenant_id = r.tenant_id and o.id = r.order_id
    join purchase_order_lines ol on ol.tenant_id = g.tenant_id and ol.id = g.order_line_id
    join items i on i.tenant_id = g.tenant_id and i.id = g.item_id
    join units u on u.tenant_id = ol.tenant_id and u.id = ol.unit_id
    where r.tenant_id = ${tenantId}::uuid and r.status = 'posted' and r.supplier_id = ${supplierId}::uuid and w.branch_id = ${branchId}::uuid
    order by r.receipt_date, r.number, g.line_no`);
  const lines = rows.map((row) => ({
    receiptLineId: row.receipt_line_id,
    receiptNumber: row.receipt_number,
    receiptDate: row.receipt_date,
    orderNumber: row.order_number,
    itemId: row.item_id,
    itemCode: row.item_code,
    description: row.description,
    unitCode: row.unit_code,
    received: d(row.received),
    billed: d(row.billed),
    orderCost: d(row.order_cost),
    taxCategoryId: row.tax_category_id,
  }));
  return open ? lines.filter((line) => line.received.gt(line.billed)) : lines;
}

// ── One bill ────────────────────────────────────────────────────────────────────────────────────

export type BillLine = {
  id: string;
  lineNo: number;
  kind: "goods" | "expense";
  receiptLineId: string | null;
  receiptNumber: string | null;
  itemCode: string | null;
  unitCode: string | null;
  accountId: string | null;
  accountName: string | null;
  description: string;
  quantity: Decimal | null;
  unitPrice: Decimal | null;
  amount: Decimal;
  taxCategoryId: string | null;
  taxRate: Decimal | null;
  salesTax: Decimal;
  receivedValue: Decimal | null;
};

export type WithholdingEntry = { kind: WithholdingKind; code: string; label: string; legalReference: string; onActiveList: boolean; base: Decimal; rate: Decimal; amount: Decimal };

export type SupplierBill = {
  id: string;
  status: BillStatus;
  number: string | null;
  date: string;
  supplierId: string;
  supplierName: string;
  branchId: string;
  branchName: string;
  supplierInvoiceNo: string;
  dueDate: string | null;
  note: string | null;
  incomeTaxCode: string | null;
  salesTaxCode: string | null;
  provincialTaxCode: string | null;
  amount: Decimal;
  salesTax: Decimal;
  provincialTax: Decimal;
  total: Decimal;
  withheld: Decimal;
  payable: Decimal;
  journalId: string | null;
  updatedAt: Date;
  lines: BillLine[];
};

type BillRow = {
  id: string; status: BillStatus; number: string | null; bill_date: string; supplier_id: string; supplier_name: string; branch_id: string; branch_name: string;
  supplier_invoice_no: string; due_date: string | null; note: string | null; income_tax_code: string | null; sales_tax_code: string | null; provincial_tax_code: string | null;
  amount: string; sales_tax: string; provincial_tax: string; total: string; withheld: string; payable: string; journal_id: string | null; updated_at: Date;
};
type LineRow = {
  id: string; line_no: number; kind: "goods" | "expense"; receipt_line_id: string | null; receipt_number: string | null; item_code: string | null; unit_code: string | null;
  account_id: string | null; account_name: string | null; description: string; quantity: string | null; unit_price: string | null; amount: string;
  tax_category_id: string | null; tax_rate: string | null; sales_tax: string; received_value: string | null;
};

/** One bill with its lines, inside a transaction the caller holds. Null when it is not one this member may read. `lock` holds a draft's row. */
export async function selectBill(tx: Tx, tenantId: string, id: string, lock = false): Promise<SupplierBill | null> {
  // A row can be held only where it can be changed: a draft. Anything else is read as it is.
  if (lock) await tx.execute(sql`select 1 from supplier_bills where tenant_id = ${tenantId}::uuid and id = ${id}::uuid for update`);
  const [row] = await tx.execute<BillRow>(sql`
    select b.id, b.status, b.number, b.bill_date::text, b.supplier_id, s.name as supplier_name, b.branch_id, br.name as branch_name, b.supplier_invoice_no,
           b.due_date::text, b.note, b.income_tax_code, b.sales_tax_code, b.provincial_tax_code, b.amount::text, b.sales_tax::text, b.provincial_tax::text,
           b.total::text, b.withheld::text, b.payable::text, b.journal_id, b.updated_at
    from supplier_bills b
    join suppliers s on s.tenant_id = b.tenant_id and s.id = b.supplier_id
    join branches br on br.tenant_id = b.tenant_id and br.id = b.branch_id
    where b.tenant_id = ${tenantId}::uuid and b.id = ${id}::uuid`);
  if (!row) return null;
  const lines = await tx.execute<LineRow>(sql`
    select l.id, l.line_no, l.kind, l.receipt_line_id, r.number as receipt_number, i.code as item_code, u.code as unit_code, l.account_id,
           case when a.id is null then null else a.code || ' ' || a.name end as account_name, l.description, l.quantity::text, l.unit_price::text, l.amount::text,
           l.tax_category_id, l.tax_rate::text, l.sales_tax::text, l.received_value::text
    from supplier_bill_lines l
    left join goods_receipt_lines g on g.tenant_id = l.tenant_id and g.id = l.receipt_line_id
    left join goods_receipts r on r.tenant_id = g.tenant_id and r.id = g.receipt_id
    left join purchase_order_lines ol on ol.tenant_id = g.tenant_id and ol.id = g.order_line_id
    left join units u on u.tenant_id = ol.tenant_id and u.id = ol.unit_id
    left join items i on i.tenant_id = l.tenant_id and i.id = l.item_id
    left join accounts a on a.tenant_id = l.tenant_id and a.id = l.account_id
    where l.tenant_id = ${tenantId}::uuid and l.bill_id = ${id}::uuid
    order by l.line_no`);
  return {
    id: row.id,
    status: row.status,
    number: row.number,
    date: row.bill_date,
    supplierId: row.supplier_id,
    supplierName: row.supplier_name,
    branchId: row.branch_id,
    branchName: row.branch_name,
    supplierInvoiceNo: row.supplier_invoice_no,
    dueDate: row.due_date,
    note: row.note,
    incomeTaxCode: row.income_tax_code,
    salesTaxCode: row.sales_tax_code,
    provincialTaxCode: row.provincial_tax_code,
    amount: d(row.amount),
    salesTax: d(row.sales_tax),
    provincialTax: d(row.provincial_tax),
    total: d(row.total),
    withheld: d(row.withheld),
    payable: d(row.payable),
    journalId: row.journal_id,
    updatedAt: new Date(row.updated_at),
    lines: lines.map((line) => ({
      id: line.id,
      lineNo: line.line_no,
      kind: line.kind,
      receiptLineId: line.receipt_line_id,
      receiptNumber: line.receipt_number,
      itemCode: line.item_code,
      unitCode: line.unit_code,
      accountId: line.account_id,
      accountName: line.account_name,
      description: line.description,
      quantity: line.quantity === null ? null : d(line.quantity),
      unitPrice: line.unit_price === null ? null : d(line.unit_price),
      amount: d(line.amount),
      taxCategoryId: line.tax_category_id,
      taxRate: line.tax_rate === null ? null : d(line.tax_rate),
      salesTax: d(line.sales_tax),
      receivedValue: line.received_value === null ? null : d(line.received_value),
    })),
  };
}

/** What was withheld on a posted bill, as the database wrote it. */
async function selectWithheld(tx: Tx, tenantId: string, billId: string): Promise<WithholdingEntry[]> {
  const rows = await tx.execute<{ kind: WithholdingKind; code: string; label: string; legal_reference: string; on_active_list: boolean; base_amount: string; rate: string; amount: string }>(sql`
    select e.kind, e.code, w.label, e.legal_reference, e.on_active_list, e.base_amount::text, e.rate::text, e.amount::text
    from withholding_entries e join withholding_rules w on w.tenant_id = e.tenant_id and w.id = e.rule_id
    where e.tenant_id = ${tenantId}::uuid and e.bill_id = ${billId}::uuid
    order by case e.kind when 'income_tax' then 1 when 'sales_tax' then 2 else 3 end`);
  return rows.map((row) => ({ kind: row.kind, code: row.code, label: row.label, legalReference: row.legal_reference, onActiveList: row.on_active_list, base: d(row.base_amount), rate: d(row.rate), amount: d(row.amount) }));
}

export type BillPage = SupplierBill & {
  /** A posted bill: what was withheld. */
  entries: WithholdingEntry[];
  /** A draft: what posting it today would withhold and leave owed, or why it cannot be worked out. */
  preview: { ok: true; figures: BillFigures } | { ok: false; reason: string } | null;
};

/** One bill for its own page. */
export async function getBill(ctx: TenantContext, id: string): Promise<BillPage | null> {
  requireBillAccess(ctx);
  if (!isUuid(id)) return null;
  return withTenant(ctx.userId, ctx.tenantId, async (tx) => {
    const bill = await selectBill(tx, ctx.tenantId, id);
    if (!bill) return null;
    if (bill.status === "posted") return { ...bill, entries: await selectWithheld(tx, ctx.tenantId, id), preview: null };
    const [tables, supplier, withholds] = await Promise.all([selectBillTables(tx, ctx.tenantId), selectBillSupplier(tx, ctx.tenantId, bill.supplierId), selectWithholdingOn(tx, ctx.tenantId)]);
    const preview = figureBill(bill.lines, { date: bill.date, incomeTaxCode: bill.incomeTaxCode, salesTaxCode: bill.salesTaxCode, provincialTaxCode: bill.provincialTaxCode }, tables.rules, { withholds, salesTaxRegistered: tables.salesTaxRegistered }, supplier?.onActiveList ?? false);
    return { ...bill, entries: [], preview };
  });
}

export const BILL_LIST_LIMIT = 200;

export type BillRowSummary = { id: string; status: BillStatus; number: string | null; date: string; supplierName: string; supplierInvoiceNo: string; total: Decimal; withheld: Decimal; payable: Decimal };

/** The newest bills. */
export async function listBills(ctx: TenantContext): Promise<{ rows: BillRowSummary[]; more: boolean }> {
  requireBillAccess(ctx);
  const found = await withTenant(ctx.userId, ctx.tenantId, (tx) =>
    tx.execute<{ id: string; status: BillStatus; number: string | null; bill_date: string; supplier_name: string; supplier_invoice_no: string; total: string; withheld: string; payable: string }>(sql`
      select b.id, b.status, b.number, b.bill_date::text, s.name as supplier_name, b.supplier_invoice_no, b.total::text, b.withheld::text, b.payable::text
      from supplier_bills b join suppliers s on s.tenant_id = b.tenant_id and s.id = b.supplier_id
      where b.tenant_id = ${ctx.tenantId}::uuid
      order by b.bill_date desc, b.created_at desc
      limit ${BILL_LIST_LIMIT + 1}`),
  );
  return {
    more: found.length > BILL_LIST_LIMIT,
    rows: found.slice(0, BILL_LIST_LIMIT).map((row) => ({ id: row.id, status: row.status, number: row.number, date: row.bill_date, supplierName: row.supplier_name, supplierInvoiceNo: row.supplier_invoice_no, total: d(row.total), withheld: d(row.withheld), payable: d(row.payable) })),
  };
}

// ── What a bill is written from ─────────────────────────────────────────────────────────────────

export type Choice = { id: string; label: string };
export type WithholdingChoice = { code: string; label: string; kind: WithholdingKind };

export type BillChoices = {
  suppliers: (Choice & { type: BillSupplier["type"]; registered: boolean })[];
  branches: Choice[];
  /** Accounts a bill can charge: expense and asset accounts that take plain entries. */
  accounts: Choice[];
  /** Tax categories a line can carry input tax under; empty when the company is not registered for sales tax. */
  taxCategories: Choice[];
  /** The withholding lines in force today, by kind; empty when the company does not withhold. */
  withholding: WithholdingChoice[];
  withholdingOn: boolean;
  salesTaxRegistered: boolean;
};

/** The suppliers, branches, accounts and tax lines a bill can name, for the day given. */
export async function getBillChoices(ctx: TenantContext, on: string): Promise<BillChoices> {
  requireBillAccess(ctx);
  return withTenant(ctx.userId, ctx.tenantId, async (tx) => {
    const [suppliers, branches, accounts, tables, withholdingOn] = await Promise.all([
      tx.execute<{ id: string; name: string; code: string | null; supplier_type: BillSupplier["type"]; registered: boolean }>(sql`
        select id, name, code, supplier_type, (registration_type = 'registered' and strn is not null) as registered
        from suppliers where tenant_id = ${ctx.tenantId}::uuid and archived_at is null order by lower(name) limit 1000`),
      tx.execute<{ id: string; name: string }>(sql`select id, name from branches where tenant_id = ${ctx.tenantId}::uuid order by created_at`),
      tx.execute<{ id: string; code: string; name: string }>(sql`
        select id, code, name from accounts
        where tenant_id = ${ctx.tenantId}::uuid and not is_group and not is_control and archived_at is null and type in ('expense', 'asset')
        order by code`),
      selectBillTables(tx, ctx.tenantId),
      selectWithholdingOn(tx, ctx.tenantId),
    ]);
    // One entry for each line, as it stands on the day: the latest dated row on or before it.
    const inForce = new Map<string, WithholdingRule>();
    for (const rule of tables.rules) {
      const held = inForce.get(rule.code);
      if (rule.effectiveFrom <= on && (!held || rule.effectiveFrom > held.effectiveFrom)) inForce.set(rule.code, rule);
    }
    return {
      suppliers: suppliers.map((row) => ({ id: row.id, label: row.code ? `${row.name} (${row.code})` : row.name, type: row.supplier_type, registered: row.registered })),
      branches: branches.map((row) => ({ id: row.id, label: row.name })),
      accounts: accounts.map((row) => ({ id: row.id, label: `${row.code} ${row.name}` })),
      taxCategories: tables.salesTaxRegistered ? tables.categories.filter((category) => category.kind !== "third_schedule").map((category) => ({ id: category.id, label: category.name })) : [],
      withholding: withholdingOn ? [...inForce.values()].map((rule) => ({ code: rule.code, label: rule.label, kind: rule.kind })) : [],
      withholdingOn,
      salesTaxRegistered: tables.salesTaxRegistered,
    };
  });
}

/** What can be billed from one supplier into one branch: for the page that writes a bill. */
export async function listReceiptLinesToBill(ctx: TenantContext, supplierId: string, branchId: string): Promise<ReceiptLineToBill[]> {
  requireBillAccess(ctx);
  return withTenant(ctx.userId, ctx.tenantId, (tx) => selectReceiptLinesToBill(tx, ctx.tenantId, supplierId, branchId));
}

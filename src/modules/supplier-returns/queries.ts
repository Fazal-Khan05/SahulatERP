import "server-only";
import Decimal from "decimal.js";
import { sql } from "drizzle-orm";
import { isUuid, withTenant, type Tx } from "@/db";
import { UserError } from "@/lib/errors";
import { selectBillsOwed } from "@/modules/supplier-payments/queries";
import type { BillOwed } from "@/modules/supplier-payments/rules";
import { can, type TenantContext } from "@/modules/tenant/rules";
import type { Returnable, ReturnStatus } from "./rules";

// Reading supplier returns: for the owner and whoever keeps or checks the books, in the
// branches they work in.

export function requireReturnAccess(ctx: TenantContext): void {
  if (!can(ctx.role, "supplier_return.read")) throw new UserError("Your role does not include supplier returns.");
}

const d = (value: string | null) => new Decimal(value ?? "0");
const orNull = (value: string | null) => (value === null ? null : new Decimal(value));

export type ReceiptToReturn = { id: string; number: string; date: string; orderNumber: string; supplierId: string; supplierName: string; warehouseId: string; warehouseName: string; branchId: string };

/** A posted goods received note as a return names it. Null when it is not one this member may read. */
export async function selectReceiptToReturn(tx: Tx, tenantId: string, receiptId: string): Promise<ReceiptToReturn | null> {
  if (!isUuid(receiptId)) return null;
  const [row] = await tx.execute<{ id: string; number: string; receipt_date: string; order_number: string; supplier_id: string; supplier_name: string; warehouse_id: string; warehouse_name: string; branch_id: string }>(sql`
    select r.id, r.number, r.receipt_date::text, o.number as order_number, r.supplier_id, s.name as supplier_name, r.warehouse_id, w.name as warehouse_name, w.branch_id
    from goods_receipts r
    join purchase_orders o on o.tenant_id = r.tenant_id and o.id = r.order_id
    join suppliers s on s.tenant_id = r.tenant_id and s.id = r.supplier_id
    join warehouses w on w.tenant_id = r.tenant_id and w.id = r.warehouse_id
    where r.tenant_id = ${tenantId}::uuid and r.id = ${receiptId}::uuid and r.status = 'posted'`);
  if (!row) return null;
  return { id: row.id, number: row.number, date: row.receipt_date, orderNumber: row.order_number, supplierId: row.supplier_id, supplierName: row.supplier_name, warehouseId: row.warehouse_id, warehouseName: row.warehouse_name, branchId: row.branch_id };
}

type ReturnableRow = {
  receipt_line_id: string; bill_line_id: string | null; line_no: number; item_id: string; item_code: string; description: string; unit_code: string; unit_factor: string;
  available: string; unit_value: string; unit_tax: string; bill_number: string | null; bill_date: string | null; in_stock: string;
};

/**
 * What can go back from one posted goods received note, counting what posted bills and posted
 * returns have already taken: for each of its lines, what no bill has billed, then what each
 * posted bill billed of it. Rows with nothing left are left out.
 */
export async function selectReturnables(tx: Tx, tenantId: string, receiptId: string): Promise<Returnable[]> {
  if (!isUuid(receiptId)) return [];
  const rows = await tx.execute<ReturnableRow>(sql`
    with lines as (
      select g.tenant_id, g.id as receipt_line_id, g.line_no, g.item_id, i.code as item_code, ol.description, u.code as unit_code, g.unit_factor, g.quantity as received,
             m.value as received_at, coalesce(sb.quantity, 0) as in_stock
      from goods_receipts r
      join goods_receipt_lines g on g.tenant_id = r.tenant_id and g.receipt_id = r.id
      join purchase_order_lines ol on ol.tenant_id = g.tenant_id and ol.id = g.order_line_id
      join items i on i.tenant_id = g.tenant_id and i.id = g.item_id
      join units u on u.tenant_id = ol.tenant_id and u.id = ol.unit_id
      join stock_moves m on m.tenant_id = g.tenant_id and m.source_type = 'goods_receipt' and m.source_id = r.id and m.source_line_id = g.id
      left join stock_balances sb on sb.tenant_id = r.tenant_id and sb.item_id = g.item_id and sb.warehouse_id = r.warehouse_id
      where r.tenant_id = ${tenantId}::uuid and r.id = ${receiptId}::uuid and r.status = 'posted'
    )
    select l.receipt_line_id, null::uuid as bill_line_id, l.line_no, l.item_id, l.item_code, l.description, l.unit_code, l.unit_factor::text,
           (l.received - billed.quantity - back.quantity)::text as available, round(l.received_at / l.received, 4)::text as unit_value, '0' as unit_tax,
           null::text as bill_number, null::text as bill_date, l.in_stock::text
    from lines l
    cross join lateral (
      select coalesce(sum(bl.quantity), 0) as quantity from supplier_bill_lines bl join supplier_bills b on b.tenant_id = bl.tenant_id and b.id = bl.bill_id
      where bl.tenant_id = l.tenant_id and bl.receipt_line_id = l.receipt_line_id and b.status = 'posted') billed
    cross join lateral (
      select coalesce(sum(x.quantity), 0) as quantity from supplier_return_lines x join supplier_returns r on r.tenant_id = x.tenant_id and r.id = x.return_id
      where x.tenant_id = l.tenant_id and x.receipt_line_id = l.receipt_line_id and x.bill_line_id is null and r.status = 'posted') back
    where l.received > billed.quantity + back.quantity
    union all
    select l.receipt_line_id, bl.id as bill_line_id, l.line_no, l.item_id, l.item_code, l.description, l.unit_code, l.unit_factor::text,
           (bl.quantity - back.quantity)::text as available, bl.unit_price::text as unit_value, round(bl.sales_tax / bl.quantity, 4)::text as unit_tax,
           b.number as bill_number, b.bill_date::text, l.in_stock::text
    from lines l
    join supplier_bill_lines bl on bl.tenant_id = l.tenant_id and bl.receipt_line_id = l.receipt_line_id and bl.kind = 'goods'
    join supplier_bills b on b.tenant_id = bl.tenant_id and b.id = bl.bill_id and b.status = 'posted'
    cross join lateral (
      select coalesce(sum(x.quantity), 0) as quantity from supplier_return_lines x join supplier_returns r on r.tenant_id = x.tenant_id and r.id = x.return_id
      where x.tenant_id = bl.tenant_id and x.bill_line_id = bl.id and r.status = 'posted') back
    where bl.quantity > back.quantity
    order by line_no, bill_date nulls first, bill_number`);
  return rows.map((row) => ({
    receiptLineId: row.receipt_line_id,
    billLineId: row.bill_line_id,
    lineNo: row.line_no,
    itemId: row.item_id,
    itemCode: row.item_code,
    description: row.description,
    unitCode: row.unit_code,
    unitFactor: d(row.unit_factor),
    available: d(row.available),
    unitValue: d(row.unit_value),
    unitTax: d(row.unit_tax),
    billNumber: row.bill_number,
    billDate: row.bill_date,
    inStock: d(row.in_stock),
  }));
}

export type ReturnLineRow = {
  id: string;
  lineNo: number;
  receiptLineId: string;
  billLineId: string | null;
  billNumber: string | null;
  itemCode: string;
  description: string;
  unitCode: string;
  quantity: Decimal;
  /** Written when the return is posted. */
  stockValue: Decimal | null;
  grniValue: Decimal | null;
  amount: Decimal | null;
  salesTax: Decimal | null;
};

export type ReturnAllocation = { id: string; billId: string; billNumber: string; supplierInvoiceNo: string; amount: Decimal; appliedOn: string };

export type SupplierReturn = {
  id: string;
  status: ReturnStatus;
  number: string | null;
  date: string;
  receipt: ReceiptToReturn;
  reason: string;
  supplierReference: string | null;
  stockValue: Decimal;
  grniValue: Decimal;
  billedAmount: Decimal;
  salesTax: Decimal;
  /** What the supplier owes back for billed goods; what bills have taken of it; and what is left. */
  credit: Decimal;
  creditUsed: Decimal;
  creditLeft: Decimal;
  journalId: string | null;
  updatedAt: Date;
  lines: ReturnLineRow[];
  allocations: ReturnAllocation[];
};

type ReturnRow = {
  id: string; status: ReturnStatus; number: string | null; return_date: string; receipt_id: string; reason: string; supplier_reference: string | null;
  stock_value: string; grni_value: string; billed_amount: string; sales_tax: string; credit: string; journal_id: string | null; updated_at: Date;
};

/** One return with its lines and what its credit was set against, inside a transaction the caller holds. Null when it is not one this member may read. `lock` holds its row. */
export async function selectReturn(tx: Tx, tenantId: string, id: string, lock = false): Promise<SupplierReturn | null> {
  if (lock) await tx.execute(sql`select 1 from supplier_returns where tenant_id = ${tenantId}::uuid and id = ${id}::uuid for update`);
  const [row] = await tx.execute<ReturnRow>(sql`
    select r.id, r.status, r.number, r.return_date::text, r.receipt_id, r.reason, r.supplier_reference, r.stock_value::text, r.grni_value::text, r.billed_amount::text,
           r.sales_tax::text, r.credit::text, r.journal_id, r.updated_at
    from supplier_returns r where r.tenant_id = ${tenantId}::uuid and r.id = ${id}::uuid`);
  if (!row) return null;
  const receipt = await selectReceiptToReturn(tx, tenantId, row.receipt_id);
  if (!receipt) return null;
  const lines = await tx.execute<{ id: string; line_no: number; receipt_line_id: string; bill_line_id: string | null; bill_number: string | null; item_code: string; description: string; unit_code: string; quantity: string; stock_value: string | null; grni_value: string | null; amount: string | null; sales_tax: string | null }>(sql`
    select l.id, l.line_no, l.receipt_line_id, l.bill_line_id, b.number as bill_number, i.code as item_code, ol.description, u.code as unit_code, l.quantity::text,
           l.stock_value::text, l.grni_value::text, l.amount::text, l.sales_tax::text
    from supplier_return_lines l
    join goods_receipt_lines g on g.tenant_id = l.tenant_id and g.id = l.receipt_line_id
    join purchase_order_lines ol on ol.tenant_id = g.tenant_id and ol.id = g.order_line_id
    join items i on i.tenant_id = l.tenant_id and i.id = l.item_id
    join units u on u.tenant_id = ol.tenant_id and u.id = ol.unit_id
    left join supplier_bill_lines bl on bl.tenant_id = l.tenant_id and bl.id = l.bill_line_id
    left join supplier_bills b on b.tenant_id = bl.tenant_id and b.id = bl.bill_id
    where l.tenant_id = ${tenantId}::uuid and l.return_id = ${id}::uuid
    order by l.line_no`);
  const allocations = await tx.execute<{ id: string; bill_id: string; bill_number: string; supplier_invoice_no: string; amount: string; applied_on: string }>(sql`
    select a.id, a.bill_id, b.number as bill_number, b.supplier_invoice_no, a.amount::text, a.applied_on::text
    from supplier_return_allocations a join supplier_bills b on b.tenant_id = a.tenant_id and b.id = a.bill_id
    where a.tenant_id = ${tenantId}::uuid and a.return_id = ${id}::uuid
    order by a.applied_on, b.bill_date, b.number`);
  const credit = d(row.credit);
  const creditUsed = allocations.reduce((sum, line) => sum.plus(d(line.amount)), new Decimal(0));
  return {
    id: row.id,
    status: row.status,
    number: row.number,
    date: row.return_date,
    receipt,
    reason: row.reason,
    supplierReference: row.supplier_reference,
    stockValue: d(row.stock_value),
    grniValue: d(row.grni_value),
    billedAmount: d(row.billed_amount),
    salesTax: d(row.sales_tax),
    credit,
    creditUsed,
    creditLeft: credit.minus(creditUsed),
    journalId: row.journal_id,
    updatedAt: new Date(row.updated_at),
    lines: lines.map((line) => ({ id: line.id, lineNo: line.line_no, receiptLineId: line.receipt_line_id, billLineId: line.bill_line_id, billNumber: line.bill_number, itemCode: line.item_code, description: line.description, unitCode: line.unit_code, quantity: d(line.quantity), stockValue: orNull(line.stock_value), grniValue: orNull(line.grni_value), amount: orNull(line.amount), salesTax: orNull(line.sales_tax) })),
    allocations: allocations.map((line) => ({ id: line.id, billId: line.bill_id, billNumber: line.bill_number, supplierInvoiceNo: line.supplier_invoice_no, amount: d(line.amount), appliedOn: line.applied_on })),
  };
}

export type ReturnPage = SupplierReturn & {
  /** A draft: what can go back from its goods received note now. */
  canGoBack: Returnable[];
  /** A posted return with credit left: the supplier's bills in the branch that are still owed something. */
  billsOwed: BillOwed[];
};

/** One return for its own page. */
export async function getReturn(ctx: TenantContext, id: string): Promise<ReturnPage | null> {
  requireReturnAccess(ctx);
  if (!isUuid(id)) return null;
  return withTenant(ctx.userId, ctx.tenantId, async (tx) => {
    const found = await selectReturn(tx, ctx.tenantId, id);
    if (!found) return null;
    const canGoBack = found.status === "draft" ? await selectReturnables(tx, ctx.tenantId, found.receipt.id) : [];
    const billsOwed = found.status === "posted" && found.creditLeft.gt(0) ? await selectBillsOwed(tx, ctx.tenantId, found.receipt.supplierId, found.receipt.branchId) : [];
    return { ...found, canGoBack, billsOwed };
  });
}

/** A posted goods received note with what can go back from it: for the page that writes a new return. */
export async function getReturnStart(ctx: TenantContext, receiptId: string): Promise<{ receipt: ReceiptToReturn; canGoBack: Returnable[] } | null> {
  requireReturnAccess(ctx);
  if (!isUuid(receiptId)) return null;
  return withTenant(ctx.userId, ctx.tenantId, async (tx) => {
    const receipt = await selectReceiptToReturn(tx, ctx.tenantId, receiptId);
    if (!receipt) return null;
    return { receipt, canGoBack: await selectReturnables(tx, ctx.tenantId, receiptId) };
  });
}

export const RETURN_LIST_LIMIT = 200;

export type ReturnRowSummary = { id: string; status: ReturnStatus; number: string | null; date: string; supplierName: string; receiptNumber: string; grniValue: Decimal; credit: Decimal; creditLeft: Decimal };

/** The newest returns, each with what is left of its credit with the supplier. */
export async function listReturns(ctx: TenantContext): Promise<{ rows: ReturnRowSummary[]; more: boolean }> {
  requireReturnAccess(ctx);
  const found = await withTenant(ctx.userId, ctx.tenantId, (tx) =>
    tx.execute<{ id: string; status: ReturnStatus; number: string | null; return_date: string; supplier_name: string; receipt_number: string; grni_value: string; credit: string; used: string }>(sql`
      select r.id, r.status, r.number, r.return_date::text, s.name as supplier_name, g.number as receipt_number, r.grni_value::text, r.credit::text,
             coalesce((select sum(a.amount) from supplier_return_allocations a where a.tenant_id = r.tenant_id and a.return_id = r.id), 0)::text as used
      from supplier_returns r
      join suppliers s on s.tenant_id = r.tenant_id and s.id = r.supplier_id
      join goods_receipts g on g.tenant_id = r.tenant_id and g.id = r.receipt_id
      where r.tenant_id = ${ctx.tenantId}::uuid
      order by r.return_date desc, r.created_at desc
      limit ${RETURN_LIST_LIMIT + 1}`),
  );
  return {
    more: found.length > RETURN_LIST_LIMIT,
    rows: found.slice(0, RETURN_LIST_LIMIT).map((row) => ({ id: row.id, status: row.status, number: row.number, date: row.return_date, supplierName: row.supplier_name, receiptNumber: row.receipt_number, grniValue: d(row.grni_value), credit: d(row.credit), creditLeft: d(row.credit).minus(d(row.used)) })),
  };
}

export type ReceiptChoice = { id: string; number: string; date: string; supplierName: string; orderNumber: string; warehouseName: string };

/** The newest posted goods received notes, to choose the one goods go back from. */
export async function listReceiptsToReturn(ctx: TenantContext): Promise<ReceiptChoice[]> {
  requireReturnAccess(ctx);
  const rows = await withTenant(ctx.userId, ctx.tenantId, (tx) =>
    tx.execute<{ id: string; number: string; receipt_date: string; supplier_name: string; order_number: string; warehouse_name: string }>(sql`
      select r.id, r.number, r.receipt_date::text, s.name as supplier_name, o.number as order_number, w.name as warehouse_name
      from goods_receipts r
      join purchase_orders o on o.tenant_id = r.tenant_id and o.id = r.order_id
      join suppliers s on s.tenant_id = r.tenant_id and s.id = r.supplier_id
      join warehouses w on w.tenant_id = r.tenant_id and w.id = r.warehouse_id
      where r.tenant_id = ${ctx.tenantId}::uuid and r.status = 'posted'
      order by r.receipt_date desc, r.number desc
      limit 200`),
  );
  return rows.map((row) => ({ id: row.id, number: row.number, date: row.receipt_date, supplierName: row.supplier_name, orderNumber: row.order_number, warehouseName: row.warehouse_name }));
}

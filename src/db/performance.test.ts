import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, withTenant } from "@/db";
import { postCreditNote, saveCreditNoteDraft, startCreditNote } from "@/modules/credit-notes/commands";
import { setBaseCurrency } from "@/modules/currencies/commands";
import { postAdjustment, saveAdjustmentDraft } from "@/modules/inventory/commands";
import { addUnit, createItem } from "@/modules/items/commands";
import { seedAccounts } from "@/modules/ledger/commands";
import { openFiscalYear } from "@/modules/numbering/commands";
import { createParty } from "@/modules/parties/commands";
import { postReceipt as postGoodsReceipt, saveOrderDraft, saveReceiptDraft as saveGoodsReceiptDraft, submitOrder } from "@/modules/purchasing/commands";
import { getGrni, getOrder } from "@/modules/purchasing/queries";
import { postReceipt, saveReceiptDraft } from "@/modules/receipts/commands";
import { listCustomerAgeing } from "@/modules/recovery/queries";
import { getTrialBalance } from "@/modules/reports/queries";
import { postDelivery, postInvoice, saveDeliveryDraft, saveInvoiceDraft, saveSalesDraft, startDelivery, startInvoice, submitSalesDocument } from "@/modules/sales/commands";
import { getCustomerCredit, getSalesDocument, listOrdersToDeliver } from "@/modules/sales/queries";
import { getStockReport } from "@/modules/stock-reports/queries";
import { postBill, saveBillDraft } from "@/modules/supplier-bills/commands";
import type { TenantContext } from "@/modules/tenant/rules";
import { adminSql, deleteTenants, hasAdminDb, type AdminSql } from "../../tests/support/admin-db";

// Step 50, the performance pass, changed how seven questions are asked of the database, never
// what they answer. Each is set here beside the way it was asked before (written out below as
// it stood), for members of several kinds, on a small company with every case in it: an order
// part delivered, one invoiced straight from the order, one invoiced from its delivery note,
// one untouched, a credit note, a part payment, two branches and two salespeople.
// Skipped without the database URLs.

const hasDb = hasAdminDb() && Boolean(process.env.DATABASE_URL);
const PREFIX = "zz-performance-test";
const tenantA = randomUUID();
const tenantB = randomUUID();
const roles = ["owner", "accountant", "auditor", "sales_manager", "salesperson", "warehouse_manager", "recovery_officer"] as const;
const userIds = Object.fromEntries(roles.map((role) => [role, randomUUID()])) as Record<(typeof roles)[number], string>;
const secondSeller = randomUUID();
const northAccountant = randomUUID();
const ownerB = randomUUID();
const mainBranch = randomUUID();
const northBranch = randomUUID();
const mainStore = randomUUID();
const northStore = randomUUID();
const ctx = (userId: string, tenantId: string, role: TenantContext["role"], branchIds: string[] | null = null): TenantContext => ({ userId, email: `${role}-${userId.slice(0, 4)}@performance.test`, tenantId, tenantName: "x", role, branchIds });
const as = Object.fromEntries(roles.map((role) => [role, ctx(userIds[role], tenantA, role)])) as Record<(typeof roles)[number], TenantContext>;
const seller2 = ctx(secondSeller, tenantA, "salesperson");
const north = ctx(northAccountant, tenantA, "accountant", [northBranch]);
const other = ctx(ownerB, tenantB, "owner");
const TO = "2026-11-12";

let admin: AdminSql;
let helmet = "";
let glove = "";
let khan = "";
let rider = "";
const orders: Record<"partDelivered" | "direct" | "viaNote" | "untouched", string> = { partDelivered: "", direct: "", viaNote: "", untouched: "" };

type Rows = Record<string, unknown>[];
const read = (who: TenantContext, query: ReturnType<typeof sql>) => withTenant(who.userId, who.tenantId, async (tx) => [...(await tx.execute(query))] as Rows);
const refusal = async (run: () => Promise<unknown>) => run().then(() => "answered", (error: unknown) => String((error as { cause?: { message?: string }; message?: string }).cause?.message ?? (error as Error).message));

async function order(writer: TenantContext, customerId: string, warehouseId: string, date: string, lines: [string, string][]) {
  const { id } = await saveSalesDraft(writer, null, { kind: "order", date, customerId, warehouseId, lines: lines.map(([itemId, quantity]) => ({ itemId, quantity, unitId: "", unitPrice: "", discountPercent: "", description: "" })), shares: [] });
  await submitSalesDocument(writer, id);
  return id;
}
async function deliver(orderId: string, date: string, quantities: Record<string, string>) {
  const note = (await startDelivery(as.owner, orderId)).id;
  const draft = (await getSalesDocument(as.owner, note))!;
  await saveDeliveryDraft(as.owner, note, { date, lines: draft.lines.map((line) => ({ sourceLineId: line.sourceLineId, quantity: quantities[line.itemId] ?? "0" })) });
  await postDelivery(as.owner, note);
  return note;
}
async function bill(fromId: string, date: string) {
  const invoice = (await startInvoice(as.owner, fromId)).id;
  const draft = (await getSalesDocument(as.owner, invoice))!;
  await saveInvoiceDraft(as.owner, invoice, { date, lines: draft.lines.map((line) => ({ sourceLineId: line.sourceLineId, quantity: line.quantity.toFixed() })) });
  await postInvoice(as.owner, invoice);
  return invoice;
}

// ── The questions, as they were asked before Step 50 ────────────────────────────────────────────

const ordersToDeliverBefore = (tenantId: string) => sql`
  select o.id, o.number, o.document_date::text as date, coalesce(o.buyer_name, '') as customer_name, count(*)::int as lines
  from public.sales_documents o
  join public.sales_lines l on l.tenant_id = o.tenant_id and l.document_id = o.id
  where o.tenant_id = ${tenantId} and o.kind = 'order' and o.status = 'submitted'
    and l.base_quantity > coalesce((select d.delivered_base from app.order_progress(o.id) d where d.line_id = l.id), 0)
  group by o.id, o.number, o.document_date, o.buyer_name, o.created_at
  order by o.document_date, o.created_at
  limit 200`;

/** An order's progress as app.order_progress of drizzle/0018_sales_invoices.sql worked it out, for every order of the company. */
const orderProgressBefore = (tenantId: string) => sql`
  select ol.id::text as line_id, coalesce(gone.quantity, 0)::text as delivered, coalesce(gone.base_quantity, 0)::text as delivered_base,
    coalesce((
      select sum(l.quantity) from public.sales_lines l
      join public.sales_documents d on d.tenant_id = l.tenant_id and d.id = l.document_id
      where l.tenant_id = ${tenantId} and d.kind = 'invoice' and d.status = 'submitted'
        and (l.source_line_id = ol.id or l.source_line_id in (
          select dl.id from public.sales_lines dl
          join public.sales_documents dd on dd.tenant_id = dl.tenant_id and dd.id = dl.document_id
          where dl.tenant_id = ${tenantId} and dl.source_line_id = ol.id and dd.kind = 'delivery'))
    ), 0)::text as invoiced
  from public.sales_lines ol
  join public.sales_documents o on o.tenant_id = ol.tenant_id and o.id = ol.document_id
  left join lateral (
    select sum(l.quantity) as quantity, sum(l.base_quantity) as base_quantity
    from public.sales_lines l
    join public.sales_documents d on d.tenant_id = l.tenant_id and d.id = l.document_id
    where l.tenant_id = ${tenantId} and l.source_line_id = ol.id and d.kind in ('delivery', 'invoice') and d.status = 'submitted'
  ) gone on true
  where ol.tenant_id = ${tenantId} and o.kind = 'order'
  order by ol.id`;

/** "Orders already submitted" as app.customer_credit of drizzle/0018_sales_invoices.sql worked it out. */
const openOrdersBefore = (tenantId: string, customerId: string) => sql`
  select round(coalesce((
    select sum(greatest(o.total - coalesce((
      select sum(i.total) from public.sales_documents i
      where i.tenant_id = ${tenantId} and i.kind = 'invoice' and i.status = 'submitted'
        and (i.source_document_id = o.id or i.source_document_id in (
          select n.id from public.sales_documents n where n.tenant_id = ${tenantId} and n.kind = 'delivery' and n.source_document_id = o.id))
    ), 0), 0))
    from public.sales_documents o
    where o.tenant_id = ${tenantId} and o.customer_id = ${customerId} and o.kind = 'order' and o.status = 'submitted'
  ), 0), 4)::text as open_orders`;

const openQuantitiesBefore = (tenantId: string, branchId: string | null) => sql`
  select ol.item_id::text, sum(greatest(ol.base_quantity - coalesce((
      select sum(l.base_quantity) from public.sales_lines l
      join public.sales_documents x on x.tenant_id = l.tenant_id and x.id = l.document_id
      where l.tenant_id = ol.tenant_id and l.source_line_id = ol.id and x.kind in ('delivery', 'invoice') and x.status = 'submitted'), 0), 0))::text as open
  from public.sales_lines ol
  join public.sales_documents o on o.tenant_id = ol.tenant_id and o.id = ol.document_id
  join public.warehouses w on w.tenant_id = o.tenant_id and w.id = o.warehouse_id
  where ol.tenant_id = ${tenantId} and o.kind = 'order' and o.status = 'submitted' and (${branchId}::uuid is null or w.branch_id = ${branchId}::uuid)
  group by ol.item_id order by ol.item_id`;

const itemProfitBefore = (tenantId: string, from: string, to: string, branchId: string | null) => sql`
  with sold as (
    select l.item_id, l.base_quantity as quantity, l.value * s.exchange_rate as sales, coalesce(c.cost, 0) as cost
    from public.sales_lines l
    join public.sales_documents s on s.tenant_id = l.tenant_id and s.id = l.document_id
    left join lateral (
      select -sum(m.value) as cost from public.stock_moves m
      where m.tenant_id = l.tenant_id
        and ((m.source_type = 'sales_invoice' and m.source_id = s.id and m.source_line_id = l.id)
          or (m.source_type = 'delivery_note' and l.source_line_id is not null and m.source_line_id = l.source_line_id))
    ) c on true
    where l.tenant_id = ${tenantId} and s.kind = 'invoice' and s.status = 'submitted'
      and s.document_date between ${from}::date and ${to}::date
      and (${branchId}::uuid is null or s.branch_id = ${branchId}::uuid)
    union all
    select l.item_id, -l.base_quantity, -(l.value * s.exchange_rate), -coalesce(cc.cost - cc.written_off, 0)
    from public.sales_lines l
    join public.sales_documents s on s.tenant_id = l.tenant_id and s.id = l.document_id
    left join public.credit_note_line_costs cc on cc.tenant_id = l.tenant_id and cc.line_id = l.id
    where l.tenant_id = ${tenantId} and s.kind = 'credit_note' and s.status = 'submitted'
      and s.document_date between ${from}::date and ${to}::date
      and (${branchId}::uuid is null or s.branch_id = ${branchId}::uuid)
  )
  select sold.item_id::text, sum(sold.quantity)::text as quantity, round(sum(sold.sales), 4)::text as sales, sum(sold.cost)::text as cost
  from sold group by sold.item_id order by sold.item_id`;

/** The ledger's totals as the reports asked for them: every account, or (the owner's figures) only some before the period. */
const ledgerTotalsBefore = (tenantId: string, from: string, to: string, branchId: string | null, mode: "all" | "movements" | "owner") => sql`
  select l.account_id::text,
    coalesce(sum(l.debit - l.credit) filter (where j.journal_date < ${from}::date), 0)::text as before,
    coalesce(sum(l.debit) filter (where j.journal_date >= ${from}::date), 0)::text as debit,
    coalesce(sum(l.credit) filter (where j.journal_date >= ${from}::date), 0)::text as credit
  from public.journal_lines l
  join public.journals j on j.tenant_id = l.tenant_id and j.id = l.journal_id
  join public.accounts a on a.tenant_id = l.tenant_id and a.id = l.account_id
  where l.tenant_id = ${tenantId} and j.journal_date <= ${to}::date
    and (${branchId}::uuid is null or l.branch_id = ${branchId}::uuid)
    and (${mode}::text <> 'movements' or j.journal_date >= ${from}::date)
    and (${mode}::text <> 'owner' or j.journal_date >= ${from}::date or a.control_type in ('cash', 'bank', 'ar', 'ap'))
  group by l.account_id order by l.account_id`;

const grniBefore = (tenantId: string) => sql`
  select l.id::text as line_id, (l.quantity - billed.quantity - back.quantity)::text as quantity, (m.value - billed.value - back.value)::text as value
  from goods_receipts r
  join goods_receipt_lines l on l.tenant_id = r.tenant_id and l.receipt_id = r.id
  join purchase_orders o on o.tenant_id = r.tenant_id and o.id = r.order_id
  join purchase_order_lines ol on ol.tenant_id = l.tenant_id and ol.id = l.order_line_id
  join suppliers s on s.tenant_id = r.tenant_id and s.id = r.supplier_id
  join items i on i.tenant_id = l.tenant_id and i.id = l.item_id
  join units u on u.tenant_id = ol.tenant_id and u.id = ol.unit_id
  join stock_moves m on m.tenant_id = l.tenant_id and m.source_type = 'goods_receipt' and m.source_id = r.id and m.source_line_id = l.id
  cross join lateral (
    select coalesce(sum(bl.quantity), 0) as quantity, coalesce(sum(bl.received_value), 0) as value
    from supplier_bill_lines bl join supplier_bills b on b.tenant_id = bl.tenant_id and b.id = bl.bill_id
    where bl.tenant_id = l.tenant_id and bl.receipt_line_id = l.id and b.status = 'posted') billed
  cross join lateral (
    select coalesce(sum(x.quantity), 0) as quantity, coalesce(sum(x.grni_value), 0) as value
    from supplier_return_lines x join supplier_returns d on d.tenant_id = x.tenant_id and d.id = x.return_id
    where x.tenant_id = l.tenant_id and x.receipt_line_id = l.id and x.bill_line_id is null and d.status = 'posted') back
  where r.tenant_id = ${tenantId}::uuid and r.status = 'posted' and l.quantity > billed.quantity + back.quantity
  order by l.id`;

const receivablesBefore = (tenantId: string) => sql`
  select c.id::text as customer_id, r.kind, r.id::text as item_id, r.number, r.document_date::text, r.due_date::text, r.total::text, r.settled::text, r.outstanding::text
  from public.customers c cross join lateral app.receivables_open(c.id) r
  where c.tenant_id = ${tenantId}
  order by c.id, r.due_date, r.document_date, r.number`;

describe.skipIf(!hasDb)("the performance pass answers as before", { timeout: 600_000 }, () => {
  beforeAll(async () => {
    admin = adminSql();
    const stale = await admin<{ id: string }[]>`select id from public.tenants where name like ${PREFIX + "%"}`;
    await deleteTenants(admin, stale.map((r) => r.id));
    await admin`insert into public.tenants (id, name, created_by) values (${tenantA}, ${PREFIX + " A"}, ${userIds.owner}), (${tenantB}, ${PREFIX + " B"}, ${ownerB})`;
    await admin`insert into public.branches (id, tenant_id, name, created_by) values (${mainBranch}, ${tenantA}, 'Main', ${userIds.owner}), (${northBranch}, ${tenantA}, 'North', ${userIds.owner})`;
    await admin`insert into public.warehouses (id, tenant_id, branch_id, name, created_by) values (${mainStore}, ${tenantA}, ${mainBranch}, 'Main store', ${userIds.owner}), (${northStore}, ${tenantA}, ${northBranch}, 'North store', ${userIds.owner})`;
    await admin`insert into public.memberships ${admin([
      ...roles.map((role) => ({ tenant_id: tenantA, user_id: userIds[role], email: as[role].email, role, branch_ids: null, created_by: userIds.owner })),
      { tenant_id: tenantA, user_id: secondSeller, email: seller2.email, role: "salesperson", branch_ids: null, created_by: userIds.owner },
      { tenant_id: tenantA, user_id: northAccountant, email: north.email, role: "accountant", branch_ids: [northBranch], created_by: userIds.owner },
      { tenant_id: tenantB, user_id: ownerB, email: other.email, role: "owner", branch_ids: null, created_by: ownerB },
    ])}`;
    await admin`insert into public.company_setup (tenant_id, sales_tax_registered, accounts_template, completed_by) values (${tenantA}, false, 'trading', ${userIds.owner})`;
    await setBaseCurrency(as.owner, { code: "PKR", name: "Pakistani Rupee" });
    await seedAccounts(as.owner, "trading");
    await openFiscalYear(as.owner, { month: "7", year: "2026" });
    const [{ id: cash }] = await admin<{ id: string }[]>`select id from public.accounts where tenant_id = ${tenantA} and code = '1111'`;
    const piece = (await addUnit(as.owner, { code: "pc", name: "Piece" })).id;
    helmet = (await createItem(as.owner, { code: "HL-1", name: "Helmet", unit: piece, defaultPrice: "1000", reorderLevel: "500" })).id;
    glove = (await createItem(as.owner, { code: "GL-1", name: "Glove", unit: piece, defaultPrice: "300", reorderLevel: "500" })).id;
    khan = (await createParty(as.owner, "customer", { name: "Khan Autos", code: "C-001", creditDays: "30" })).id;
    rider = (await createParty(as.owner, "customer", { name: "Rider Mart", code: "C-002" })).id;
    for (const warehouseId of [mainStore, northStore]) {
      const { id } = await saveAdjustmentDraft(as.owner, "opening", null, { date: "2026-11-01", warehouseId, lines: [{ itemCode: "HL-1", direction: "in", quantity: "100", unitCost: "600" }, { itemCode: "GL-1", direction: "in", quantity: "100", unitCost: "150" }] });
      await postAdjustment(as.owner, id);
    }

    // The first salesperson's order, Main: ten helmets and five gloves; four helmets go out on a
    // delivery note, which is invoiced. Six helmets and five gloves are still to deliver.
    orders.partDelivered = await order(as.salesperson, khan, mainStore, "2026-11-05", [[helmet, "10"], [glove, "5"]]);
    const firstInvoice = await bill(await deliver(orders.partDelivered, "2026-11-06", { [helmet]: "4" }), "2026-11-06");
    // The second salesperson's order, North: three helmets, invoiced straight from the order.
    orders.direct = await order(seller2, rider, northStore, "2026-11-07", [[helmet, "3"]]);
    const directInvoice = await bill(orders.direct, "2026-11-07");
    // The first salesperson's order, Main: two gloves, delivered in full and invoiced from the note.
    orders.viaNote = await order(as.salesperson, rider, mainStore, "2026-11-08", [[glove, "2"]]);
    await bill(await deliver(orders.viaNote, "2026-11-08", { [glove]: "2" }), "2026-11-09");
    // The second salesperson's order, North: four gloves, nothing done yet.
    orders.untouched = await order(seller2, khan, northStore, "2026-11-09", [[glove, "4"]]);
    // One helmet of the invoice made straight from the order comes back.
    const billed = (await getSalesDocument(as.owner, directInvoice))!;
    const { id: creditNote } = await startCreditNote(as.owner, directInvoice);
    await saveCreditNoteDraft(as.owner, creditNote, { date: "2026-11-10", notes: "Wrong size.", reference: "", lines: [{ sourceLineId: billed.lines[0].id, quantity: "1", damaged: "0" }] });
    await postCreditNote(as.owner, creditNote);
    // Khan Autos pays 1,500 of the 4,000 invoiced.
    const receipt = await saveReceiptDraft(as.owner, null, { date: "2026-11-11", customerId: khan, method: "cash", accountId: cash, amount: "1500", chequeNumber: "", chequeBank: "", chequeDate: "", allocations: [{ kind: "invoice", id: firstInvoice, amount: "1500" }] });
    await postReceipt(as.owner, receipt.id);

    // Buying, on the last day and of an item nothing above sells, so that no figure above moves.
    // Forty brake pads arrive at Main and are not billed; thirty arrive at North, twenty of them billed.
    const brake = (await createItem(as.owner, { code: "BR-1", name: "Brake pad", unit: piece, defaultPrice: "400" })).id;
    const supplier = (await createParty(as.owner, "supplier", { name: "Lahore Parts", supplierType: "aop" })).id;
    const receive = async (warehouseId: string, quantity: string) => {
      const placed = await saveOrderDraft(as.owner, null, { date: TO, supplierId: supplier, warehouseId, lines: [{ itemId: brake, quantity, unitCost: "250" }] });
      await submitOrder(as.owner, placed.id);
      const lines = (await getOrder(as.owner, placed.id))!.lines;
      const note = await saveGoodsReceiptDraft(as.owner, null, placed.id, { date: TO, lines: lines.map((line) => ({ orderLineId: line.id, quantity: line.quantity.toFixed() })) });
      await postGoodsReceipt(as.owner, note.id);
      return (await admin<{ id: string }[]>`select id from public.goods_receipt_lines where tenant_id = ${tenantA} and receipt_id = ${note.id}`)[0].id;
    };
    await receive(mainStore, "40");
    const northLine = await receive(northStore, "30");
    const supplierBill = await saveBillDraft(as.owner, null, { date: TO, supplierId: supplier, branchId: northBranch, supplierInvoiceNo: "LP/1", goods: [{ receiptLineId: northLine, quantity: "20", unitPrice: "250" }] });
    await postBill(as.owner, supplierBill.id, supplierBill.updatedAt);
  }, 300_000);

  afterAll(async () => {
    await deleteTenants(admin, [tenantA, tenantB]);
    await admin.end();
    await closeDb();
  }, 120_000);

  it("orders to deliver: the same orders and lines for each kind of member, and a salesperson's own only", async () => {
    for (const who of [as.owner, as.accountant, as.auditor, as.sales_manager, as.warehouse_manager, as.salesperson, seller2, north]) {
      const before = (await read(who, ordersToDeliverBefore(tenantA))).map((row) => ({ id: row.id, number: row.number, date: row.date, customerName: row.customer_name, lines: row.lines }));
      expect(await listOrdersToDeliver(who), who.email).toEqual(before);
    }
    const seen = async (who: TenantContext) => (await listOrdersToDeliver(who)).map((row) => `${row.id}:${row.lines}`);
    expect(await seen(as.owner)).toEqual([`${orders.partDelivered}:2`, `${orders.untouched}:1`]);
    expect(await seen(as.salesperson)).toEqual([`${orders.partDelivered}:2`]);
    expect(await seen(seller2)).toEqual([`${orders.untouched}:1`]);
    expect(await seen(north)).toEqual([`${orders.untouched}:1`]);
    // Nobody outside the company, and nobody whose role does not include orders, is told anything.
    expect(await read(other, sql`select * from app.orders_to_deliver()`)).toEqual([]);
    expect(await read(as.recovery_officer, sql`select * from app.orders_to_deliver()`)).toEqual([]);
  });

  it("an order's progress: delivered and invoiced, line by line, as before", async () => {
    const before = await read(as.owner, orderProgressBefore(tenantA));
    const now: Rows = [];
    for (const id of Object.values(orders)) now.push(...(await read(as.owner, sql`select line_id::text, delivered::text, delivered_base::text, invoiced::text from app.order_progress(${id}::uuid)`)));
    expect(now.sort((a, b) => String(a.line_id).localeCompare(String(b.line_id)))).toEqual(before);
    // The part-delivered order: four of ten helmets delivered and invoiced, no gloves.
    const part = await read(as.owner, sql`select i.code, p.delivered::text, p.invoiced::text from app.order_progress(${orders.partDelivered}::uuid) p join public.sales_lines l on l.id = p.line_id join public.items i on i.id = l.item_id order by i.code`);
    expect(part).toEqual([{ code: "GL-1", delivered: "0", invoiced: "0" }, { code: "HL-1", delivered: "4.0000", invoiced: "4.0000" }]);
    // The same members as before are refused: an order that is not the salesperson's own, or of another company.
    expect(await read(seller2, sql`select * from app.order_progress(${orders.partDelivered}::uuid)`)).toEqual([]);
    expect(await read(other, sql`select * from app.order_progress(${orders.partDelivered}::uuid)`)).toEqual([]);
  });

  it("a customer's credit: orders already submitted, less what has been invoiced of them, as before", async () => {
    for (const customerId of [khan, rider]) {
      const [before] = await read(as.owner, openOrdersBefore(tenantA, customerId));
      const credit = (await getCustomerCredit(as.owner, customerId))!;
      expect(credit.openOrders.toFixed(4)).toBe(before.open_orders);
    }
    // Khan Autos: 11,500 ordered and 4,000 of it invoiced, and 1,200 not started. Rider Mart: all invoiced.
    expect((await getCustomerCredit(as.owner, khan))!.openOrders.toFixed(2)).toBe("8700.00");
    expect((await getCustomerCredit(as.owner, rider))!.openOrders.toFixed(2)).toBe("0.00");
  });

  it("low stock: what orders still have to deliver, by item and by branch, as before", async () => {
    for (const who of [as.owner, as.accountant, as.sales_manager, as.salesperson, seller2, north]) {
      for (const branchId of [null, mainBranch, northBranch]) {
        const before = await read(who, openQuantitiesBefore(tenantA, branchId));
        const now = await read(who, sql`select item_id::text, open::text from app.open_order_quantities(${branchId}::uuid) order by item_id`);
        expect(now, `${who.email} ${branchId}`).toEqual(before);
      }
    }
    const open = Object.fromEntries((await read(as.owner, sql`select i.code, q.open::text from app.open_order_quantities() q join public.items i on i.id = q.item_id`)).map((row) => [row.code, row.open]));
    expect(open).toEqual({ "HL-1": "6.0000", "GL-1": "9.0000" });
    // A warehouse manager does not read invoices, and so used to be shown the order invoiced
    // straight from the order as still to deliver. What has left has left, whoever reads.
    const forWarehouse = await read(as.warehouse_manager, sql`select item_id::text, open::text from app.open_order_quantities() order by item_id`);
    expect(forWarehouse).toEqual(await read(as.owner, sql`select item_id::text, open::text from app.open_order_quantities() order by item_id`));
    expect(await read(other, sql`select * from app.open_order_quantities()`)).toEqual([]);
    // And the report itself reads it.
    const table = await getStockReport(as.owner, "low-stock", { from: "2026-11-01", to: TO, branchId: null, warehouseId: null, itemId: null }, TO);
    expect(table.rows.length).toBeGreaterThan(0);
  });

  it("item profit: quantity, sales and cost by item, for the whole company and for a branch, as before", async () => {
    for (const who of [as.owner, as.accountant, as.auditor, north]) {
      for (const branchId of [null, mainBranch, northBranch]) {
        for (const [from, to] of [["2026-11-01", TO], ["2026-11-07", "2026-11-09"], ["2026-11-10", "2026-11-10"]]) {
          const before = await read(who, itemProfitBefore(tenantA, from, to, branchId));
          const now = await read(who, sql`select item_id::text, quantity::text, round(sales, 4)::text as sales, cost::text from app.item_profit(${from}::date, ${to}::date, ${branchId}::uuid) order by item_id`);
          expect(now, `${who.email} ${branchId} ${from}`).toEqual(before);
        }
      }
    }
    // Helmets: four and three sold, one back: six, for 6,000, that cost 3,600. Gloves: two, for 600, that cost 300.
    const whole = Object.fromEntries((await read(as.owner, sql`select i.code, p.quantity::text, p.sales::numeric(20,2)::text as sales, p.cost::numeric(20,2)::text as cost from app.item_profit('2026-11-01', ${TO}::date) p join public.items i on i.id = p.item_id`)).map((row) => [row.code, `${row.quantity} ${row.sales} ${row.cost}`]));
    expect(whole).toEqual({ "HL-1": "6.0000 6000.00 3600.00", "GL-1": "2.0000 600.00 300.00" });
    // Only those who may see what stock cost; and nothing of another company.
    for (const who of [as.salesperson, as.sales_manager, as.warehouse_manager, as.recovery_officer]) {
      expect(await refusal(() => read(who, sql`select * from app.item_profit('2026-11-01', ${TO}::date)`)), who.email).toContain("not allowed to see what stock cost");
    }
    expect(await read(other, sql`select * from app.item_profit('2026-11-01', ${TO}::date)`)).toEqual([]);
  });

  it("the ledger's totals by account: for the trial balance, the profit and loss and the owner's figures, as before", async () => {
    const BEFORE = { all: sql`null::text[]`, movements: sql`'{}'::text[]`, owner: sql`'{cash,bank,ar,ap}'::text[]` };
    for (const who of [as.owner, as.accountant, as.auditor, north]) {
      for (const branchId of [null, mainBranch, northBranch]) {
        for (const [from, to] of [["2026-11-01", TO], ["2026-11-07", "2026-11-09"], ["2026-11-11", TO], ["2026-07-01", "2026-11-06"]]) {
          for (const mode of ["all", "movements", "owner"] as const) {
            const before = await read(who, ledgerTotalsBefore(tenantA, from, to, branchId, mode));
            const now = await read(who, sql`select account_id::text, before::text, debit::text, credit::text from app.ledger_totals(${from}::date, ${to}::date, ${branchId}::uuid, ${BEFORE[mode]}) order by account_id`);
            expect(now, `${who.email} ${branchId} ${from} ${mode}`).toEqual(before);
          }
        }
      }
    }
    // The books balance, and there is something in them.
    const [sum] = await read(as.owner, sql`select count(*)::int as accounts, sum(before + debit - credit)::text as net from app.ledger_totals('2026-11-07', ${TO}::date)`);
    expect(Number(sum.accounts)).toBeGreaterThan(4);
    expect(Number(sum.net)).toBe(0);
    // The trial balance reads it.
    const table = await getTrialBalance(as.auditor, { from: "2026-11-01", to: TO, branchId: null, accountId: null });
    expect(table.rows.length).toBeGreaterThan(4);
    // Those who do not read the ledger are told nothing, as the tables' policies told them nothing.
    for (const who of [as.salesperson, as.sales_manager, as.warehouse_manager, as.recovery_officer, other]) {
      expect(await read(who, sql`select * from app.ledger_totals('2026-11-01', ${TO}::date)`), who.email).toEqual([]);
    }
  });

  it("aged receivables: every customer's unpaid invoices, as asking customer by customer gave them", async () => {
    for (const who of [as.owner, as.accountant, as.auditor, as.recovery_officer, as.sales_manager, north]) {
      const before = await read(who, receivablesBefore(tenantA));
      const now = await read(who, sql`select customer_id::text, kind, id::text as item_id, number, document_date::text, due_date::text, total::text, settled::text, outstanding::text from app.receivables_open_all()`);
      expect(now, who.email).toEqual(before);
    }
    const owed = Object.fromEntries((await listCustomerAgeing(as.recovery_officer, TO)).map((row) => [row.name, row.total.toFixed(2)]));
    // Khan Autos: 4,000 less 1,500 paid. Rider Mart: 3,000 less the helmet that came back, and 600.
    expect(owed).toEqual({ "Khan Autos": "2500.00", "Rider Mart": "2600.00" });
    for (const who of [as.salesperson, as.warehouse_manager]) {
      expect(await refusal(() => read(who, sql`select * from app.receivables_open_all()`)), who.email).toContain("not allowed to see what a customer has to pay");
    }
    expect(await read(other, sql`select * from app.receivables_open_all()`)).toEqual([]);
  });

  it("goods received and not billed: the lines, what is left of each and what it cost, as the tables' own policies gave them", async () => {
    for (const who of [as.owner, as.accountant, as.auditor, as.warehouse_manager, as.sales_manager, as.salesperson, as.recovery_officer, north]) {
      const before = await read(who, grniBefore(tenantA));
      const now = await read(who, sql`select receipt_line_id::text as line_id, quantity::text, value::text from app.goods_received_not_billed() order by receipt_line_id`);
      expect(now, who.email).toEqual(before);
    }
    // Forty at Main, and the ten of North's thirty that no bill has; at 250 each. The books hold the same.
    const whole = await getGrni(as.owner);
    expect(whole.rows.map((row) => `${row.itemCode} ${row.quantity.toFixed(0)} ${row.value.toFixed(2)}`).sort()).toEqual(["BR-1 10 2500.00", "BR-1 40 10000.00"]);
    expect([whole.total.toFixed(2), whole.ledger.toFixed(2)]).toEqual(["12500.00", "12500.00"]);
    // A member of the North branch only: North's ten.
    expect((await getGrni(north)).rows.map((row) => row.quantity.toFixed(0))).toEqual(["10"]);
    // Those who do not read what stock cost are told nothing, and nothing of another company is told.
    for (const who of [as.warehouse_manager, as.sales_manager, as.salesperson, as.recovery_officer, other]) {
      expect(await read(who, sql`select * from app.goods_received_not_billed()`), who.email).toEqual([]);
    }
  });

  it("low stock for a salesperson who wrote an order another salesperson leads: what has left has left", async () => {
    // Found by this step's reviewer. The first salesperson writes an order for seven brake pads
    // that the second leads; five are delivered and invoiced. The writer reads the order, not
    // the delivery note or the invoice, and used to be told all seven were still to deliver.
    const { id } = await saveSalesDraft(as.salesperson, null, {
      kind: "order", date: TO, customerId: khan, warehouseId: mainStore,
      lines: [{ itemId: (await read(as.owner, sql`select id::text from public.items where code = 'BR-1'`))[0].id as string, quantity: "7", unitId: "", unitPrice: "", discountPercent: "", description: "" }],
      shares: [{ userId: secondSeller, percent: "100" }],
    });
    await submitSalesDocument(as.salesperson, id);
    const [brake] = await read(as.owner, sql`select id::text from public.items where code = 'BR-1'`);
    await bill(await deliver(id, TO, { [brake.id as string]: "5" }), TO);
    const open = async (who: TenantContext) => (await read(who, sql`select q.open::text from app.open_order_quantities() q where q.item_id = ${brake.id}::uuid`))[0]?.open;
    expect([await open(as.owner), await open(as.salesperson), await open(seller2), await open(as.warehouse_manager)]).toEqual(["2.0000", "2.0000", "2.0000", "2.0000"]);
    // As it was asked before, through the policies: right for the owner, seven for the writer.
    const before = async (who: TenantContext) => (await read(who, openQuantitiesBefore(tenantA, null))).find((row) => row.item_id === brake.id)?.open;
    expect([await before(as.owner), await before(as.salesperson)]).toEqual(["2.0000", "7.0000"]);
  });
});

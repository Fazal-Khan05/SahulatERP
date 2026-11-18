import "server-only";
import Decimal from "decimal.js";
import { sql } from "drizzle-orm";
import { isUuid, withTenant, type Tx } from "@/db";
import { UserError } from "@/lib/errors";
import { can, type TenantContext } from "@/modules/tenant/rules";
import { previewSpread, type ChargeBasis, type ChargeClass, type GoodsLine, type ShipmentStage, type ShipmentStatus, type SpreadPreview } from "./rules";

// Reading shipments and the charges of bringing them in: for the owner and whoever keeps or
// checks the books, in the branches they work in.

export function requireShipmentAccess(ctx: TenantContext): void {
  if (!can(ctx.role, "shipment.read")) throw new UserError("Your role does not include shipments.");
}

const d = (value: string | null) => new Decimal(value ?? "0");

export type ShipmentGoods = GoodsLine & { receiptId: string; receiptNumber: string; receiptDate: string; description: string; unitCode: string; landed: Decimal };
export type ShipmentReceipt = { id: string; receiptId: string; number: string; date: string; warehouseName: string; lines: number };
export type ShipmentCharge = {
  id: string;
  billLineId: string;
  billId: string;
  billNumber: string;
  billDate: string;
  billedBy: string;
  description: string;
  class: ChargeClass;
  basis: ChargeBasis | null;
  accountName: string | null;
  amount: Decimal;
  allocationId: string | null;
};
export type ShipmentAllocation = { id: string; date: string; total: Decimal; toStock: Decimal; toCogs: Decimal; journalId: string; charges: number };

export type Shipment = {
  id: string;
  number: string;
  status: ShipmentStatus;
  stage: ShipmentStage;
  openedOn: string;
  supplierId: string;
  supplierName: string;
  branchId: string;
  branchName: string;
  origin: string | null;
  port: string | null;
  containerNo: string | null;
  blNumber: string | null;
  lcNumber: string | null;
  gdNumber: string | null;
  gdDate: string | null;
  customsValue: Decimal | null;
  expectedOn: string | null;
  note: string | null;
  cancelReason: string | null;
  updatedAt: Date;
  receipts: ShipmentReceipt[];
  goods: ShipmentGoods[];
  charges: ShipmentCharge[];
  allocations: ShipmentAllocation[];
};

type ShipmentRow = {
  id: string; number: string; status: ShipmentStatus; stage: ShipmentStage; opened_on: string; supplier_id: string; supplier_name: string; branch_id: string; branch_name: string;
  origin: string | null; port: string | null; container_no: string | null; bl_number: string | null; lc_number: string | null; gd_number: string | null; gd_date: string | null;
  customs_value: string | null; expected_on: string | null; note: string | null; cancel_reason: string | null; updated_at: Date;
};

/** One shipment with its goods, its charges and how they were spread, inside a transaction the caller holds. Null when it is not one this member may read. `lock` holds its row. */
export async function selectShipment(tx: Tx, tenantId: string, id: string, lock = false): Promise<Shipment | null> {
  if (lock) await tx.execute(sql`select 1 from shipments where tenant_id = ${tenantId}::uuid and id = ${id}::uuid for update`);
  const [row] = await tx.execute<ShipmentRow>(sql`
    select s.id, s.number, s.status, s.stage, s.opened_on::text, s.supplier_id, p.name as supplier_name, s.branch_id, b.name as branch_name, s.origin, s.port, s.container_no,
           s.bl_number, s.lc_number, s.gd_number, s.gd_date::text, s.customs_value::text, s.expected_on::text, s.note, s.cancel_reason, s.updated_at
    from shipments s
    join suppliers p on p.tenant_id = s.tenant_id and p.id = s.supplier_id
    join branches b on b.tenant_id = s.tenant_id and b.id = s.branch_id
    where s.tenant_id = ${tenantId}::uuid and s.id = ${id}::uuid`);
  if (!row) return null;
  const [receipts, goods, charges, allocations] = await Promise.all([
    tx.execute<{ id: string; receipt_id: string; number: string; receipt_date: string; warehouse_name: string; lines: number }>(sql`
      select x.id, x.receipt_id, r.number, r.receipt_date::text, w.name as warehouse_name,
             (select count(*)::int from goods_receipt_lines g where g.tenant_id = r.tenant_id and g.receipt_id = r.id) as lines
      from shipment_receipts x
      join goods_receipts r on r.tenant_id = x.tenant_id and r.id = x.receipt_id
      join warehouses w on w.tenant_id = r.tenant_id and w.id = r.warehouse_id
      where x.tenant_id = ${tenantId}::uuid and x.shipment_id = ${id}::uuid
      order by r.receipt_date, r.number`),
    tx.execute<{ receipt_line_id: string; receipt_id: string; receipt_number: string; receipt_date: string; item_id: string; item_code: string; description: string; unit_code: string; quantity: string; value: string; weight: string; volume: string; landed: string }>(sql`
      select g.id as receipt_line_id, r.id as receipt_id, r.number as receipt_number, r.receipt_date::text, g.item_id, i.code as item_code, ol.description, u.code as unit_code,
             g.base_quantity::text as quantity, m.value::text, (g.base_quantity * coalesce(i.weight, 0))::text as weight, (g.base_quantity * coalesce(i.volume, 0))::text as volume,
             coalesce((select sum(a.amount) from landed_cost_allocations a where a.tenant_id = g.tenant_id and a.receipt_line_id = g.id), 0)::text as landed
      from shipment_receipts x
      join goods_receipts r on r.tenant_id = x.tenant_id and r.id = x.receipt_id
      join goods_receipt_lines g on g.tenant_id = r.tenant_id and g.receipt_id = r.id
      join purchase_order_lines ol on ol.tenant_id = g.tenant_id and ol.id = g.order_line_id
      join items i on i.tenant_id = g.tenant_id and i.id = g.item_id
      join units u on u.tenant_id = i.tenant_id and u.id = i.base_unit_id
      join stock_moves m on m.tenant_id = g.tenant_id and m.source_type = 'goods_receipt' and m.source_id = r.id and m.source_line_id = g.id
      where x.tenant_id = ${tenantId}::uuid and x.shipment_id = ${id}::uuid
      order by r.receipt_date, r.number, g.line_no`),
    tx.execute<{ id: string; bill_line_id: string; bill_id: string; bill_number: string; bill_date: string; billed_by: string; description: string; class: ChargeClass; basis: ChargeBasis | null; account_name: string | null; amount: string; allocation_id: string | null }>(sql`
      select c.id, c.bill_line_id, b.id as bill_id, b.number as bill_number, b.bill_date::text, p.name as billed_by, l.description, c.class, c.basis,
             a.code || ' ' || a.name as account_name, c.amount::text, c.allocation_id
      from shipment_charges c
      join supplier_bill_lines l on l.tenant_id = c.tenant_id and l.id = c.bill_line_id
      join supplier_bills b on b.tenant_id = l.tenant_id and b.id = l.bill_id
      join suppliers p on p.tenant_id = b.tenant_id and p.id = b.supplier_id
      left join accounts a on a.tenant_id = c.tenant_id and a.id = c.account_id
      where c.tenant_id = ${tenantId}::uuid and c.shipment_id = ${id}::uuid
      order by c.created_at, c.id`),
    tx.execute<{ id: string; allocated_on: string; total: string; to_stock: string; to_cogs: string; journal_id: string; charges: number }>(sql`
      select a.id, a.allocated_on::text, a.total::text, a.to_stock::text, a.to_cogs::text, a.journal_id,
             (select count(*)::int from shipment_charges c where c.tenant_id = a.tenant_id and c.allocation_id = a.id) as charges
      from shipment_allocations a
      where a.tenant_id = ${tenantId}::uuid and a.shipment_id = ${id}::uuid
      order by a.allocated_on, a.created_at`),
  ]);
  return {
    id: row.id,
    number: row.number,
    status: row.status,
    stage: row.stage,
    openedOn: row.opened_on,
    supplierId: row.supplier_id,
    supplierName: row.supplier_name,
    branchId: row.branch_id,
    branchName: row.branch_name,
    origin: row.origin,
    port: row.port,
    containerNo: row.container_no,
    blNumber: row.bl_number,
    lcNumber: row.lc_number,
    gdNumber: row.gd_number,
    gdDate: row.gd_date,
    customsValue: row.customs_value === null ? null : d(row.customs_value),
    expectedOn: row.expected_on,
    note: row.note,
    cancelReason: row.cancel_reason,
    updatedAt: new Date(row.updated_at),
    receipts: receipts.map((r) => ({ id: r.id, receiptId: r.receipt_id, number: r.number, date: r.receipt_date, warehouseName: r.warehouse_name, lines: r.lines })),
    goods: goods.map((g) => ({ receiptLineId: g.receipt_line_id, receiptId: g.receipt_id, receiptNumber: g.receipt_number, receiptDate: g.receipt_date, itemId: g.item_id, itemCode: g.item_code, description: g.description, unitCode: g.unit_code, quantity: d(g.quantity), value: d(g.value), weight: d(g.weight), volume: d(g.volume), landed: d(g.landed) })),
    charges: charges.map((c) => ({ id: c.id, billLineId: c.bill_line_id, billId: c.bill_id, billNumber: c.bill_number, billDate: c.bill_date, billedBy: c.billed_by, description: c.description, class: c.class, basis: c.basis, accountName: c.account_name, amount: d(c.amount), allocationId: c.allocation_id })),
    allocations: allocations.map((a) => ({ id: a.id, date: a.allocated_on, total: d(a.total), toStock: d(a.to_stock), toCogs: d(a.to_cogs), journalId: a.journal_id, charges: a.charges })),
  };
}

export type Choice = { id: string; label: string };
export type BillLineChoice = { billLineId: string; label: string; amount: Decimal };

/** Posted goods received notes of a supplier into a branch that are on no shipment yet. */
export async function selectReceiptsToShip(tx: Tx, tenantId: string, supplierId: string, branchId: string): Promise<Choice[]> {
  const rows = await tx.execute<{ id: string; number: string; receipt_date: string }>(sql`
    select r.id, r.number, r.receipt_date::text
    from goods_receipts r join warehouses w on w.tenant_id = r.tenant_id and w.id = r.warehouse_id
    where r.tenant_id = ${tenantId}::uuid and r.status = 'posted' and r.supplier_id = ${supplierId}::uuid and w.branch_id = ${branchId}::uuid
      and not exists (select 1 from shipment_receipts x where x.tenant_id = r.tenant_id and x.receipt_id = r.id)
    order by r.receipt_date desc, r.number desc
    limit 200`);
  return rows.map((row) => ({ id: row.id, label: `${row.number} of ${row.receipt_date.split("-").reverse().join("-")}` }));
}

/**
 * Lines of posted bills of a branch that were charged to Goods in transit and are on no
 * shipment yet, with what each bill charged for its line (the province's tax on it included).
 */
export async function selectBillLinesToCharge(tx: Tx, tenantId: string, branchId: string): Promise<BillLineChoice[]> {
  const rows = await tx.execute<{ bill_line_id: string; number: string; supplier_name: string; description: string; charged: string }>(sql`
    with waiting as (
      select l.id, l.bill_id, l.line_no, l.description, l.amount, b.number, b.bill_date, b.provincial_tax, p.name as supplier_name
      from supplier_bill_lines l
      join supplier_bills b on b.tenant_id = l.tenant_id and b.id = l.bill_id
      join suppliers p on p.tenant_id = b.tenant_id and p.id = b.supplier_id
      join accounts a on a.tenant_id = l.tenant_id and a.id = l.account_id
      where l.tenant_id = ${tenantId}::uuid and l.kind = 'expense' and b.status = 'posted' and b.branch_id = ${branchId}::uuid and a.is_control and a.control_type = 'goods_in_transit'
        and not exists (select 1 from shipment_charges c where c.tenant_id = l.tenant_id and c.bill_line_id = l.id)
    ),
    -- The province's tax on a bill is shared over its expense lines in proportion, the last taking what is left, as the bill was posted.
    shares as (
      select e.id, e.bill_id, e.amount, e.line_no, b.provincial_tax as tax, max(e.line_no) over (partition by e.bill_id) as last_no,
             round(b.provincial_tax * e.amount / sum(e.amount) over (partition by e.bill_id), 2) as share
      from supplier_bill_lines e join supplier_bills b on b.tenant_id = e.tenant_id and b.id = e.bill_id
      where e.tenant_id = ${tenantId}::uuid and e.kind = 'expense' and e.bill_id in (select bill_id from waiting)
    ),
    charged as (
      select s.id, s.amount + case when s.tax = 0 then 0
                                   when s.line_no = s.last_no then s.tax - coalesce(sum(s.share) over (partition by s.bill_id order by s.line_no rows between unbounded preceding and 1 preceding), 0)
                                   else s.share end as charged
      from shares s
    )
    select w.id as bill_line_id, w.number, w.supplier_name, w.description, c.charged::text
    from waiting w join charged c on c.id = w.id
    order by w.bill_date, w.number, w.line_no
    limit 500`);
  return rows.map((row) => ({ billLineId: row.bill_line_id, label: `${row.number}, ${row.supplier_name}: ${row.description}`, amount: d(row.charged) }));
}

export type ShipmentPage = Shipment & {
  receiptsToAdd: Choice[];
  billLinesToAdd: BillLineChoice[];
  /** Accounts a deposit and an expense can go to. */
  depositAccounts: Choice[];
  expenseAccounts: Choice[];
  /** What spreading the waiting charges would do today; null when none is waiting or there are no goods. */
  preview: { ok: true; preview: SpreadPreview } | { ok: false; reason: string } | null;
};

/** One shipment for its own page. */
export async function getShipment(ctx: TenantContext, id: string): Promise<ShipmentPage | null> {
  requireShipmentAccess(ctx);
  if (!isUuid(id)) return null;
  return withTenant(ctx.userId, ctx.tenantId, async (tx) => {
    const shipment = await selectShipment(tx, ctx.tenantId, id);
    if (!shipment) return null;
    const open = shipment.status !== "cancelled";
    const [receiptsToAdd, billLinesToAdd, accounts, held] = await Promise.all([
      shipment.status === "open" ? selectReceiptsToShip(tx, ctx.tenantId, shipment.supplierId, shipment.branchId) : Promise.resolve([]),
      open ? selectBillLinesToCharge(tx, ctx.tenantId, shipment.branchId) : Promise.resolve([]),
      open
        ? tx.execute<{ id: string; code: string; name: string; type: string }>(sql`
            select id, code, name, type from accounts
            where tenant_id = ${ctx.tenantId}::uuid and not is_group and not is_control and archived_at is null and type in ('asset', 'expense') order by code`)
        : Promise.resolve([]),
      shipment.goods.length === 0
        ? Promise.resolve([])
        : tx.execute<{ item_id: string; quantity: string }>(sql`
            select b.item_id, sum(b.quantity)::text as quantity from stock_balances b
            where b.tenant_id = ${ctx.tenantId}::uuid and b.item_id in (
              select g.item_id from shipment_receipts x join goods_receipt_lines g on g.tenant_id = x.tenant_id and g.receipt_id = x.receipt_id
              where x.tenant_id = ${ctx.tenantId}::uuid and x.shipment_id = ${id}::uuid)
            group by b.item_id`),
    ]);
    const waiting = shipment.charges.filter((charge) => charge.allocationId === null);
    const preview = waiting.length === 0 || shipment.goods.length === 0 ? null : previewSpread(waiting, shipment.goods, new Map(held.map((row) => [row.item_id, d(row.quantity)])));
    return {
      ...shipment,
      receiptsToAdd,
      billLinesToAdd,
      depositAccounts: accounts.filter((a) => a.type === "asset").map((a) => ({ id: a.id, label: `${a.code} ${a.name}` })),
      expenseAccounts: accounts.filter((a) => a.type === "expense").map((a) => ({ id: a.id, label: `${a.code} ${a.name}` })),
      preview,
    };
  });
}

export const SHIPMENT_LIST_LIMIT = 200;

export type ShipmentRowSummary = { id: string; number: string; status: ShipmentStatus; stage: ShipmentStage; openedOn: string; supplierName: string; containerNo: string | null; gdNumber: string | null; expectedOn: string | null; waiting: Decimal };

/**
 * The newest shipments, each with the charges on it that have not been spread yet; and what
 * Goods in transit holds in the books beside the charges that account for it: those on
 * shipments and not yet spread, and those billed and not yet put on a shipment.
 */
export async function listShipments(ctx: TenantContext): Promise<{ rows: ShipmentRowSummary[]; more: boolean; inTransit: { ledger: Decimal; onShipments: Decimal; notOnAShipment: Decimal } }> {
  requireShipmentAccess(ctx);
  return withTenant(ctx.userId, ctx.tenantId, async (tx) => {
    const [found, [position]] = await Promise.all([
      tx.execute<{ id: string; number: string; status: ShipmentStatus; stage: ShipmentStage; opened_on: string; supplier_name: string; container_no: string | null; gd_number: string | null; expected_on: string | null; waiting: string }>(sql`
        select s.id, s.number, s.status, s.stage, s.opened_on::text, p.name as supplier_name, s.container_no, s.gd_number, s.expected_on::text,
               coalesce((select sum(c.amount) from shipment_charges c where c.tenant_id = s.tenant_id and c.shipment_id = s.id and c.allocation_id is null), 0)::text as waiting
        from shipments s join suppliers p on p.tenant_id = s.tenant_id and p.id = s.supplier_id
        where s.tenant_id = ${ctx.tenantId}::uuid
        order by s.opened_on desc, s.number desc
        limit ${SHIPMENT_LIST_LIMIT + 1}`),
      tx.execute<{ ledger: string; on_shipments: string }>(sql`
        select
          (select coalesce(sum(jl.debit - jl.credit), 0) from journal_lines jl join accounts a on a.tenant_id = jl.tenant_id and a.id = jl.account_id
            where jl.tenant_id = ${ctx.tenantId}::uuid and a.is_control and a.control_type = 'goods_in_transit')::text as ledger,
          (select coalesce(sum(c.amount), 0) from shipment_charges c where c.tenant_id = ${ctx.tenantId}::uuid and c.allocation_id is null)::text as on_shipments`),
    ]);
    const ledger = d(position?.ledger ?? "0");
    const onShipments = d(position?.on_shipments ?? "0");
    return {
      more: found.length > SHIPMENT_LIST_LIMIT,
      rows: found.slice(0, SHIPMENT_LIST_LIMIT).map((row) => ({ id: row.id, number: row.number, status: row.status, stage: row.stage, openedOn: row.opened_on, supplierName: row.supplier_name, containerNo: row.container_no, gdNumber: row.gd_number, expectedOn: row.expected_on, waiting: d(row.waiting) })),
      inTransit: { ledger, onShipments, notOnAShipment: ledger.minus(onShipments) },
    };
  });
}

/** The suppliers and branches a new shipment can name. */
export async function getShipmentChoices(ctx: TenantContext): Promise<{ suppliers: Choice[]; branches: Choice[] }> {
  requireShipmentAccess(ctx);
  return withTenant(ctx.userId, ctx.tenantId, async (tx) => {
    const [suppliers, branches] = await Promise.all([
      tx.execute<{ id: string; name: string; code: string | null }>(sql`select id, name, code from suppliers where tenant_id = ${ctx.tenantId}::uuid and archived_at is null order by lower(name) limit 1000`),
      tx.execute<{ id: string; name: string }>(sql`select id, name from branches where tenant_id = ${ctx.tenantId}::uuid order by created_at`),
    ]);
    return { suppliers: suppliers.map((row) => ({ id: row.id, label: row.code ? `${row.name} (${row.code})` : row.name })), branches: branches.map((row) => ({ id: row.id, label: row.name })) };
  });
}

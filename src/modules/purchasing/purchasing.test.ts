import { randomUUID } from "node:crypto";
import { todayIso } from "@/lib/format";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, withTenant } from "@/db";
import { setBaseCurrency } from "@/modules/currencies/commands";
import { addUnit, createItem, setItemUnit } from "@/modules/items/commands";
import { seedAccounts } from "@/modules/ledger/commands";
import { openFiscalYear, setPeriodLocked } from "@/modules/numbering/commands";
import { createParty, setPartyArchived } from "@/modules/parties/commands";
import type { TenantContext } from "@/modules/tenant/rules";
import { adminSql, deleteTenants, hasAdminDb, type AdminSql } from "../../../tests/support/admin-db";
import { cancelOrder, discardOrder, discardReceipt, postReceipt, saveOrderDraft, saveReceiptDraft, submitOrder } from "./commands";
import { getGrni, getOrder, getOrderToReceive, getReceipt, listOrders, listOrdersToReceive, listReceipts } from "./queries";

// Purchase orders and goods received against a real database, through the app's own path
// (app_runtime, withTenant, row-level security): what each writes, what is refused, that the
// warehouse never sees what goods cost, and that the books always agree with the stock and
// with what has been received and not billed. Skipped when the database URLs are absent.

const hasDb = hasAdminDb() && Boolean(process.env.DATABASE_URL);
const PREFIX = "zz-purchase-test";
const tenantA = randomUUID();
const tenantB = randomUUID();
const roles = ["owner", "accountant", "auditor", "sales_manager", "salesperson", "warehouse_manager", "recovery_officer"] as const;
const userIds = Object.fromEntries(roles.map((role) => [role, randomUUID()])) as Record<(typeof roles)[number], string>;
const northKeeper = randomUUID();
const ownerB = randomUUID();
const mainBranch = randomUUID();
const northBranch = randomUUID();
const mainWarehouse = randomUUID();
const northWarehouse = randomUUID();
const ctx = (userId: string, tenantId: string, role: TenantContext["role"], branchIds: string[] | null = null): TenantContext => ({ userId, email: `${role}-${userId.slice(0, 4)}@purchase.test`, tenantId, tenantName: "x", role, branchIds });
const as = Object.fromEntries(roles.map((role) => [role, ctx(userIds[role], tenantA, role)])) as Record<(typeof roles)[number], TenantContext>;
const keeper = ctx(northKeeper, tenantA, "warehouse_manager", [northBranch]);
const otherOwner = ctx(ownerB, tenantB, "owner");
const ORDERED = "2026-11-10";
const ARRIVED = "2026-11-12";

let admin: AdminSql;
let supplier = "";
let otherSupplier = "";
let helmet = "";
let chain = "";
let grip = "";
let carton = "";

/** The database's code for what a statement run as this member was refused with, or undefined when it went through. */
async function codeOf(who: TenantContext, statement: ReturnType<typeof sql>): Promise<string | undefined> {
  try {
    await withTenant(who.userId, who.tenantId, (tx) => tx.execute(statement));
    return undefined;
  } catch (error) {
    const e = error as { code?: string; cause?: { code?: string } };
    return e.cause?.code ?? e.code ?? "unknown";
  }
}
const rowsOf = async (who: TenantContext, statement: ReturnType<typeof sql>) => (await withTenant(who.userId, who.tenantId, (tx) => tx.execute(statement))).length;
const stock = async (code: string, warehouseId = mainWarehouse) => {
  const [row] = await admin`
    select b.quantity::text, b.value::text from public.stock_balances b join public.items i on i.id = b.item_id
    where b.tenant_id = ${tenantA} and i.code = ${code} and b.warehouse_id = ${warehouseId}`;
  return row ? `${Number(row.quantity)} worth ${Number(row.value).toFixed(2)}` : "none";
};
const journalLines = async (sourceId: string) =>
  (
    await admin<{ line: string }[]>`
      select a.code || ' ' || a.name || ': ' || trim_scale(l.debit)::text || ' / ' || trim_scale(l.credit)::text as line
      from public.journals j join public.journal_lines l on l.journal_id = j.id join public.accounts a on a.id = l.account_id
      where j.source_type = 'goods_receipt' and j.source_id = ${sourceId} order by l.line_no`
  ).map((row) => row.line);
const line = (itemId: string, quantity: string, unitCost: string, unitId = "") => ({ itemId, unitId, quantity, unitCost });
const head = (warehouseId = mainWarehouse) => ({ date: ORDERED, supplierId: supplier, warehouseId });

/** A submitted order, by the owner. */
async function order(lines: ReturnType<typeof line>[], warehouseId = mainWarehouse, date = ORDERED): Promise<{ id: string; number: string; lineIds: string[] }> {
  const { id } = await saveOrderDraft(as.owner, null, { ...head(warehouseId), date, lines });
  const { number } = await submitOrder(as.owner, id);
  const stored = await getOrder(as.owner, id);
  return { id, number, lineIds: stored!.lines.map((l) => l.id) };
}
/** Goods received against an order and posted, by the warehouse unless someone else is named. */
async function receive(orderId: string, lines: { orderLineId: string; quantity: string }[], who: TenantContext = as.warehouse_manager, date = ARRIVED): Promise<{ id: string; number: string }> {
  const { id } = await saveReceiptDraft(who, null, orderId, { date, lines });
  return { id, ...(await postReceipt(who, id)) };
}
/** The stock account against the warehouses and the moves; the GRNI account against what the goods received came in at. */
async function booksAgree(): Promise<{ stockLedger: string; balances: string; moves: string; grniLedger: string; received: string }> {
  const one = async (query: Promise<{ v: string }[]>) => (await query)[0].v;
  return {
    stockLedger: await one(admin`select coalesce(sum(l.debit - l.credit), 0)::numeric(20,2)::text as v from public.journal_lines l join public.accounts a on a.id = l.account_id where l.tenant_id = ${tenantA} and a.control_type = 'inventory'`),
    balances: await one(admin`select coalesce(sum(value), 0)::numeric(20,2)::text as v from public.stock_balances where tenant_id = ${tenantA}`),
    moves: await one(admin`select coalesce(sum(value), 0)::numeric(20,2)::text as v from public.stock_moves where tenant_id = ${tenantA}`),
    grniLedger: await one(admin`select coalesce(sum(l.credit - l.debit), 0)::numeric(20,2)::text as v from public.journal_lines l join public.accounts a on a.id = l.account_id where l.tenant_id = ${tenantA} and a.control_type = 'grni'`),
    received: await one(admin`select coalesce(sum(value), 0)::numeric(20,2)::text as v from public.stock_moves where tenant_id = ${tenantA} and source_type = 'goods_receipt'`),
  };
}

describe.skipIf(!hasDb)("purchase orders and goods received", () => {
  beforeAll(async () => {
    admin = adminSql();
    const stale = await admin<{ id: string }[]>`select id from public.tenants where name like ${PREFIX + "%"}`;
    await deleteTenants(admin, stale.map((r) => r.id));
    await admin`insert into public.tenants (id, name, created_by) values (${tenantA}, ${PREFIX + " A"}, ${userIds.owner}), (${tenantB}, ${PREFIX + " B"}, ${ownerB})`;
    await admin`insert into public.branches (id, tenant_id, name, created_by) values (${mainBranch}, ${tenantA}, 'Main', ${userIds.owner}), (${northBranch}, ${tenantA}, 'North', ${userIds.owner})`;
    await admin`insert into public.warehouses (id, tenant_id, branch_id, name, created_by) values (${mainWarehouse}, ${tenantA}, ${mainBranch}, 'Main store', ${userIds.owner}), (${northWarehouse}, ${tenantA}, ${northBranch}, 'North store', ${userIds.owner})`;
    await admin`insert into public.memberships ${admin([
      ...roles.map((role) => ({ tenant_id: tenantA, user_id: userIds[role], email: as[role].email, role, branch_ids: null, created_by: userIds.owner })),
      { tenant_id: tenantA, user_id: northKeeper, email: keeper.email, role: "warehouse_manager", branch_ids: [northBranch], created_by: userIds.owner },
      { tenant_id: tenantB, user_id: ownerB, email: otherOwner.email, role: "owner", branch_ids: null, created_by: ownerB },
    ])}`;
    await admin`insert into public.company_setup (tenant_id, sales_tax_registered, accounts_template, completed_by) values (${tenantA}, false, 'trading', ${userIds.owner})`;
    await setBaseCurrency(as.owner, { code: "PKR", name: "Pakistani Rupee" });
    await seedAccounts(as.owner, "trading");
    await openFiscalYear(as.owner, { month: "7", year: "2026" });
    const piece = (await addUnit(as.owner, { code: "pc", name: "Piece" })).id;
    carton = (await addUnit(as.owner, { code: "ctn", name: "Carton" })).id;
    helmet = (await createItem(as.owner, { code: "HL-1", name: "Helmet", unit: piece, defaultPrice: "1000" })).id;
    chain = (await createItem(as.owner, { code: "CH-2", name: "Chain", unit: piece, defaultPrice: "400" })).id;
    grip = (await createItem(as.owner, { code: "GR-3", name: "Grip", unit: piece, defaultPrice: "50" })).id;
    await setItemUnit(as.owner, chain, { unit: carton, factor: "12" });
    supplier = (await createParty(as.owner, "supplier", { name: "Lahore Parts", supplierType: "aop" })).id;
    otherSupplier = (await createParty(as.owner, "supplier", { name: "Sialkot Rubber", supplierType: "aop" })).id;
  }, 240_000);

  afterAll(async () => {
    await deleteTenants(admin, [tenantA, tenantB]);
    await admin.end();
    await closeDb();
  }, 120_000);

  it("writes an order as a draft and submits it with a number; nothing reaches the books or the stock", async () => {
    // Orders carry cost: not for the warehouse, the sales team, or anyone who only reads.
    for (const role of ["warehouse_manager", "auditor", "salesperson", "sales_manager", "recovery_officer"] as const) {
      await expect(saveOrderDraft(as[role], null, { ...head(), lines: [line(helmet, "10", "600")] }), role).rejects.toThrow("Only an owner or an accountant can write purchase orders.");
    }
    await expect(saveOrderDraft(as.owner, null, { ...head(), date: "" })).rejects.toThrow("Enter the date of the order.");
    await expect(saveOrderDraft(as.owner, null, { ...head(), supplierId: "" })).rejects.toThrow("Choose the supplier.");
    await expect(saveOrderDraft(as.owner, null, { ...head(), supplierId: randomUUID() })).rejects.toThrow("Choose the supplier from the list.");
    await expect(saveOrderDraft(as.owner, null, { ...head(), warehouseId: randomUUID() })).rejects.toThrow("Choose the warehouse from your own warehouses.");
    await expect(saveOrderDraft(as.owner, null, { ...head(), expectedOn: "2026-11-01" })).rejects.toThrow("The goods cannot be expected before the order's date.");
    await expect(saveOrderDraft(as.owner, null, { ...head(), lines: [line(helmet, "0", "600")] })).rejects.toThrow("Line 1, quantity: The quantity must be more than zero.");
    await expect(saveOrderDraft(as.owner, null, { ...head(), lines: [line(helmet, "10", "1,200")] })).rejects.toThrow("Line 1, cost: Enter what one costs as a plain number");
    await expect(saveOrderDraft(as.owner, null, { ...head(), lines: [line(helmet, "10", "600", carton)] })).rejects.toThrow("Line 1: This item is not bought or sold in that unit.");

    const { id, updatedAt } = await saveOrderDraft(as.accountant, null, { ...head(), expectedOn: "2026-11-20", supplierReference: "LP/881", lines: [line(helmet, "10", "600"), line(chain, "5", "3000.50", carton), line(grip, "7", "33.3333")] });
    const draft = await getOrder(as.owner, id);
    expect(draft).toMatchObject({ status: "draft", number: null, supplierName: "Lahore Parts", warehouseName: "Main store", expectedOn: "2026-11-20", supplierReference: "LP/881" });
    // 10 × 600 + 5 × 3000.50 + round(7 × 33.3333, 2) = 6000 + 15002.50 + 233.33
    expect(draft!.total.toFixed(2)).toBe("21235.83");
    expect(draft!.lines.map((l) => `${l.itemCode} ${l.quantity} ${l.unitCode} = ${l.baseQuantity} at ${l.unitCost}: ${l.amount.toFixed(2)}`)).toEqual(["HL-1 10 pc = 10 at 600: 6000.00", "CH-2 5 ctn = 60 at 3000.5: 15002.50", "GR-3 7 pc = 7 at 33.3333: 233.33"]);

    // A draft is changed freely: its lines are replaced.
    const again = await saveOrderDraft(as.owner, id, { ...head(), lines: [line(helmet, "10", "600"), line(chain, "5", "3000", carton)] }, updatedAt);
    await expect(saveOrderDraft(as.owner, id, { ...head(), lines: [] }, updatedAt)).rejects.toThrow("Someone changed this order after you opened it.");
    // An empty order is not submitted; nor one whose supplier has been archived since.
    const empty = await saveOrderDraft(as.owner, null, { ...head(), lines: [] });
    await expect(submitOrder(as.owner, empty.id)).rejects.toThrow("Add at least one item to the order before submitting it.");
    await discardOrder(as.owner, empty.id);
    expect(await getOrder(as.owner, empty.id)).toBeNull();
    await setPartyArchived(as.owner, "supplier", supplier, true);
    await expect(submitOrder(as.owner, id, again.updatedAt)).rejects.toThrow("The supplier is archived.");
    await setPartyArchived(as.owner, "supplier", supplier, false);

    await expect(submitOrder(as.warehouse_manager, id)).rejects.toThrow("Only an owner or an accountant can write purchase orders.");
    expect(await submitOrder(as.owner, id, again.updatedAt)).toEqual({ number: "PO-2627-00001" });
    const submitted = await getOrder(as.auditor, id);
    expect(submitted).toMatchObject({ status: "submitted", number: "PO-2627-00001" });
    expect(submitted!.total.toFixed(2)).toBe("21000.00");
    expect(submitted!.toReceive.map((l) => `${l.itemCode}: ${l.ordered} ordered, ${l.received} received`)).toEqual(["HL-1: 10 ordered, 0 received", "CH-2: 5 ordered, 0 received"]);
    // A promise, not a purchase: no journal, no stock.
    const [{ journals }] = await admin`select count(*)::int as journals from public.journals where tenant_id = ${tenantA}`;
    expect(journals).toBe(0);
    expect(await stock("HL-1")).toBe("none");
    // A submitted order is not changed, thrown away or submitted twice.
    await expect(saveOrderDraft(as.owner, id, { ...head(), lines: [line(helmet, "1", "1")] })).rejects.toThrow("This order is submitted and cannot be changed.");
    await expect(discardOrder(as.owner, id)).rejects.toThrow("This order is submitted and cannot be removed.");
    await expect(submitOrder(as.owner, id)).rejects.toThrow("This order is already submitted.");
    const audited = await admin<{ action: string }[]>`select action from public.audit_log where tenant_id = ${tenantA} and entity = 'purchase_order' and entity_id = ${id} order by at, id`;
    expect(audited.map((row) => row.action)).toEqual(["purchase_order.create", "purchase_order.update", "purchase_order.submit"]);
    expect((await listOrders(as.accountant)).rows.map((row) => `${row.number} ${row.status} ${row.total.toFixed(2)}`)).toEqual(["PO-2627-00001 submitted 21000.00"]);
  });

  it("receives part of an order: the goods come in at the order's cost, against goods received not invoiced", async () => {
    const [first] = (await listOrders(as.owner)).rows;
    const placed = await getOrder(as.owner, first.id);
    const [helmets, chains] = placed!.lines.map((l) => l.id);

    // The warehouse sees what is on order and what is left of it, and never an order or its cost.
    expect((await listOrdersToReceive(as.warehouse_manager)).map((o) => `${o.number} from ${o.supplierName} into ${o.warehouseName}: ${o.linesLeft} lines`)).toEqual(["PO-2627-00001 from Lahore Parts into Main store: 2 lines"]);
    await expect(getOrder(as.warehouse_manager, first.id)).rejects.toThrow("Your role does not include purchase orders.");
    await expect(getGrni(as.warehouse_manager)).rejects.toThrow("Your role does not include purchase orders.");
    expect(await rowsOf(as.warehouse_manager, sql`select 1 from public.purchase_orders`)).toBe(0);
    expect(await rowsOf(as.warehouse_manager, sql`select 1 from public.purchase_order_lines`)).toBe(0);
    const open = await getOrderToReceive(as.warehouse_manager, first.id);
    expect(open!.toReceive.map((l) => Object.keys(l).sort().join())).toEqual(Array(2).fill("description,itemCode,itemId,lineId,lineNo,ordered,received,unitCode,unitFactor"));
    // Nobody else receives goods.
    for (const role of ["auditor", "salesperson", "sales_manager", "recovery_officer"] as const) {
      await expect(saveReceiptDraft(as[role], null, first.id, { date: ARRIVED, lines: [{ orderLineId: helmets, quantity: "1" }] }), role).rejects.toThrow("Only an owner, an accountant or the warehouse can receive goods.");
    }
    // Not before the order, not on a day that has not come, not more than was ordered, not another order's line.
    await expect(saveReceiptDraft(as.warehouse_manager, null, first.id, { date: "2026-11-09", lines: [] })).rejects.toThrow("The order is dated 10-11-2026. Goods cannot arrive before they were ordered.");
    await expect(saveReceiptDraft(as.warehouse_manager, null, first.id, { date: "2027-01-05", lines: [] })).rejects.toThrow("Goods cannot be received on a day that has not come yet.");
    await expect(saveReceiptDraft(as.warehouse_manager, null, first.id, { date: ARRIVED, lines: [{ orderLineId: helmets, quantity: "11" }] })).rejects.toThrow("HL-1: 10 was ordered, so 11 cannot be received.");
    await expect(saveReceiptDraft(as.warehouse_manager, null, first.id, { date: ARRIVED, lines: [{ orderLineId: randomUUID(), quantity: "1" }] })).rejects.toThrow("A line on the goods received note is not a line of its order.");
    await expect(saveReceiptDraft(as.warehouse_manager, null, randomUUID(), { date: ARRIVED, lines: [] })).rejects.toThrow("That order is not open for receiving goods.");

    const { id, updatedAt } = await saveReceiptDraft(as.warehouse_manager, null, first.id, { date: ARRIVED, supplierDeliveryNote: "DC-4471", lines: [{ orderLineId: helmets, quantity: "4" }, { orderLineId: chains, quantity: "2" }] });
    // One draft for an order at a time.
    await expect(saveReceiptDraft(as.accountant, null, first.id, { date: ARRIVED, lines: [] })).rejects.toThrow("A goods received note for this order is already waiting as a draft.");
    expect((await getOrderToReceive(as.owner, first.id))!.draftId).toBe(id);
    expect(await stock("HL-1")).toBe("none");
    await expect(postReceipt(as.warehouse_manager, id, new Date(updatedAt.getTime() - 1000))).rejects.toThrow("Someone changed this goods received note after you opened it.");
    expect(await postReceipt(as.warehouse_manager, id, updatedAt)).toEqual({ number: "GR-2627-00001" });

    // 4 helmets at 600; 2 cartons of 12 chains at 3,000 a carton.
    expect(await stock("HL-1")).toBe("4 worth 2400.00");
    expect(await stock("CH-2")).toBe("24 worth 6000.00");
    expect(await journalLines(id)).toEqual(["1300 Stock in trade: 8400 / 0", "2120 Goods received not invoiced: 0 / 8400"]);
    const posted = await getReceipt(as.warehouse_manager, id);
    expect(posted).toMatchObject({ status: "posted", number: "GR-2627-00001", supplierName: "Lahore Parts", warehouseName: "Main store", supplierDeliveryNote: "DC-4471", order: { number: "PO-2627-00001" } });
    expect(posted!.toReceive.map((l) => `${l.itemCode}: ${l.received} of ${l.ordered}`)).toEqual(["HL-1: 4 of 10", "CH-2: 2 of 5"]);
    // Posted goods received are not changed, thrown away or posted twice.
    await expect(saveReceiptDraft(as.owner, id, null, { date: ARRIVED, lines: [] })).rejects.toThrow("These goods received are posted and cannot be changed.");
    await expect(discardReceipt(as.owner, id)).rejects.toThrow("These goods received are posted and cannot be removed.");
    await expect(postReceipt(as.owner, id)).rejects.toThrow("These goods received are already posted.");

    // The plan's test: goods received without a bill show in the GRNI report at cost.
    const grni = await getGrni(as.accountant);
    expect(grni.rows.map((row) => `${row.receiptNumber} ${row.orderNumber} ${row.supplierName} ${row.itemCode} ${row.quantity} ${row.unitCode}: ${row.value.toFixed(2)}`)).toEqual([
      "GR-2627-00001 PO-2627-00001 Lahore Parts HL-1 4 pc: 2400.00",
      "GR-2627-00001 PO-2627-00001 Lahore Parts CH-2 2 ctn: 6000.00",
    ]);
    expect(grni.total.toFixed(2)).toBe("8400.00");
    expect(grni.ledger.toFixed(2)).toBe("8400.00");
    expect(await booksAgree()).toEqual({ stockLedger: "8400.00", balances: "8400.00", moves: "8400.00", grniLedger: "8400.00", received: "8400.00" });
  });

  it("receives the rest, and never more than is left of the order", async () => {
    const [first] = (await listOrders(as.owner)).rows;
    const placed = await getOrder(as.owner, first.id);
    const [helmets, chains] = placed!.lines.map((l) => l.id);
    await expect(saveReceiptDraft(as.owner, null, first.id, { date: ARRIVED, lines: [{ orderLineId: helmets, quantity: "7" }] })).rejects.toThrow("HL-1: 10 was ordered and 4 has arrived, so only 6 more can be received.");

    // Written past the app: a line for more than is left, though no more than was ordered, waits
    // as a draft, and the database refuses to post it.
    const { id } = await saveReceiptDraft(as.warehouse_manager, null, first.id, { date: ARRIVED, lines: [{ orderLineId: chains, quantity: "3" }] });
    expect(
      await codeOf(
        as.warehouse_manager,
        sql`insert into public.goods_receipt_lines (tenant_id, receipt_id, line_no, order_line_id, item_id, unit_factor, quantity, base_quantity, created_by)
            values (${tenantA}, ${id}, 2, ${helmets}, ${helmet}, 1, 7, 7, ${userIds.warehouse_manager})`,
      ),
    ).toBeUndefined();
    await expect(postReceipt(as.warehouse_manager, id)).rejects.toThrow("More has been entered than is left of the order.");
    expect(await stock("CH-2")).toBe("24 worth 6000.00");
    // More than was ever ordered is refused as the line is written.
    expect(
      await codeOf(
        as.warehouse_manager,
        sql`insert into public.goods_receipt_lines (tenant_id, receipt_id, line_no, order_line_id, item_id, unit_factor, quantity, base_quantity, created_by)
            values (${tenantA}, ${id}, 3, ${chains}, ${chain}, 12, 6, 72, ${userIds.warehouse_manager})`,
      ),
    ).toBe("SE214");

    const fixed = await saveReceiptDraft(as.warehouse_manager, id, null, { date: "2026-11-13", lines: [{ orderLineId: chains, quantity: "3" }, { orderLineId: helmets, quantity: "6" }] });
    expect(await postReceipt(as.accountant, id, fixed.updatedAt)).toEqual({ number: "GR-2627-00002" });
    expect(await stock("HL-1")).toBe("10 worth 6000.00");
    expect(await stock("CH-2")).toBe("60 worth 15000.00");
    expect(await journalLines(id)).toEqual(["1300 Stock in trade: 12600 / 0", "2120 Goods received not invoiced: 0 / 12600"]);
    // All of it has arrived: nothing is left to receive, and there is nothing to start a note for.
    expect(await listOrdersToReceive(as.warehouse_manager)).toEqual([]);
    await expect(saveReceiptDraft(as.warehouse_manager, null, first.id, { date: ARRIVED, lines: [{ orderLineId: helmets, quantity: "1" }] })).rejects.toThrow("HL-1: 10 was ordered and 10 has arrived, so only 0 more can be received.");
    // An order with goods received is not cancelled.
    await expect(cancelOrder(as.owner, first.id, "Ordered twice")).rejects.toThrow("Goods have been received against this order");
    expect((await listReceipts(as.auditor)).rows.map((row) => `${row.number} ${row.status} ${row.date}`)).toEqual(["GR-2627-00002 posted 2026-11-13", "GR-2627-00001 posted 2026-11-12"]);
    expect((await getGrni(as.owner)).total.toFixed(2)).toBe("21000.00");
    expect(await booksAgree()).toEqual({ stockLedger: "21000.00", balances: "21000.00", moves: "21000.00", grniLedger: "21000.00", received: "21000.00" });
  });

  it("values each line to the paisa, and averages what comes in with what is held", async () => {
    // 7 grips at 33.3333 come to 233.33; 3 of them come in at round(3 × 33.3333, 2) = 100.00, the other 4 at 133.33.
    const placed = await order([line(grip, "7", "33.3333"), line(helmet, "5", "700")]);
    const [grips, helmets] = placed.lineIds;
    const one = await receive(placed.id, [{ orderLineId: grips, quantity: "3" }]);
    expect(await stock("GR-3")).toBe("3 worth 100.00");
    expect(await journalLines(one.id)).toEqual(["1300 Stock in trade: 100 / 0", "2120 Goods received not invoiced: 0 / 100"]);
    const two = await receive(placed.id, [{ orderLineId: grips, quantity: "4" }, { orderLineId: helmets, quantity: "5" }]);
    expect(await stock("GR-3")).toBe("7 worth 233.33");
    // 10 helmets held at 600 and 5 more at 700: 15 worth 9,500.
    expect(await stock("HL-1")).toBe("15 worth 9500.00");
    expect(await journalLines(two.id)).toEqual(["1300 Stock in trade: 3633.33 / 0", "2120 Goods received not invoiced: 0 / 3633.33"]);
    const books = await booksAgree();
    expect(books).toEqual({ stockLedger: "24733.33", balances: "24733.33", moves: "24733.33", grniLedger: "24733.33", received: "24733.33" });
    expect((await getGrni(as.auditor)).ledger.toFixed(2)).toBe("24733.33");
  });

  it("cancels an order nothing has arrived against, with a reason", async () => {
    const placed = await order([line(helmet, "2", "650")]);
    await expect(cancelOrder(as.warehouse_manager, placed.id, "Not needed")).rejects.toThrow("Only an owner or an accountant can write purchase orders.");
    await expect(cancelOrder(as.owner, placed.id, " ")).rejects.toThrow("Say why the order is cancelled, in a few words.");
    // A draft of goods received holds the order open.
    const waiting = await saveReceiptDraft(as.warehouse_manager, null, placed.id, { date: ARRIVED, lines: [{ orderLineId: placed.lineIds[0], quantity: "2" }] });
    await expect(cancelOrder(as.owner, placed.id, "Supplier out of stock")).rejects.toThrow("a goods received note is waiting as a draft");
    expect(await discardReceipt(as.warehouse_manager, waiting.id)).toEqual({ orderId: placed.id });
    await cancelOrder(as.accountant, placed.id, "Supplier out of stock");
    expect(await getOrder(as.owner, placed.id)).toMatchObject({ status: "cancelled", number: placed.number, cancelReason: "Supplier out of stock" });
    await expect(cancelOrder(as.owner, placed.id, "Again")).rejects.toThrow("This order is already cancelled.");
    // Nothing is received against a cancelled order, by the app or past it.
    expect(await getOrderToReceive(as.warehouse_manager, placed.id)).toBeNull();
    await expect(saveReceiptDraft(as.warehouse_manager, null, placed.id, { date: ARRIVED, lines: [] })).rejects.toThrow("That order is not open for receiving goods.");
    expect(
      await codeOf(as.warehouse_manager, sql`insert into public.goods_receipts (tenant_id, receipt_date, order_id, supplier_id, warehouse_id, created_by, updated_by) values (${tenantA}, ${ARRIVED}, ${placed.id}, ${supplier}, ${mainWarehouse}, ${userIds.warehouse_manager}, ${userIds.warehouse_manager})`),
    ).toBe("SE217");
    const audited = await admin<{ action: string; after: { reason?: string } }[]>`select action, after from public.audit_log where tenant_id = ${tenantA} and entity_id = ${placed.id} and action = 'purchase_order.cancel'`;
    expect(audited.map((row) => row.after.reason)).toEqual(["Supplier out of stock"]);
  });

  it("refuses goods received in a period that is not open, and keeps to the member's branches", async () => {
    // An order takes its number from the fiscal year of its date: none is open for June 2026.
    const tooEarly = await saveOrderDraft(as.owner, null, { ...head(), date: "2026-06-20", lines: [line(helmet, "1", "600")] });
    await expect(submitOrder(as.owner, tooEarly.id)).rejects.toThrow("No fiscal period is open for 20-06-2026.");
    await discardOrder(as.owner, tooEarly.id);
    // Goods do not arrive in a month the owner has locked.
    const early = await order([line(helmet, "1", "600")], mainWarehouse, "2026-10-05");
    const [october] = await admin<{ id: string }[]>`select id from public.fiscal_periods where tenant_id = ${tenantA} and starts_on = '2026-10-01'`;
    await setPeriodLocked(as.owner, october.id, true);
    await expect(receive(early.id, [{ orderLineId: early.lineIds[0], quantity: "1" }], as.owner, "2026-10-08")).rejects.toThrow("is locked");
    await setPeriodLocked(as.owner, october.id, false);
    expect(await stock("HL-1")).toBe("15 worth 9500.00");
    const [left] = await admin<{ id: string }[]>`select id from public.goods_receipts where tenant_id = ${tenantA} and order_id = ${early.id} and status = 'draft'`;
    await discardReceipt(as.owner, left.id);

    // A keeper of the north branch sees and receives the north's orders only.
    const north = await order([line(helmet, "3", "610")], northWarehouse);
    expect((await listOrdersToReceive(keeper)).map((o) => o.number)).toEqual([north.number]);
    expect(await getOrderToReceive(keeper, early.id)).toBeNull();
    await expect(saveReceiptDraft(keeper, null, early.id, { date: ARRIVED, lines: [] })).rejects.toThrow("That order is not open for receiving goods.");
    const mine = await receive(north.id, [{ orderLineId: north.lineIds[0], quantity: "3" }], keeper);
    expect(await stock("HL-1", northWarehouse)).toBe("3 worth 1830.00");
    // The journal is the north branch's.
    const [{ branch }] = await admin`select b.name as branch from public.journals j join public.journal_lines l on l.journal_id = j.id join public.branches b on b.id = l.branch_id where j.source_id = ${mine.id} limit 1`;
    expect(branch).toBe("North");
    // The main warehouse's draft is not the north keeper's to read or post.
    const main = await saveReceiptDraft(as.warehouse_manager, null, early.id, { date: ARRIVED, lines: [{ orderLineId: early.lineIds[0], quantity: "1" }] });
    expect(await getReceipt(keeper, main.id)).toBeNull();
    await expect(postReceipt(keeper, main.id)).rejects.toThrow("That goods received note is not in this company.");
    expect(await codeOf(keeper, sql`select app.post_goods_receipt(${main.id}::uuid)`)).toBe("SE211");
    expect(await rowsOf(keeper, sql`select 1 from app.order_lines_to_receive(${early.id}::uuid)`)).toBe(0);
    await discardReceipt(as.warehouse_manager, main.id);
  });

  it("lets the app's role write nothing that only the functions may write", async () => {
    const placed = await order([line(helmet, "4", "600"), line(grip, "10", "30")]);
    const other = await order([line(chain, "1", "3000", carton)]);
    const draft = await saveReceiptDraft(as.warehouse_manager, null, placed.id, { date: ARRIVED, lines: [{ orderLineId: placed.lineIds[0], quantity: "1" }] });
    const me = userIds.owner;

    // An order's status, number and who submitted it; a note's status, number and journal.
    expect(await codeOf(as.owner, sql`update public.purchase_orders set status = 'cancelled' where id = ${placed.id}`)).toBe("42501");
    expect(await codeOf(as.owner, sql`update public.purchase_orders set number = 'PO-2627-99999' where id = ${placed.id}`)).toBe("42501");
    expect(await codeOf(as.owner, sql`update public.goods_receipts set status = 'posted' where id = ${draft.id}`)).toBe("42501");
    expect(await codeOf(as.owner, sql`update public.goods_receipts set journal_id = null where id = ${draft.id}`)).toBe("42501");
    expect(await codeOf(as.owner, sql`update public.goods_receipts set order_id = ${other.id} where id = ${draft.id}`)).toBe("42501");
    // A document never starts further on than a draft.
    expect(await codeOf(as.owner, sql`insert into public.purchase_orders (tenant_id, status, number, order_date, supplier_id, warehouse_id, submitted_at, submitted_by, created_by, updated_by) values (${tenantA}, 'submitted', 'PO-2627-88888', ${ORDERED}, ${supplier}, ${mainWarehouse}, now(), ${me}, ${me}, ${me})`)).toBe("SE212");
    // A submitted order's total and lines stay as they are.
    expect(await rowsOf(as.owner, sql`update public.purchase_orders set total = 1, updated_by = ${me} where id = ${placed.id} returning 1`)).toBe(0);
    expect(await codeOf(as.owner, sql`delete from public.purchase_order_lines where order_id = ${placed.id}`)).toBeUndefined();
    expect((await getOrder(as.owner, placed.id))!.lines).toHaveLength(2);
    expect(await codeOf(as.owner, sql`insert into public.purchase_order_lines (tenant_id, order_id, line_no, item_id, description, unit_id, quantity, base_quantity, unit_cost, amount, created_by) select ${tenantA}, ${placed.id}, 9, ${helmet}, 'x', i.base_unit_id, 1, 1, 1, 1, ${me} from public.items i where i.id = ${helmet}`)).toBe("SE214");
    expect(await codeOf(as.owner, sql`update public.purchase_order_lines set unit_cost = 1 where order_id = ${placed.id}`)).toBe("42501");
    // Goods received are for their own order: its supplier, its warehouse, its lines, in the unit ordered.
    const insertNote = (supplierId: string, warehouseId: string) => sql`insert into public.goods_receipts (tenant_id, receipt_date, order_id, supplier_id, warehouse_id, created_by, updated_by) values (${tenantA}, ${ARRIVED}, ${other.id}, ${supplierId}, ${warehouseId}, ${me}, ${me})`;
    expect(await codeOf(as.owner, insertNote(otherSupplier, mainWarehouse))).toBe("SE217");
    expect(await codeOf(as.owner, insertNote(supplier, northWarehouse))).toBe("SE217");
    const insertLine = (orderLineId: string, itemId: string, factor: number, quantity: number) =>
      sql`insert into public.goods_receipt_lines (tenant_id, receipt_id, line_no, order_line_id, item_id, unit_factor, quantity, base_quantity, created_by) values (${tenantA}, ${draft.id}, 7, ${orderLineId}, ${itemId}, ${factor}, ${quantity}, ${factor * quantity}, ${me})`;
    expect(await codeOf(as.owner, insertLine(other.lineIds[0], chain, 12, 1)), "another order's line").toBe("SE214");
    expect(await codeOf(as.owner, insertLine(placed.lineIds[1], helmet, 1, 1)), "another item").toBe("SE214");
    expect(await codeOf(as.owner, insertLine(placed.lineIds[1], grip, 2, 1)), "another unit").toBe("SE214");
    expect(await codeOf(as.owner, sql`update public.goods_receipt_lines set quantity = 4, base_quantity = 4 where receipt_id = ${draft.id}`)).toBe("42501");
    // The audit rows of submitting, cancelling and posting are the functions' alone.
    for (const action of ["purchase_order.submit", "purchase_order.cancel", "goods_receipt.post"]) {
      expect(await codeOf(as.owner, sql`insert into public.audit_log (tenant_id, actor_user_id, actor_role, action, entity, entity_id) values (${tenantA}, ${me}, 'owner', ${action}, 'x', ${placed.id})`), action).toBeDefined();
    }
    // The functions are for those who may: not the sales team, not another company.
    expect(await codeOf(as.salesperson, sql`select * from app.orders_to_receive()`)).toBe("42501");
    expect(await rowsOf(as.salesperson, sql`select 1 from app.order_lines_to_receive(${placed.id}::uuid)`)).toBe(0);
    expect(await rowsOf(as.salesperson, sql`select 1 from app.order_to_receive(${placed.id}::uuid)`)).toBe(0);
    expect(await codeOf(as.salesperson, sql`select app.post_goods_receipt(${draft.id}::uuid)`)).toBe("42501");
    expect(await codeOf(as.warehouse_manager, sql`select app.submit_purchase_order(${placed.id}::uuid)`)).toBe("42501");
    expect(await codeOf(as.warehouse_manager, sql`select app.cancel_purchase_order(${placed.id}::uuid, 'no reason at all')`)).toBe("42501");
    expect(await codeOf(as.warehouse_manager, sql`select app.hold_purchase_order(${placed.id}::uuid)`)).toBe("42501");
    expect(await codeOf(otherOwner, sql`select app.post_goods_receipt(${draft.id}::uuid)`)).toBe("SE211");
    expect(await codeOf(otherOwner, sql`select app.cancel_purchase_order(${placed.id}::uuid, 'no reason at all')`)).toBe("SE211");
    expect(await rowsOf(otherOwner, sql`select 1 from app.order_to_receive(${placed.id}::uuid)`)).toBe(0);
    expect(await rowsOf(otherOwner, sql`select 1 from public.purchase_orders`)).toBe(0);
    expect(await rowsOf(otherOwner, sql`select 1 from public.goods_receipts`)).toBe(0);
    // The journal of goods received stands: it is not removed, changed or reversed by the app's role.
    const [posted] = await admin<{ id: string; journal_id: string }[]>`select id, journal_id from public.goods_receipts where tenant_id = ${tenantA} and status = 'posted' limit 1`;
    expect(await codeOf(as.owner, sql`delete from public.journals where id = ${posted.journal_id}`)).toBeDefined();
    expect(await codeOf(as.owner, sql`delete from public.goods_receipts where id = ${posted.id}`)).toBeUndefined();
    expect(await rowsOf(as.owner, sql`select 1 from public.goods_receipts where id = ${posted.id}`)).toBe(1);
    await discardReceipt(as.warehouse_manager, draft.id);
  });

  it("holds what the review of the migration tried", async () => {
    const me = userIds.owner;
    // An item's carton is changed while a draft that orders by the carton is waiting: the draft
    // is not submitted with a carton size the item no longer has. Saved again, it is.
    const waiting = await saveOrderDraft(as.owner, null, { ...head(), lines: [line(chain, "1", "3000", carton)] });
    await admin`update public.item_units set factor = 10 where tenant_id = ${tenantA} and item_id = ${chain} and unit_id = ${carton}`;
    await expect(submitOrder(as.owner, waiting.id)).rejects.toThrow("An item on this order is no longer bought in the unit the order names");
    expect(await codeOf(as.owner, sql`select app.submit_purchase_order(${waiting.id}::uuid)`)).toBe("SE222");
    await admin`update public.item_units set factor = 12 where tenant_id = ${tenantA} and item_id = ${chain} and unit_id = ${carton}`;
    expect((await submitOrder(as.owner, waiting.id)).number).toMatch(/^PO-2627-\d{5}$/);

    // Someone who may not receive into a warehouse is told the same thing whether the order they
    // name is there or not: nothing about the order can be learnt from the refusal.
    const note = (orderId: string, by: string) => sql`insert into public.goods_receipts (tenant_id, receipt_date, order_id, supplier_id, warehouse_id, created_by, updated_by) values (${tenantA}, ${ARRIVED}, ${orderId}, ${supplier}, ${mainWarehouse}, ${by}, ${by})`;
    for (const [who, id] of [[keeper, northKeeper], [as.salesperson, userIds.salesperson]] as const) {
      const there = await codeOf(who, note(waiting.id, id));
      expect(there, who.role).toBe("42501");
      expect(await codeOf(who, note(randomUUID(), id)), who.role).toBe(there);
    }
    await cancelOrder(as.owner, waiting.id, "Written for a test");

    // Nothing is ordered on a day that has not come, and a date is a day on the calendar.
    const tomorrow = todayIso(new Date(Date.now() + 24 * 60 * 60 * 1000));
    const early = await saveOrderDraft(as.owner, null, { ...head(), date: tomorrow, lines: [line(helmet, "1", "600")] });
    await expect(submitOrder(as.owner, early.id)).rejects.toThrow("That date has not come yet.");
    await discardOrder(as.owner, early.id);
    for (const [date, expected] of [["infinity", null], [ORDERED, "infinity"]] as const) {
      expect(await codeOf(as.owner, sql`insert into public.purchase_orders (tenant_id, order_date, expected_on, supplier_id, warehouse_id, created_by, updated_by) values (${tenantA}, ${date}, ${expected}, ${supplier}, ${mainWarehouse}, ${me}, ${me})`), `${date} ${expected}`).toBe("SE220");
    }
  });

  it("either cancels an order or starts goods received against it, never both, when the two come at the same moment", async () => {
    for (let round = 0; round < 6; round += 1) {
      const placed = await order([line(helmet, "5", "600")]);
      const results = await Promise.allSettled([
        cancelOrder(as.owner, placed.id, "Changed our mind"),
        saveReceiptDraft(as.warehouse_manager, null, placed.id, { date: ARRIVED, lines: [{ orderLineId: placed.lineIds[0], quantity: "5" }] }),
      ]);
      const [cancelled, started] = results.map((r) => r.status === "fulfilled");
      expect([cancelled, started].filter(Boolean), `round ${round}: ${results.map((r) => (r.status === "rejected" ? String(r.reason) : "ok")).join(" | ")}`).toHaveLength(1);
      const stored = await getOrder(as.owner, placed.id);
      expect(stored!.status).toBe(cancelled ? "cancelled" : "submitted");
      expect(stored!.receipts).toHaveLength(started ? 1 : 0);
      if (started) await discardReceipt(as.warehouse_manager, stored!.receipts[0].id);
    }
    const books = await booksAgree();
    expect(books.stockLedger).toBe(books.balances);
    expect(books.balances).toBe(books.moves);
    expect(books.grniLedger).toBe(books.received);
    expect((await getGrni(as.owner)).total.toFixed(2)).toBe(books.grniLedger);
  });
});

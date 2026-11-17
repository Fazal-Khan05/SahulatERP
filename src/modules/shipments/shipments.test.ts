import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, withTenant } from "@/db";
import { setBaseCurrency } from "@/modules/currencies/commands";
import { postTransfer, saveTransferDraft } from "@/modules/inventory/commands";
import { addUnit, createItem } from "@/modules/items/commands";
import { seedAccounts } from "@/modules/ledger/commands";
import { openFiscalYear, setPeriodLocked } from "@/modules/numbering/commands";
import { listFiscalPeriods } from "@/modules/numbering/queries";
import { createParty } from "@/modules/parties/commands";
import { postReceipt, saveOrderDraft, saveReceiptDraft, submitOrder } from "@/modules/purchasing/commands";
import { getOrder } from "@/modules/purchasing/queries";
import { postDelivery, saveDeliveryDraft, saveSalesDraft, startDelivery, submitSalesDocument } from "@/modules/sales/commands";
import { getSalesDocument } from "@/modules/sales/queries";
import { postBill, saveBillDraft, setWithholding } from "@/modules/supplier-bills/commands";
import type { TenantContext } from "@/modules/tenant/rules";
import { adminSql, deleteTenants, hasAdminDb, type AdminSql } from "../../../tests/support/admin-db";
import { addShipmentCharge, addShipmentReceipt, allocateShipment, cancelShipment, openShipment, removeShipmentCharge, removeShipmentReceipt, updateShipment } from "./commands";
import { getShipment, listShipments } from "./queries";
import type { ChargeBasis, ChargeClass } from "./rules";

// Shipments and landed cost against a real database, through the app's own path (app_runtime,
// withTenant, row-level security). The allocation cases of the old engine's imports tests
// (reference/tests/qa/09-imports.test.ts, IMP-017 to IMP-028 and those around them) are carried
// over here, to the paisa instead of to four decimals: what each charge puts on each line of
// the goods, what goes into stock and what to cost of goods sold, and that the books always
// agree with the stock. Skipped when the database URLs are absent.

const hasDb = hasAdminDb() && Boolean(process.env.DATABASE_URL);
const PREFIX = "zz-shipment-test";
const tenantA = randomUUID();
const tenantB = randomUUID();
const roles = ["owner", "accountant", "auditor", "sales_manager", "salesperson", "warehouse_manager", "recovery_officer"] as const;
const userIds = Object.fromEntries(roles.map((role) => [role, randomUUID()])) as Record<(typeof roles)[number], string>;
const northAccountant = randomUUID();
const ownerB = randomUUID();
const mainBranch = randomUUID();
const northBranch = randomUUID();
const mainWarehouse = randomUUID();
const cityWarehouse = randomUUID();
const northWarehouse = randomUUID();
const ctx = (userId: string, tenantId: string, role: TenantContext["role"], branchIds: string[] | null = null): TenantContext => ({ userId, email: `${role}-${userId.slice(0, 4)}@shipment.test`, tenantId, tenantName: "x", role, branchIds });
const as = Object.fromEntries(roles.map((role) => [role, ctx(userIds[role], tenantA, role)])) as Record<(typeof roles)[number], TenantContext>;
const north = ctx(northAccountant, tenantA, "accountant", [northBranch]);
const otherOwner = ctx(ownerB, tenantB, "owner");
const ORDERED = "2026-11-02";
const ARRIVED = "2026-11-03";
const BILLED = "2026-11-04";
const SOLD = "2026-11-05";
const SPREAD = "2026-11-06";
const LATE = "2026-11-10";

let admin: AdminSql;
let piece = "";
let ningbo = "";
let agent = "";
let other = "";
let dealer = "";
/** 1310 Goods in transit, 1220 Deposits and prepayments, 5310 Legal and professional fees. */
let transit = "";
let deposits = "";
let fees = "";
/** Product A weighs 2 and takes up 3; product B weighs 1 and takes up 1; product C has no weight or volume on its card. */
let a = "";
let b = "";
let c = "";
let invoiceNo = 0;
let itemNo = 0;

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
/** What a journal did to each account: debits less credits, by the account's code. */
const journalOf = async (journalId: string) =>
  Object.fromEntries(
    (
      await admin<{ code: string; net: string }[]>`
        select a.code, trim_scale(sum(l.debit - l.credit))::text as net from public.journal_lines l join public.accounts a on a.id = l.account_id
        where l.journal_id = ${journalId} group by a.code order by a.code`
    ).map((row) => [row.code, row.net]),
  );
const balance = async (control: string) =>
  (
    await admin<{ v: string }[]>`
      select coalesce(sum(l.debit - l.credit), 0)::numeric(20,2)::text as v from public.journal_lines l join public.accounts a on a.id = l.account_id
      where l.tenant_id = ${tenantA} and a.control_type = ${control}`
  )[0].v;
const stock = async (itemId: string, warehouseId = mainWarehouse) => {
  const [row] = await admin<{ q: string; v: string }[]>`select trim_scale(quantity)::text as q, trim_scale(value)::text as v from public.stock_balances where tenant_id = ${tenantA} and item_id = ${itemId} and warehouse_id = ${warehouseId}`;
  return row ? `${row.q} worth ${row.v}` : "none";
};
/** That the stock account in the books is what the stock is worth. */
const stockAgrees = async () => {
  const [{ held }] = await admin<{ held: string }[]>`select coalesce(sum(value), 0)::numeric(20,2)::text as held from public.stock_balances where tenant_id = ${tenantA}`;
  return (await balance("inventory")) === held;
};
/** A new product with nothing in stock, so that what a test sells of it is all there is. */
async function product(over: { weight?: string; volume?: string } = {}): Promise<{ id: string; code: string }> {
  const code = `P-${(itemNo += 1)}`;
  return { id: (await createItem(as.owner, { code, name: `Product ${itemNo}`, unit: piece, defaultPrice: "500", ...over })).id, code };
}
/** Goods ordered from the supplier abroad and received in full into the main store: the goods received note. */
async function arrived(lines: { itemId: string; quantity: string; unitCost: string }[], supplierId = ningbo, warehouseId = mainWarehouse): Promise<string> {
  const order = await saveOrderDraft(as.owner, null, { date: ORDERED, supplierId, warehouseId, lines });
  await submitOrder(as.owner, order.id);
  const placed = await getOrder(as.owner, order.id);
  const note = await saveReceiptDraft(as.warehouse_manager, null, order.id, { date: ARRIVED, lines: placed!.lines.map((line) => ({ orderLineId: line.id, quantity: line.quantity.toFixed() })) });
  await postReceipt(as.warehouse_manager, note.id);
  return note.id;
}
/** A shipment opened by the accountant with these goods received notes on it. */
async function shipped(receiptIds: string[], over: Record<string, unknown> = {}): Promise<string> {
  const { id } = await openShipment(as.accountant, { openedOn: ARRIVED, supplierId: ningbo, branchId: mainBranch, ...over });
  for (const receiptId of receiptIds) await addShipmentReceipt(as.accountant, id, receiptId);
  return id;
}
type Charge = { label: string; amount: string; kind?: ChargeClass; basis?: ChargeBasis; accountId?: string };
/** One bill from the clearing agent with a line for each charge, each charged to Goods in transit: the lines, in order. */
async function billed(list: Charge[], over: { date?: string; provincialTaxCode?: string; supplierId?: string } = {}): Promise<{ billId: string; lineIds: string[] }> {
  const draft = await saveBillDraft(as.accountant, null, { date: over.date ?? BILLED, supplierId: over.supplierId ?? agent, branchId: mainBranch, supplierInvoiceNo: `KC-${(invoiceNo += 1)}`, provincialTaxCode: over.provincialTaxCode, expenses: list.map((charge) => ({ accountId: transit, description: charge.label, amount: charge.amount })) });
  await postBill(as.accountant, draft.id, draft.updatedAt);
  const lines = await admin<{ id: string }[]>`select id from public.supplier_bill_lines where tenant_id = ${tenantA} and bill_id = ${draft.id} order by line_no`;
  return { billId: draft.id, lineIds: lines.map((line) => line.id) };
}
/** Bills the charges and puts each on the shipment. */
async function charged(shipmentId: string, list: Charge[], over: { date?: string } = {}): Promise<string[]> {
  const { lineIds } = await billed(list, over);
  for (const [index, charge] of list.entries()) {
    const kind = charge.kind ?? "inventory";
    await addShipmentCharge(as.accountant, shipmentId, { billLineId: lineIds[index], class: kind, basis: kind === "inventory" ? (charge.basis ?? "value") : undefined, accountId: charge.accountId });
  }
  return lineIds;
}
const spread = (shipmentId: string, date = SPREAD, who: TenantContext = as.accountant) => allocateShipment(who, shipmentId, { date });
/** What the charges put on each line of the shipment's goods, by item code, in the order of the goods. */
const landed = async (shipmentId: string) => (await getShipment(as.auditor, shipmentId))!.goods.map((line) => `${line.itemCode} ${line.landed.toFixed(2)}`);
/** The last spreading of a shipment: what it did to each account. */
const lastJournal = async (shipmentId: string) => journalOf((await getShipment(as.auditor, shipmentId))!.allocations.at(-1)!.journalId);
/** Sells and delivers so many of an item out of the main store. */
async function sold(itemId: string, quantity: string): Promise<void> {
  const order = await saveSalesDraft(as.salesperson, null, { kind: "order", date: SOLD, customerId: dealer, warehouseId: mainWarehouse, lines: [{ itemId, quantity, unitId: "", unitPrice: "", discountPercent: "", description: "" }] });
  await submitSalesDocument(as.salesperson, order.id);
  const { id } = await startDelivery(as.warehouse_manager, order.id);
  const note = (await getSalesDocument(as.warehouse_manager, id))!;
  await saveDeliveryDraft(as.warehouse_manager, id, { date: SOLD, lines: note.lines.map((line) => ({ sourceLineId: line.sourceLineId, quantity: line.quantity.toFixed() })) });
  await postDelivery(as.warehouse_manager, id);
}
/** The IMP-017 set: freight by value, duty by quantity, sales tax at import, a container deposit and the agent's fee. */
const fiveCharges = (): Charge[] => [
  { label: "Freight", amount: "50000", basis: "value" },
  { label: "Customs duty", amount: "80000", basis: "quantity" },
  { label: "Sales tax at import", amount: "30000", kind: "sales_tax" },
  { label: "Container deposit", amount: "20000", kind: "deposit", accountId: deposits },
  { label: "Clearing agent fee", amount: "5000", kind: "expense", accountId: fees },
];
/** A goods received note of 7 of A and 3 of B at 1,000 each. */
const sevenAndThree = () => arrived([{ itemId: a, quantity: "7", unitCost: "1000" }, { itemId: b, quantity: "3", unitCost: "1000" }]);

describe.skipIf(!hasDb)("shipments and landed cost", { timeout: 600_000 }, () => {
  beforeAll(async () => {
    admin = adminSql();
    const stale = await admin<{ id: string }[]>`select id from public.tenants where name like ${PREFIX + "%"}`;
    await deleteTenants(admin, stale.map((r) => r.id));
    await admin`insert into public.tenants (id, name, created_by) values (${tenantA}, ${PREFIX + " A"}, ${userIds.owner}), (${tenantB}, ${PREFIX + " B"}, ${ownerB})`;
    await admin`insert into public.branches (id, tenant_id, name, created_by) values (${mainBranch}, ${tenantA}, 'Main', ${userIds.owner}), (${northBranch}, ${tenantA}, 'North', ${userIds.owner})`;
    await admin`insert into public.warehouses (id, tenant_id, branch_id, name, created_by) values (${mainWarehouse}, ${tenantA}, ${mainBranch}, 'Main store', ${userIds.owner}), (${cityWarehouse}, ${tenantA}, ${mainBranch}, 'City store', ${userIds.owner}), (${northWarehouse}, ${tenantA}, ${northBranch}, 'North store', ${userIds.owner})`;
    await admin`insert into public.memberships ${admin([
      ...roles.map((role) => ({ tenant_id: tenantA, user_id: userIds[role], email: as[role].email, role, branch_ids: null, created_by: userIds.owner })),
      { tenant_id: tenantA, user_id: northAccountant, email: north.email, role: "accountant", branch_ids: [northBranch], created_by: userIds.owner },
      { tenant_id: tenantB, user_id: ownerB, email: otherOwner.email, role: "owner", branch_ids: null, created_by: ownerB },
    ])}`;
    await admin`insert into public.company_setup (tenant_id, sales_tax_registered, strn, tax_rates_confirmed_at, accounts_template, completed_by) values (${tenantA}, true, '1234567890123', now(), 'trading', ${userIds.owner})`;
    await admin`select app.seed_tax_defaults(${tenantA}, ${userIds.owner})`;
    await setBaseCurrency(as.owner, { code: "PKR", name: "Pakistani Rupee" });
    await seedAccounts(as.owner, "trading");
    await openFiscalYear(as.owner, { month: "7", year: "2026" });
    const account = async (code: string) => (await admin<{ id: string }[]>`select id from public.accounts where tenant_id = ${tenantA} and code = ${code}`)[0].id;
    transit = await account("1310");
    deposits = await account("1220");
    fees = await account("5310");
    piece = (await addUnit(as.owner, { code: "pc", name: "Piece" })).id;
    a = (await createItem(as.owner, { code: "PA", name: "Product A", unit: piece, defaultPrice: "500", weight: "2", volume: "3" })).id;
    b = (await createItem(as.owner, { code: "PB", name: "Product B", unit: piece, defaultPrice: "500", weight: "1", volume: "1" })).id;
    c = (await createItem(as.owner, { code: "PC", name: "Product C", unit: piece, defaultPrice: "500" })).id;
    ningbo = (await createParty(as.owner, "supplier", { name: "Ningbo Exports", supplierType: "company" })).id;
    agent = (await createParty(as.owner, "supplier", { name: "Karachi Clearing", supplierType: "aop" })).id;
    other = (await createParty(as.owner, "supplier", { name: "Lahore Parts", supplierType: "aop" })).id;
    dealer = (await createParty(as.owner, "customer", { name: "Registered Dealer", code: "C-001" })).id;
  }, 240_000);

  afterAll(async () => {
    await deleteTenants(admin, [tenantA, tenantB]);
    await admin.end();
    await closeDb();
  }, 240_000);

  it("IMP-017, 024, 038, 039: closing a shipment puts each kind of charge where it belongs, and the goods are carried at their landed cost", async () => {
    const goods = await sevenAndThree();
    const id = await shipped([goods], { containerNo: "MSKU1234567", gdNumber: "KPPI-HC-12345-2026", gdDate: ARRIVED, port: "Karachi", origin: "Ningbo", lcNumber: "LC-778", customsValue: "9500", expectedOn: "2026-11-20" });
    const opened = await getShipment(as.auditor, id);
    expect(opened).toMatchObject({ number: "SH-2627-00001", status: "open", stage: "ordered", supplierName: "Ningbo Exports", containerNo: "MSKU1234567", gdNumber: "KPPI-HC-12345-2026", port: "Karachi", lcNumber: "LC-778", expectedOn: "2026-11-20" });
    expect(opened!.goods.map((line) => `${line.itemCode} ${line.quantity.toFixed()} worth ${line.value.toFixed(2)}, weighs ${line.weight.toFixed()}, takes ${line.volume.toFixed()}`)).toEqual(["PA 7 worth 7000.00, weighs 14, takes 21", "PB 3 worth 3000.00, weighs 3, takes 3"]);
    // How far it has come is the app's to change; that it is closed is not.
    await updateShipment(as.accountant, id, { stage: "at_port", containerNo: "MSKU1234567", gdNumber: "KPPI-HC-12345-2026", port: "Karachi" });
    expect((await getShipment(as.auditor, id))!.stage).toBe("at_port");

    // The charges are billed to Goods in transit; nothing else has happened in the books yet.
    await charged(id, fiveCharges());
    expect(await balance("goods_in_transit")).toBe("185000.00");
    expect(await stock(a)).toBe("7 worth 7000");
    const waiting = await getShipment(as.accountant, id);
    expect(waiting!.charges.map((charge) => `${charge.description} ${charge.amount.toFixed(2)} ${charge.class} ${charge.basis ?? charge.accountName ?? "-"}`)).toEqual([
      "Freight 50000.00 inventory value",
      "Customs duty 80000.00 inventory quantity",
      "Sales tax at import 30000.00 sales_tax -",
      "Container deposit 20000.00 deposit 1220 Deposits and prepayments",
      "Clearing agent fee 5000.00 expense 5310 Legal and professional fees",
    ]);
    // Shown before it is done: what each line would take, and where the rest would go.
    const shown = waiting!.preview;
    const preview = shown && shown.ok ? shown.preview : null;
    expect([preview!.perLine.map((share) => share.toFixed(2)), preview!.toStock.toFixed(2), preview!.toCogs.toFixed(2), preview!.salesTax.toFixed(2), preview!.deposits.toFixed(2), preview!.expenses.toFixed(2), preview!.total.toFixed(2)]).toEqual([["91000.00", "39000.00"], "130000.00", "0.00", "30000.00", "20000.00", "5000.00", "185000.00"]);
    const position = (await listShipments(as.auditor)).inTransit;
    expect([position.ledger.toFixed(2), position.onShipments.toFixed(2), position.notOnAShipment.toFixed(2)]).toEqual(["185000.00", "185000.00", "0.00"]);

    await spread(id);
    const closed = await getShipment(as.auditor, id);
    expect(closed!.status).toBe("closed");
    expect(closed!.allocations.map((run) => `${run.date} ${run.total.toFixed(2)}: ${run.toStock.toFixed(2)} to stock, ${run.toCogs.toFixed(2)} to cost of goods sold, ${run.charges} charges`)).toEqual([`${SPREAD} 185000.00: 130000.00 to stock, 0.00 to cost of goods sold, 5 charges`]);
    // One journal: stock, input tax, the deposit and the expense are debited; Goods in transit is credited with all of it.
    expect(await lastJournal(id)).toEqual({ "1220": "20000", "1300": "130000", "1310": "-185000", "1400": "30000", "5310": "5000" });
    expect(await landed(id)).toEqual(["PA 91000.00", "PB 39000.00"]);
    // IMP-017 and 024: 98,000 and 42,000 in stock, 14,000 each.
    expect([await stock(a), await stock(b)]).toEqual(["7 worth 98000", "3 worth 42000"]);
    expect(await balance("goods_in_transit")).toBe("0.00");
    expect(await stockAgrees()).toBe(true);
    // The stock was revalued with moves that have a value and no quantity.
    const moves = await admin<{ q: string; v: string }[]>`select trim_scale(quantity)::text as q, trim_scale(value)::text as v from public.stock_moves where tenant_id = ${tenantA} and source_type = 'landed_cost' order by value desc`;
    expect(moves.map((move) => `${move.q} ${move.v}`)).toEqual(["0 91000", "0 39000"]);
    const audited = await admin<{ action: string }[]>`select action from public.audit_log where tenant_id = ${tenantA} and entity = 'shipment' and entity_id = ${id} order by at, id`;
    expect(audited.map((row) => row.action)).toEqual(["shipment.open", "shipment.add_goods", "shipment.update", ...Array(5).fill("shipment.add_charge"), "shipment.allocate"]);
  });

  it("IMP-018 to 021, 079: by value, quantity, weight and volume, with the odd paisa on the last line", async () => {
    const one = async (charge: Charge, goods: string) => {
      const id = await shipped([goods]);
      await charged(id, [charge]);
      await spread(id);
      return landed(id);
    };
    // 70% and 30% of the value take 70% and 30% of the freight.
    expect(await one({ label: "Freight", amount: "50000", basis: "value" }, await sevenAndThree())).toEqual(["PA 35000.00", "PB 15000.00"]);
    expect(await one({ label: "Duty", amount: "1000", basis: "quantity" }, await sevenAndThree())).toEqual(["PA 700.00", "PB 300.00"]);
    // By weight: 7 x 2 against 3 x 1. By volume: 7 x 3 against 3 x 1.
    expect(await one({ label: "Freight", amount: "1700", basis: "weight" }, await sevenAndThree())).toEqual(["PA 1400.00", "PB 300.00"]);
    expect(await one({ label: "Freight", amount: "2400", basis: "volume" }, await sevenAndThree())).toEqual(["PA 2100.00", "PB 300.00"]);
    // Three equal lines: a third each, and the paisa that is left goes to the last.
    const [x, y, z] = [await product(), await product(), await product()];
    const three = () => arrived([x, y, z].map((item) => ({ itemId: item.id, quantity: "1", unitCost: "10" })));
    expect(await one({ label: "Freight", amount: "100", basis: "value" }, await three())).toEqual([`${x.code} 33.33`, `${y.code} 33.33`, `${z.code} 33.34`]);
    expect(await one({ label: "Freight", amount: "1000", basis: "quantity" }, await three())).toEqual([`${x.code} 333.33`, `${y.code} 333.33`, `${z.code} 333.34`]);
    // IMP-042: a charge of one paisa lands whole on one line.
    expect(await one({ label: "Tiny", amount: "0.01", basis: "value" }, await sevenAndThree())).toEqual(["PA 0.01", "PB 0.00"]);
    // IMP-080: half a unit each.
    expect(await one({ label: "Freight", amount: "30", basis: "weight" }, await arrived([{ itemId: a, quantity: "0.5", unitCost: "200" }, { itemId: b, quantity: "0.5", unitCost: "100" }]))).toEqual(["PA 20.00", "PB 10.00"]);
    expect(await stockAgrees()).toBe(true);
  });

  it("IMP-022, 023: a product with no weight takes none of a charge spread by weight; with no weight at all it is refused", async () => {
    const id = await shipped([await arrived([{ itemId: a, quantity: "5", unitCost: "100" }, { itemId: c, quantity: "5", unitCost: "100" }])]);
    await charged(id, [{ label: "Freight", amount: "900", basis: "weight" }]);
    await spread(id);
    expect(await landed(id)).toEqual(["PA 900.00", "PC 0.00"]);
    expect(await stock(c)).toBe("5 worth 500");
    const none = await shipped([await arrived([{ itemId: c, quantity: "5", unitCost: "100" }])]);
    const [line] = await charged(none, [{ label: "Freight", amount: "900", basis: "weight" }]);
    await expect(spread(none)).rejects.toThrow("None of the goods has a weight to spread the charge by. Enter the weight on the items' cards, or spread it another way.");
    expect(await codeOf(as.accountant, sql`select app.allocate_shipment(${none}::uuid, ${SPREAD}::date)`)).toBe("SE262");
    // Nothing happened: the charge is still waiting, and can be taken off and put on again another way.
    const waiting = (await getShipment(as.accountant, none))!;
    expect(waiting.status).toBe("open");
    await removeShipmentCharge(as.accountant, none, waiting.charges[0].id);
    await addShipmentCharge(as.accountant, none, { billLineId: line, class: "inventory", basis: "quantity" });
    await spread(none);
    expect(await landed(none)).toEqual(["PC 900.00"]);
  });

  it("the plan's test, IMP-025 to 028: charges on goods partly sold go to the stock still held and to the cost of the units sold; a late freight bill does the same", async () => {
    // Ten at 100 arrive; four are sold and delivered at their cost of 100 each.
    const item = await product();
    const id = await shipped([await arrived([{ itemId: item.id, quantity: "10", unitCost: "100" }])]);
    await sold(item.id, "4");
    expect(await stock(item.id)).toBe("6 worth 600");
    const cogsBefore = Number(await balance("cogs"));
    // Duty of 1,000 by quantity: 600 belongs to the six still held, 400 to the four that went.
    await charged(id, [{ label: "Duty", amount: "1000", basis: "quantity" }]);
    await spread(id);
    expect(await lastJournal(id)).toEqual({ "1300": "600", "1310": "-1000", "5100": "400" });
    expect(await stock(item.id)).toBe("6 worth 1200");
    expect(Number(await balance("cogs")) - cogsBefore).toBe(400);
    expect((await getShipment(as.auditor, id))!.status).toBe("closed");
    // IMP-027: there is nothing left to spread.
    await expect(spread(id)).rejects.toThrow("Every charge on this shipment has already been spread.");
    expect(await codeOf(as.accountant, sql`select app.allocate_shipment(${id}::uuid, ${SPREAD}::date)`)).toBe("SE260");

    // The plan's words: a late freight bill adjusts remaining stock and the cost of sold units.
    // The shipment is closed; the bill comes on the 10th. Only the new charge is spread.
    await charged(id, [{ label: "Late freight", amount: "500", basis: "quantity" }], { date: LATE });
    await expect(spread(id, SPREAD)).rejects.toThrow("A charge on this shipment was billed on 10-11-2026. The charges cannot be spread before that day.");
    await spread(id, LATE);
    const late = await getShipment(as.auditor, id);
    expect(late!.allocations.map((run) => `${run.date} ${run.total.toFixed(2)}: ${run.toStock.toFixed(2)} to stock, ${run.toCogs.toFixed(2)} to cost of goods sold`)).toEqual([
      `${SPREAD} 1000.00: 600.00 to stock, 400.00 to cost of goods sold`,
      `${LATE} 500.00: 300.00 to stock, 200.00 to cost of goods sold`,
    ]);
    expect(await lastJournal(id)).toEqual({ "1300": "300", "1310": "-500", "5100": "200" });
    expect(await stock(item.id)).toBe("6 worth 1500");
    expect(Number(await balance("cogs")) - cogsBefore).toBe(600);
    expect(late!.status).toBe("closed");
    expect(await landed(id)).toEqual([`${item.code} 1500.00`]);
    // IMP-072: what is sold next goes at the landed cost: 250 each.
    await sold(item.id, "2");
    expect(await stock(item.id)).toBe("4 worth 1000");
    expect(Number(await balance("cogs")) - cogsBefore).toBe(1100);

    // IMP-026: everything sold before the charge comes: all of it is the cost of what was sold.
    const gone = await product();
    const sent = await shipped([await arrived([{ itemId: gone.id, quantity: "10", unitCost: "100" }])]);
    await sold(gone.id, "10");
    await charged(sent, [{ label: "Duty", amount: "1000", basis: "quantity" }]);
    await spread(sent);
    expect(await lastJournal(sent)).toEqual({ "1310": "-1000", "5100": "1000" });
    expect(await stock(gone.id)).toBe("0 worth 0");
    expect(await balance("goods_in_transit")).toBe("0.00");
    expect(await stockAgrees()).toBe(true);
  });

  it("IMP-058: goods moved to another store still take their share, where they are", async () => {
    const item = await product();
    const id = await shipped([await arrived([{ itemId: item.id, quantity: "10", unitCost: "100" }])]);
    const move = await saveTransferDraft(as.warehouse_manager, null, { date: SOLD, fromWarehouseId: mainWarehouse, toWarehouseId: cityWarehouse, lines: [{ itemCode: item.code, quantity: "4" }] });
    await postTransfer(as.warehouse_manager, move.id);
    await charged(id, [{ label: "Duty", amount: "1000", basis: "quantity" }]);
    await spread(id);
    // All ten are still held: six in the store they came into, four in the other. Nothing goes to cost of goods sold.
    expect(await lastJournal(id)).toEqual({ "1300": "1000", "1310": "-1000" });
    expect([await stock(item.id), await stock(item.id, cityWarehouse)]).toEqual(["6 worth 1200", "4 worth 800"]);
    expect(await stockAgrees()).toBe(true);
  });

  it("a charge is what its bill charged to Goods in transit, with the province's tax on it", async () => {
    await setWithholding(as.owner, true);
    // The agent bills 2,000 and 1,000 with Sindh's 15% on services: 450, shared 300 and 150.
    const { billId, lineIds } = await billed([{ label: "Terminal handling", amount: "2000" }, { label: "Agency fee", amount: "1000" }], { provincialTaxCode: "provincial_sales_tax.sindh" });
    const [{ journal_id: journalId }] = await admin<{ journal_id: string }[]>`select journal_id from public.supplier_bills where id = ${billId}`;
    expect((await journalOf(journalId))["1310"]).toBe("3450");
    const id = await shipped([await sevenAndThree()]);
    const page = await getShipment(as.accountant, id);
    expect(page!.billLinesToAdd.filter((line) => lineIds.includes(line.billLineId)).map((line) => `${line.label} ${line.amount.toFixed(2)}`)).toEqual([expect.stringMatching(/Karachi Clearing: Terminal handling 2300\.00$/), expect.stringMatching(/Karachi Clearing: Agency fee 1150\.00$/)]);
    await addShipmentCharge(as.accountant, id, { billLineId: lineIds[0], class: "inventory", basis: "quantity" });
    await addShipmentCharge(as.accountant, id, { billLineId: lineIds[1], class: "expense", accountId: fees });
    await spread(id);
    expect(await lastJournal(id)).toEqual({ "1300": "2300", "1310": "-3450", "5310": "1150" });
    expect(await balance("goods_in_transit")).toBe("0.00");
    await setWithholding(as.owner, false);
  });

  it("IMP-029, 030, 032, 074, 076: who may do what, on which day, and what a shipment needs before its charges are spread", async () => {
    const goods = await sevenAndThree();
    // Opening one.
    await expect(openShipment(as.warehouse_manager, { openedOn: ARRIVED, supplierId: ningbo, branchId: mainBranch })).rejects.toThrow("Only an owner or an accountant can work on shipments.");
    await expect(openShipment(as.accountant, { openedOn: "2099-01-01", supplierId: ningbo, branchId: mainBranch })).rejects.toThrow("A shipment cannot be opened on a day that has not come yet.");
    await expect(openShipment(as.accountant, { openedOn: ARRIVED, supplierId: "", branchId: mainBranch })).rejects.toThrow("Choose the supplier.");
    await expect(openShipment(north, { openedOn: ARRIVED, supplierId: ningbo, branchId: mainBranch })).rejects.toThrow("Choose the branch from your own branches.");
    await expect(openShipment(as.accountant, { openedOn: ARRIVED, supplierId: ningbo, branchId: mainBranch, gdNumber: "G".repeat(101) })).rejects.toThrow("Goods declaration (GD) number: use at most 100 characters.");
    const { id, number } = await openShipment(as.accountant, { openedOn: ARRIVED, supplierId: ningbo, branchId: mainBranch });
    expect(number).toMatch(/^SH-2627-\d{5}$/);
    // IMP-076: nothing to spread, then nothing to spread it over.
    await expect(spread(id)).rejects.toThrow("Every charge on this shipment has already been spread.");
    const [line] = await charged(id, [{ label: "Freight", amount: "100" }]);
    await expect(spread(id)).rejects.toThrow("Put the goods on the shipment first: the goods received notes it brought.");
    expect(await codeOf(as.accountant, sql`select app.allocate_shipment(${id}::uuid, ${SPREAD}::date)`)).toBe("SE261");
    // Goods: only this supplier's, into this branch, each on one shipment.
    const theirs = await arrived([{ itemId: a, quantity: "1", unitCost: "10" }], other);
    await expect(addShipmentReceipt(as.accountant, id, theirs)).rejects.toThrow("Choose a goods received note from the list");
    await addShipmentReceipt(as.accountant, id, goods);
    const second = await openShipment(as.accountant, { openedOn: ARRIVED, supplierId: ningbo, branchId: mainBranch });
    await expect(addShipmentReceipt(as.accountant, second.id, goods)).rejects.toThrow("Choose a goods received note from the list");
    // A charge: a bill line once, of the right kind.
    await expect(addShipmentCharge(as.accountant, second.id, { billLineId: line, class: "inventory", basis: "value" })).rejects.toThrow("Choose a bill line from the list");
    await expect(addShipmentCharge(as.accountant, id, { billLineId: line, class: "inventory" })).rejects.toThrow("Choose what the charge is spread over the goods by");
    await expect(addShipmentCharge(as.accountant, id, { billLineId: line, class: "deposit" })).rejects.toThrow("Choose the asset account the deposit is held in.");
    await expect(addShipmentCharge(as.accountant, id, { billLineId: line, class: "tax", basis: "value" })).rejects.toThrow("Choose what kind of charge it is.");
    // IMP-030, 074: the warehouse and the auditor do not spread charges; the auditor reads.
    await expect(spread(id, SPREAD, as.warehouse_manager)).rejects.toThrow("Only an owner or an accountant can work on shipments.");
    await expect(spread(id, SPREAD, as.auditor)).rejects.toThrow("Only an owner or an accountant can work on shipments.");
    expect((await getShipment(as.auditor, id))!.charges).toHaveLength(1);
    // The day: not before the goods arrived, not one that has not come.
    await expect(spread(id, ORDERED)).rejects.toThrow("Goods on this shipment arrived on 03-11-2026. Its charges cannot be spread before that day.");
    await expect(spread(id, "2099-01-01")).rejects.toThrow("That date has not come yet.");
    expect(await codeOf(as.accountant, sql`select app.allocate_shipment(${id}::uuid, ${ORDERED}::date)`)).toBe("SE263");
    // IMP-029: not in a locked period.
    const november = (await listFiscalPeriods(as.owner)).find((period) => period.startsOn === "2026-11-01")!;
    await setPeriodLocked(as.owner, november.id, true);
    await expect(spread(id)).rejects.toThrow(/locked/);
    await setPeriodLocked(as.owner, november.id, false);
    // A stale page does not spread what it no longer shows.
    const page = (await getShipment(as.accountant, id))!;
    await expect(allocateShipment(as.accountant, id, { date: SPREAD }, new Date(page.updatedAt.getTime() - 1000))).rejects.toThrow("Someone changed this shipment after you opened it.");
    await allocateShipment(as.accountant, id, { date: SPREAD }, page.updatedAt);
    // Closed: its goods stay; its details can still be completed; it is not cancelled.
    const closed = (await getShipment(as.accountant, id))!;
    await expect(removeShipmentReceipt(as.accountant, id, closed.receipts[0].id)).rejects.toThrow("Goods are taken off a shipment only while it is open.");
    await expect(removeShipmentCharge(as.accountant, id, closed.charges[0].id)).rejects.toThrow("That charge has been spread over the goods and stays as it is.");
    await updateShipment(as.accountant, id, { stage: "received", gdNumber: "KPPI-1" });
    await expect(cancelShipment(as.accountant, id, { reason: "Opened twice" })).rejects.toThrow("This shipment is closed");
    // An open one with nothing on it is cancelled, with a reason, and is not touched again.
    await expect(cancelShipment(as.accountant, second.id, { reason: " " })).rejects.toThrow("Say why the shipment is cancelled, in a few words.");
    await cancelShipment(as.accountant, second.id, { reason: "Opened twice" });
    expect(await getShipment(as.auditor, second.id)).toMatchObject({ status: "cancelled", cancelReason: "Opened twice" });
    await expect(updateShipment(as.accountant, second.id, { stage: "shipped" })).rejects.toThrow("This shipment was cancelled and cannot be changed.");
    await expect(addShipmentCharge(as.accountant, second.id, { billLineId: line, class: "inventory", basis: "value" })).rejects.toThrow("This shipment was cancelled.");
    expect((await listShipments(as.auditor)).rows.find((row) => row.id === second.id)).toMatchObject({ status: "cancelled" });
  });

  it("keeps a shipment's number, its closing and the spreading of its charges to the database", async () => {
    const goods = await sevenAndThree();
    const id = await shipped([goods]);
    const [line, spare] = await charged(id, [{ label: "Freight", amount: "100" }]).then(async (lines) => [...lines, ...(await billed([{ label: "Insurance", amount: "40" }])).lineIds]);
    const me = userIds.accountant;
    // The number is the database's: whatever is written is replaced by the next of the series.
    const forged = randomUUID();
    expect(await codeOf(as.accountant, sql`insert into public.shipments (id, tenant_id, number, opened_on, supplier_id, branch_id, created_by, updated_by) values (${forged}, ${tenantA}, 'SH-2627-99999', ${ARRIVED}, ${ningbo}, ${mainBranch}, ${me}, ${me})`)).toBeUndefined();
    expect((await getShipment(as.accountant, forged))!.number).not.toBe("SH-2627-99999");
    expect(await codeOf(as.accountant, sql`insert into public.shipments (tenant_id, number, status, opened_on, supplier_id, branch_id, created_by, updated_by) values (${tenantA}, 'x', 'closed', ${ARRIVED}, ${ningbo}, ${mainBranch}, ${me}, ${me})`)).toBeDefined();
    expect(await codeOf(as.accountant, sql`update public.shipments set status = 'closed' where id = ${id}`)).toBe("42501");
    expect(await codeOf(as.accountant, sql`update public.shipments set number = 'SH-2627-00001' where id = ${id}`)).toBe("42501");
    expect(await codeOf(as.accountant, sql`update public.shipments set supplier_id = ${other} where id = ${id}`)).toBe("42501");
    expect(await codeOf(as.accountant, sql`delete from public.shipments where id = ${forged}`)).toBe("42501");
    // What a charge amounts to, and that it was spread, are not the app's to say.
    expect(await codeOf(as.accountant, sql`insert into public.shipment_charges (tenant_id, shipment_id, bill_line_id, class, basis, amount, created_by) values (${tenantA}, ${id}, ${spare}, 'inventory', 'value', 1, ${me})`)).toBe("42501");
    expect(await codeOf(as.accountant, sql`update public.shipment_charges set amount = 1 where shipment_id = ${id}`)).toBe("42501");
    expect(await codeOf(as.accountant, sql`update public.shipment_charges set allocation_id = ${randomUUID()} where shipment_id = ${id}`)).toBe("42501");
    // A charge is a bill line charged to Goods in transit, of this branch, on one shipment.
    const expense = await saveBillDraft(as.accountant, null, { date: BILLED, supplierId: agent, branchId: mainBranch, supplierInvoiceNo: `KC-${(invoiceNo += 1)}`, expenses: [{ accountId: fees, description: "Advice", amount: "10" }] });
    await postBill(as.accountant, expense.id, expense.updatedAt);
    const [{ id: plainLine }] = await admin<{ id: string }[]>`select id from public.supplier_bill_lines where bill_id = ${expense.id}`;
    const charge = (billLineId: string, shipmentId = id, kind = "inventory", basis: string | null = "value", accountId: string | null = null) =>
      sql`insert into public.shipment_charges (tenant_id, shipment_id, bill_line_id, class, basis, account_id, created_by) values (${tenantA}, ${shipmentId}, ${billLineId}, ${kind}, ${basis}, ${accountId}, ${me})`;
    expect(await codeOf(as.accountant, charge(plainLine)), "not charged to Goods in transit").toBe("SE259");
    expect(await codeOf(as.accountant, charge(line, forged)), "on another shipment already").toBe("23505");
    expect(await codeOf(as.accountant, charge(spare, id, "deposit", null, fees)), "a deposit to an expense account").toBe("SE259");
    expect(await codeOf(as.accountant, charge(spare, id, "expense", null, transit)), "an expense to a locked account").toBe("SE259");
    expect(await codeOf(as.accountant, charge(spare, id, "inventory", null)), "no measure").toBe("23514");
    // Goods: posted, this supplier's, this branch's, once.
    const theirs = await arrived([{ itemId: a, quantity: "1", unitCost: "10" }], other);
    const goodsRow = (receiptId: string, shipmentId: string) => sql`insert into public.shipment_receipts (tenant_id, shipment_id, receipt_id, created_by) values (${tenantA}, ${shipmentId}, ${receiptId}, ${me})`;
    expect(await codeOf(as.accountant, goodsRow(theirs, id)), "another supplier's goods").toBe("SE258");
    expect(await codeOf(as.accountant, goodsRow(goods, forged)), "on another shipment already").toBe("23505");
    // The helpers are not the app's to call, and the spreading is not its to write.
    expect(await codeOf(as.accountant, sql`select app.revalue_stock(${tenantA}::uuid, ${me}::uuid, ${a}::uuid, ${mainWarehouse}::uuid, ${SPREAD}::date, 1000000, 'landed_cost', ${randomUUID()}::uuid, null)`)).toBe("42501");
    expect(await codeOf(as.accountant, sql`select app.bill_line_charged(${tenantA}::uuid, ${line}::uuid)`)).toBe("42501");
    expect(await codeOf(as.accountant, sql`select * from app.shipment_goods(${tenantA}::uuid, ${id}::uuid)`)).toBe("42501");
    await spread(id);
    const [run] = (await getShipment(as.accountant, id))!.allocations;
    expect(await codeOf(as.accountant, sql`insert into public.shipment_allocations (tenant_id, shipment_id, allocated_on, total, to_stock, to_cogs, journal_id, created_by) values (${tenantA}, ${id}, ${SPREAD}, 1, 1, 0, ${run.journalId}, ${me})`)).toBe("42501");
    expect(await codeOf(as.accountant, sql`update public.landed_cost_allocations set amount = 0`)).toBe("42501");
    expect(await codeOf(as.accountant, sql`delete from public.landed_cost_allocations`)).toBe("42501");
    expect(await codeOf(as.accountant, sql`delete from public.shipment_charges where shipment_id = ${id}`)).toBeUndefined();
    expect((await getShipment(as.accountant, id))!.charges).toHaveLength(1);
    expect(await codeOf(as.accountant, sql`delete from public.shipment_receipts where shipment_id = ${id}`)).toBeUndefined();
    expect((await getShipment(as.accountant, id))!.receipts).toHaveLength(1);
    expect(await codeOf(as.accountant, sql`insert into public.audit_log (tenant_id, actor_user_id, actor_role, action, entity, entity_id) values (${tenantA}, ${me}, 'accountant', 'shipment.allocate', 'x', ${id})`)).toBeDefined();
    expect(await codeOf(as.owner, sql`delete from public.journals where id = ${run.journalId}`)).toBeDefined();
    expect(await codeOf(as.owner, sql`select app.reverse_journal(${run.journalId}::uuid, ${SPREAD}::date, 'undo')`)).toBeDefined();

    // Shipments are for the owner and whoever keeps or checks the books.
    for (const role of ["sales_manager", "salesperson", "warehouse_manager", "recovery_officer"] as const) {
      await expect(listShipments(as[role]), role).rejects.toThrow("Your role does not include shipments.");
      expect(await rowsOf(as[role], sql`select 1 from public.shipments`), role).toBe(0);
      expect(await rowsOf(as[role], sql`select 1 from public.landed_cost_allocations`), role).toBe(0);
      expect(await codeOf(as[role], sql`select app.allocate_shipment(${id}::uuid, ${SPREAD}::date)`), role).toBe("42501");
      expect(await codeOf(as[role], sql`insert into public.shipments (tenant_id, number, opened_on, supplier_id, branch_id, created_by, updated_by) values (${tenantA}, 'x', ${ARRIVED}, ${ningbo}, ${mainBranch}, ${userIds[role]}, ${userIds[role]})`), role).toBe("42501");
    }
    expect(await codeOf(as.auditor, sql`select app.allocate_shipment(${id}::uuid, ${SPREAD}::date)`)).toBe("42501");
    // An accountant of the north branch does not see or touch the main branch's shipments.
    expect(await getShipment(north, id)).toBeNull();
    expect((await listShipments(north)).rows).toEqual([]);
    expect(await codeOf(north, sql`select app.allocate_shipment(${id}::uuid, ${SPREAD}::date)`)).toBe("SE255");
    expect(await codeOf(north, sql`select app.cancel_shipment(${forged}::uuid, 'not mine')`)).toBe("SE255");
    // Another company sees nothing of it.
    expect(await rowsOf(otherOwner, sql`select 1 from public.shipments`)).toBe(0);
    expect(await codeOf(otherOwner, sql`select app.allocate_shipment(${id}::uuid, ${SPREAD}::date)`)).toBe("SE255");
  });

  it("never lets a line into a bill that was removed and written again while the line waited (Step 25's guard, put right in this migration)", async () => {
    // Found by the reviewer of Step 27. One session removes a draft bill and writes it again
    // under the same id, with a line, and posts it; while that is still open, another writes a
    // line of a million into it. The second waits for the first, then finds nothing where the
    // draft was. It must be refused: the bill it would land in is posted.
    const me = userIds.accountant;
    for (let round = 0; round < 2; round += 1) {
      const id = randomUUID();
      const header = sql`insert into public.supplier_bills (id, tenant_id, bill_date, supplier_id, branch_id, supplier_invoice_no, amount, total, created_by, updated_by) values (${id}, ${tenantA}, ${BILLED}, ${agent}, ${mainBranch}, ${`SWAP-${round}`}, 1, 1, ${me}, ${me})`;
      const line = (no: number, amount: number) => sql`insert into public.supplier_bill_lines (tenant_id, bill_id, line_no, kind, account_id, description, amount, created_by) values (${tenantA}, ${id}, ${no}, 'expense', ${fees}, 'Advice', ${amount}, ${me})`;
      await withTenant(me, tenantA, (tx) => tx.execute(header));
      let posted!: () => void;
      const waiting = new Promise<void>((resolve) => (posted = resolve));
      const swap = withTenant(me, tenantA, async (tx) => {
        await tx.execute(sql`delete from public.supplier_bills where id = ${id}`);
        await tx.execute(header);
        await tx.execute(line(1, 1));
        await tx.execute(sql`select app.post_supplier_bill(${id}::uuid)`);
        posted();
        await tx.execute(sql`select pg_sleep(1)`);
      });
      await waiting;
      expect(await codeOf(as.owner, line(2, 1000000)), `round ${round}`).toBe("23503");
      await swap;
      const [bill] = await admin<{ status: string; lines: number }[]>`select b.status, (select count(*)::int from public.supplier_bill_lines l where l.bill_id = b.id) as lines from public.supplier_bills b where b.id = ${id}`;
      expect(bill, `round ${round}`).toEqual({ status: "posted", lines: 1 });
    }
  });

  it("IMP-061: spreads a shipment's charges once when it is asked twice at the same moment", async () => {
    for (let round = 0; round < 4; round += 1) {
      const id = await shipped([await sevenAndThree()]);
      await charged(id, [{ label: "Freight", amount: "100" }]);
      const results = await Promise.allSettled([spread(id, SPREAD, as.accountant), spread(id, SPREAD, as.owner)]);
      expect(results.map((result) => result.status).sort(), `round ${round}`).toEqual(["fulfilled", "rejected"]);
      expect((await getShipment(as.auditor, id))!.allocations).toHaveLength(1);
    }
    // Goods in transit holds only the insurance billed in the test before this one, which was never put on a shipment.
    const position = (await listShipments(as.auditor)).inTransit;
    expect([position.ledger.toFixed(2), position.onShipments.toFixed(2), position.notOnAShipment.toFixed(2)]).toEqual(["40.00", "0.00", "40.00"]);
    expect(await stockAgrees()).toBe(true);
  });
});

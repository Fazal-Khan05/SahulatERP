import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, withTenant } from "@/db";
import { getConnection } from "@/db/client";
import { setBaseCurrency } from "@/modules/currencies/commands";
import { stockBalances, stockMoves } from "@/modules/inventory/schema";
import { addUnit, createItem, setItemUnit } from "@/modules/items/commands";
import { seedAccounts } from "@/modules/ledger/commands";
import { openFiscalYear, setPeriodLocked } from "@/modules/numbering/commands";
import { listFiscalPeriods } from "@/modules/numbering/queries";
import { createParty } from "@/modules/parties/commands";
import type { TenantContext } from "@/modules/tenant/rules";
import { adminSql, deleteTenants, hasAdminDb, type AdminSql } from "../../../tests/support/admin-db";
import { seedStock } from "../../../tests/support/stock";
import { cancelDelivery, cancelSalesDocument, discardSalesDraft, postDelivery, saveDeliveryDraft, saveSalesDraft, startDelivery, submitSalesDocument } from "./commands";
import { getDeliveryRows, getOrderDelivery, getSalesDocument, listOrdersToDeliver, listSalesDocuments } from "./queries";
import { salesDocuments, salesLines } from "./schema";

// Delivery notes against a real database, through the app's own path (app_runtime, withTenant,
// row-level security): a part delivery, stock out at weighted-average cost, the journal, and
// what is refused. Skipped when the database URLs are absent.

const hasDb = hasAdminDb() && Boolean(process.env.DATABASE_URL);
const PREFIX = "zz-delivery-test";
const tenantA = randomUUID();
const tenantB = randomUUID();
const roles = ["owner", "accountant", "auditor", "sales_manager", "salesperson", "warehouse_manager", "recovery_officer"] as const;
const userIds = Object.fromEntries(roles.map((role) => [role, randomUUID()])) as Record<(typeof roles)[number], string>;
const seller2 = randomUUID();
const cityKeeper = randomUUID();
const ownerB = randomUUID();
const mainBranch = randomUUID();
const cityBranch = randomUUID();
const mainWarehouse = randomUUID();
const cityWarehouse = randomUUID();
const ctx = (userId: string, tenantId: string, role: TenantContext["role"], branchIds: string[] | null = null): TenantContext => ({ userId, email: `${role}-${userId.slice(0, 4)}@delivery.test`, tenantId, tenantName: "x", role, branchIds });
const as = Object.fromEntries(roles.map((role) => [role, ctx(userIds[role], tenantA, role)])) as Record<(typeof roles)[number], TenantContext>;
const second = ctx(seller2, tenantA, "salesperson");
const keeper = ctx(cityKeeper, tenantA, "warehouse_manager", [cityBranch]);
const otherOwner = ctx(ownerB, tenantB, "owner");
const D = "2026-11-10";

let admin: AdminSql;
let carton: string;
let helmet: string; // 10 in stock, 600 each
let chain: string; // 20 in stock: 12 at 250 and 8 at 300, so 270 each; also sold in cartons of 4
let grip: string; // none in stock
let dealer: string;

async function codeOf(run: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await run();
    return undefined;
  } catch (error) {
    const e = error as { code?: string; cause?: { code?: string } };
    return e.cause?.code ?? e.code ?? "unknown";
  }
}
const line = (itemId: string, quantity: string, extra: { unitId?: string; unitPrice?: string; discountPercent?: string } = {}) => ({ itemId, quantity, unitId: "", unitPrice: "", discountPercent: "", description: "", ...extra });
/** A submitted sales order by the salesperson, dated D, from the main warehouse. */
async function order(lines: ReturnType<typeof line>[], who: TenantContext = as.salesperson, warehouseId = mainWarehouse): Promise<string> {
  const { id } = await saveSalesDraft(who, null, { kind: "order", date: D, customerId: dealer, warehouseId, lines });
  await submitSalesDocument(who, id);
  return id;
}
const stock = async (itemId: string, warehouseId = mainWarehouse) => {
  const [row] = await admin`select quantity::text, value::text from public.stock_balances where item_id = ${itemId} and warehouse_id = ${warehouseId}`;
  return row ? `${Number(row.quantity)} worth ${row.value}` : "none";
};
const journalOf = (sourceId: string, sourceType = "delivery_note") => admin<{ line: string }[]>`
  select a.code || ' ' || a.name || ' ' || l.debit::text || ' ' || l.credit::text as line
  from public.journals j join public.journal_lines l on l.journal_id = j.id join public.accounts a on a.id = l.account_id
  where j.source_type = ${sourceType} and j.source_id = ${sourceId} order by l.line_no`;
const progress = async (orderId: string, who: TenantContext = as.owner) => (await getOrderDelivery(who, orderId))!.map((l) => `${l.itemCode} ${l.ordered.toFixed()} ${l.unitCode}: ${l.delivered.toFixed()} delivered, ${l.remaining.toFixed()} to go`);
/** Dates a draft note D, keeping its lines: a note starts dated today, and these tests do not depend on the clock. */
async function dated(who: TenantContext, id: string): Promise<void> {
  const note = (await getSalesDocument(who, id))!;
  await saveDeliveryDraft(who, id, { date: D, lines: note.lines.map((l) => ({ sourceLineId: l.sourceLineId, quantity: l.quantity.toFixed() })) });
}
const quantities = (rows: { sourceLineId: string }[], amounts: string[]) => rows.map((row, index) => ({ sourceLineId: row.sourceLineId, quantity: amounts[index] }));

describe.skipIf(!hasDb)("delivery notes", () => {
  beforeAll(async () => {
    admin = adminSql();
    const stale = await admin<{ id: string }[]>`select id from public.tenants where name like ${PREFIX + "%"}`;
    await deleteTenants(admin, stale.map((r) => r.id));
    await admin`insert into public.tenants (id, name, created_by) values (${tenantA}, ${PREFIX + " A"}, ${userIds.owner}), (${tenantB}, ${PREFIX + " B"}, ${ownerB})`;
    await admin`insert into public.branches (id, tenant_id, name, created_by) values (${mainBranch}, ${tenantA}, 'Main', ${userIds.owner}), (${cityBranch}, ${tenantA}, 'City', ${userIds.owner})`;
    await admin`insert into public.warehouses (id, tenant_id, branch_id, name, created_by) values (${mainWarehouse}, ${tenantA}, ${mainBranch}, 'Main store', ${userIds.owner}), (${cityWarehouse}, ${tenantA}, ${cityBranch}, 'City store', ${userIds.owner})`;
    await admin`insert into public.memberships ${admin([
      ...roles.map((role) => ({ tenant_id: tenantA, user_id: userIds[role], email: as[role].email, role, branch_ids: null, created_by: userIds.owner })),
      { tenant_id: tenantA, user_id: seller2, email: second.email, role: "salesperson", branch_ids: null, created_by: userIds.owner },
      { tenant_id: tenantA, user_id: cityKeeper, email: keeper.email, role: "warehouse_manager", branch_ids: [cityBranch], created_by: userIds.owner },
      { tenant_id: tenantB, user_id: ownerB, email: otherOwner.email, role: "owner", branch_ids: null, created_by: ownerB },
      { tenant_id: tenantB, user_id: userIds.warehouse_manager, email: as.warehouse_manager.email, role: "owner", branch_ids: null, created_by: ownerB },
    ])}`;
    await admin`insert into public.company_setup (tenant_id, sales_tax_registered, accounts_template, completed_by) values (${tenantA}, false, 'trading', ${userIds.owner})`;
    await setBaseCurrency(as.owner, { code: "PKR", name: "Pakistani Rupee" });
    await seedAccounts(as.owner, "trading");
    await openFiscalYear(as.owner, { month: "7", year: "2026" });
    const piece = (await addUnit(as.owner, { code: "pc", name: "Piece" })).id;
    carton = (await addUnit(as.owner, { code: "ctn", name: "Carton" })).id;
    helmet = (await createItem(as.owner, { code: "HL-1", name: "Helmet", unit: piece, defaultPrice: "1000" })).id;
    chain = (await createItem(as.owner, { code: "CH-2", name: "Chain", unit: piece, defaultPrice: "400" })).id;
    await setItemUnit(as.owner, chain, { unit: carton, factor: "4" });
    grip = (await createItem(as.owner, { code: "GR-3", name: "Grip", unit: piece, defaultPrice: "50" })).id;
    dealer = (await createParty(as.owner, "customer", { name: "Registered Dealer", code: "C-001" })).id;
    const seed = { tenantId: tenantA, warehouseId: mainWarehouse, userId: userIds.owner };
    await seedStock(admin, { ...seed, itemId: helmet, quantity: "10", value: "6000" });
    await seedStock(admin, { ...seed, itemId: chain, quantity: "12", value: "3000" });
    expect(await seedStock(admin, { ...seed, itemId: chain, quantity: "8", value: "2400" })).toEqual({ quantity: "20.0000", value: "5400.0000" });
  }, 240_000);

  afterAll(async () => {
    await deleteTenants(admin, [tenantA, tenantB]);
    await admin.end();
    await closeDb();
  }, 120_000);

  it("delivers part of an order, takes the goods out of stock at their average cost and posts the cost", async () => {
    const orderId = await order([line(helmet, "5"), line(chain, "3", { unitId: carton, discountPercent: "5" })]);
    expect(await progress(orderId)).toEqual(["HL-1 5 pc: 0 delivered, 5 to go", "CH-2 3 ctn: 0 delivered, 3 to go"]);
    expect((await listOrdersToDeliver(as.warehouse_manager)).map((o) => `${o.number} ${o.customerName} ${o.lines}`)).toEqual(["SO-2627-00001 Registered Dealer 2"]);

    // Who may make a delivery note: the sales team and the warehouse, not those who only read.
    for (const role of ["auditor", "recovery_officer"] as const) await expect(startDelivery(as[role], orderId), role).rejects.toThrow("Your role cannot write delivery notes.");
    await expect(startDelivery(second, orderId)).rejects.toThrow("A delivery note is made from a sales order.");
    const draftOrder = (await saveSalesDraft(as.salesperson, null, { kind: "order", date: D, customerId: dealer, warehouseId: mainWarehouse, lines: [line(helmet, "1")] })).id;
    await expect(startDelivery(as.salesperson, draftOrder)).rejects.toThrow("Submit the order before delivering it.");
    await discardSalesDraft(as.salesperson, draftOrder);

    // The warehouse starts the note: everything still to deliver, at the order's prices, with no number yet.
    const { id } = await startDelivery(as.warehouse_manager, orderId);
    const draft = await getSalesDocument(as.warehouse_manager, id);
    expect(draft).toMatchObject({ kind: "delivery", status: "draft", number: null, customerName: "Registered Dealer", warehouseName: "Main store", source: { id: orderId, number: "SO-2627-00001" }, madeFrom: [{ id: orderId, kind: "order" }] });
    expect(draft!.lines.map((l) => `${l.itemCode} ${l.quantity.toFixed()} ${l.unitCode} base ${l.baseQuantity.toFixed()} value ${l.value.toFixed(2)} tax ${l.taxAmount.toFixed(2)}`)).toEqual(["HL-1 5 pc base 5 value 5000.00 tax 0.00", "CH-2 3 ctn base 12 value 4560.00 tax 0.00"]);
    const rows = await getDeliveryRows(as.warehouse_manager, draft!);
    expect(rows.map((r) => `${r.itemCode}: ordered ${r.ordered.toFixed()}, delivered ${r.delivered.toFixed()}, now ${r.quantity.toFixed()}, in stock ${r.onHand.toFixed()}, cost ${r.cost}`)).toEqual(["HL-1: ordered 5, delivered 0, now 5, in stock 10, cost null", "CH-2: ordered 3, delivered 0, now 3, in stock 20, cost null"]);
    expect(await stock(helmet)).toBe("10 worth 6000.0000");

    // A part delivery: 2 helmets and 1 carton of chains. More than the order has left is refused.
    await expect(saveDeliveryDraft(as.warehouse_manager, id, { date: D, lines: quantities(rows, ["6", "1"]) })).rejects.toThrow("HL-1: the order has 5 still to deliver, not 6.");
    await expect(saveDeliveryDraft(as.warehouse_manager, id, { date: "2026-11-09", lines: quantities(rows, ["2", "1"]) })).rejects.toThrow("A delivery note is dated on or after its order.");
    await expect(saveDeliveryDraft(as.auditor, id, { date: D, lines: quantities(rows, ["2", "1"]) })).rejects.toThrow("Your role cannot write delivery notes.");
    await saveDeliveryDraft(as.warehouse_manager, id, { date: D, lines: quantities(rows, ["2", "1.25"]) });
    await saveDeliveryDraft(as.warehouse_manager, id, { date: D, lines: quantities(rows, ["2", "1.25"]) });
    const posted = await postDelivery(as.warehouse_manager, id);
    expect(posted).toEqual({ number: "DN-2627-00001" });

    // 2 helmets at 600 and 5 chains at 270: 1,200 + 1,350 = 2,550 out of stock and into cost of goods sold.
    expect(await stock(helmet)).toBe("8 worth 4800.0000");
    expect(await stock(chain)).toBe("15 worth 4050.0000");
    expect((await journalOf(id)).map((l) => l.line)).toEqual(["5100 Cost of goods sold 2550.0000 0.0000", "1300 Stock in trade 0.0000 2550.0000"]);
    const [journal] = await admin`select journal_date::text, document_number, memo, branch_id, created_by from public.journals where source_type = 'delivery_note' and source_id = ${id}`;
    expect(journal).toEqual({ journal_date: D, document_number: "DN-2627-00001", memo: "Goods delivered against sales order SO-2627-00001", branch_id: mainBranch, created_by: userIds.warehouse_manager });
    const moves = await admin`select i.code, m.quantity::text, m.value::text, m.quantity_after::text, m.value_after::text, m.move_date::text, m.source_type, m.created_by from public.stock_moves m join public.items i on i.id = m.item_id where m.source_id = ${id} order by i.code`;
    expect(moves.map((m) => `${m.code} ${m.quantity} ${m.value} -> ${m.quantity_after} ${m.value_after} ${m.move_date} ${m.source_type}`)).toEqual([
      "CH-2 -5.0000 -1350.0000 -> 15.0000 4050.0000 2026-11-10 delivery_note",
      "HL-1 -2.0000 -1200.0000 -> 8.0000 4800.0000 2026-11-10 delivery_note",
    ]);
    expect(moves[0].created_by).toBe(userIds.warehouse_manager);
    const note = await getSalesDocument(as.owner, id);
    expect(note).toMatchObject({ status: "submitted", number: "DN-2627-00001", customerName: "Registered Dealer" });
    // The cost shows to those who keep the books, not to the warehouse or the sales team.
    expect((await getDeliveryRows(as.owner, note!)).map((r) => `${r.itemCode} ${r.quantity.toFixed()} cost ${r.cost?.toFixed(2)}`)).toEqual(["HL-1 2 cost 1200.00", "CH-2 1.25 cost 1350.00"]);
    expect((await getDeliveryRows(as.warehouse_manager, note!)).map((r) => r.cost)).toEqual([null, null]);
    const audit = await admin<{ action: string; actor_role: string; after: Record<string, unknown> }[]>`select action, actor_role, after from public.audit_log where entity_id = ${id} or (after->>'sourceId') = ${id} order by at, action`;
    expect(audit.map((a) => `${a.action} by ${a.actor_role}`)).toEqual(["sales_delivery.create by warehouse_manager", "sales_delivery.update by warehouse_manager", "sales_delivery.update by warehouse_manager", "journal.post by warehouse_manager", "sales_delivery.submit by warehouse_manager"]);
    expect(audit.at(-1)!.after).toMatchObject({ number: "DN-2627-00001", kind: "delivery", customer: "Registered Dealer", lines: 2 });
    // The order knows what is left, and a second note delivers the rest.
    expect(await progress(orderId)).toEqual(["HL-1 5 pc: 2 delivered, 3 to go", "CH-2 3 ctn: 1.25 delivered, 1.75 to go"]);
    const rest = await startDelivery(as.salesperson, orderId);
    expect((await getSalesDocument(as.salesperson, rest.id))!.lines.map((l) => `${l.itemCode} ${l.quantity.toFixed()}`)).toEqual(["HL-1 3", "CH-2 1.75"]);
    await dated(as.salesperson, rest.id);
    expect(await postDelivery(as.salesperson, rest.id)).toEqual({ number: "DN-2627-00002" });
    expect(await stock(chain)).toBe("8 worth 2160.0000");
    expect(await progress(orderId)).toEqual(["HL-1 5 pc: 5 delivered, 0 to go", "CH-2 3 ctn: 3 delivered, 0 to go"]);
    await expect(startDelivery(as.warehouse_manager, orderId)).rejects.toThrow("Everything on this order has been delivered.");
    expect(await listOrdersToDeliver(as.warehouse_manager)).toEqual([]);
    // An order whose goods have left is not cancelled, in the app or past it.
    await expect(cancelSalesDocument(as.owner, orderId, { reason: "Changed their mind" })).rejects.toThrow("Goods have been delivered against this order. Cancel its delivery notes first.");
    expect(await codeOf(() => withTenant(userIds.owner, tenantA, (tx) => tx.update(salesDocuments).set({ status: "cancelled", cancelledBy: userIds.owner, cancelReason: "Changed their mind", updatedBy: userIds.owner }).where(eq(salesDocuments.id, orderId))))).toBe("SE065");
  });

  it("refuses to deliver more than is in stock, more than was ordered, or into a closed period", async () => {
    // 8 helmets are left; the order is for 9 of them and 2 grips, of which there are none.
    const orderId = await order([line(helmet, "9"), line(grip, "2")]);
    const { id } = await startDelivery(as.warehouse_manager, orderId);
    await dated(as.warehouse_manager, id);
    await expect(postDelivery(as.warehouse_manager, id)).rejects.toThrow("Not enough HL-1 in stock at Main store: 5 on hand, 9 needed. Stock is entered first; a delivery never takes it below zero.");
    const rows = await getDeliveryRows(as.warehouse_manager, (await getSalesDocument(as.warehouse_manager, id))!);
    await saveDeliveryDraft(as.warehouse_manager, id, { date: D, lines: quantities(rows, ["5", "2"]) });
    await expect(postDelivery(as.warehouse_manager, id)).rejects.toThrow("Not enough GR-3 in stock at Main store: 0 on hand, 2 needed.");
    // The database refuses it too, whoever asks, and nothing of the attempt is kept.
    expect(await codeOf(() => withTenant(userIds.warehouse_manager, tenantA, (tx) => tx.execute(sql`select * from app.post_delivery(${id}::uuid)`)))).toBe("SE060");
    expect(await stock(helmet)).toBe("5 worth 3000.0000");
    expect((await getSalesDocument(as.owner, id))!.status).toBe("draft");
    expect((await admin`select count(*)::int as n from public.stock_moves where source_id = ${id}`)[0].n).toBe(0);

    // An empty note is not posted; a locked month takes no stock move.
    await saveDeliveryDraft(as.warehouse_manager, id, { date: D, lines: [] });
    await expect(postDelivery(as.warehouse_manager, id)).rejects.toThrow("Enter how much of at least one line to deliver.");
    await saveDeliveryDraft(as.warehouse_manager, id, { date: D, lines: quantities(rows, ["4", ""]) });
    const november = (await listFiscalPeriods(as.owner)).find((p) => p.startsOn === "2026-11-01")!;
    await setPeriodLocked(as.owner, november.id, true);
    await expect(postDelivery(as.warehouse_manager, id)).rejects.toThrow("The period November 2026 is locked.");
    await setPeriodLocked(as.owner, november.id, false);

    // Two notes for the same order, each within what is left when written, together over it: the second is refused.
    const twin = await startDelivery(as.salesperson, orderId);
    const twinRows = await getDeliveryRows(as.salesperson, (await getSalesDocument(as.salesperson, twin.id))!);
    await saveDeliveryDraft(as.salesperson, twin.id, { date: D, lines: quantities(twinRows, ["1", ""]) });
    await saveDeliveryDraft(as.warehouse_manager, id, { date: D, lines: quantities(rows, ["1", ""]) });
    await admin`update public.sales_lines set quantity = 5, base_quantity = 5, value = 5000, total = 5000 where document_id = ${twin.id}`;
    await admin`update public.sales_documents set gross_total = 5000, value_total = 5000, total = 5000 where id = ${twin.id}`;
    await admin`update public.sales_lines set quantity = 5, base_quantity = 5, value = 5000, total = 5000 where document_id = ${id}`;
    await admin`update public.sales_documents set gross_total = 5000, value_total = 5000, total = 5000 where id = ${id}`;
    expect(await postDelivery(as.warehouse_manager, id)).toEqual({ number: "DN-2627-00003" });
    await expect(postDelivery(as.salesperson, twin.id)).rejects.toThrow("HL-1: the order has 4 still to deliver, not 5.");
    expect(await codeOf(() => withTenant(userIds.salesperson, tenantA, (tx) => tx.execute(sql`select * from app.post_delivery(${twin.id}::uuid)`)))).toBe("SE061");
    await discardSalesDraft(as.salesperson, twin.id);
    expect(await stock(helmet)).toBe("none".replace("none", "0 worth 0.0000"));
    expect((await journalOf(id)).map((l) => l.line)).toEqual(["5100 Cost of goods sold 3000.0000 0.0000", "1300 Stock in trade 0.0000 3000.0000"]);
  });

  it("posts and cancels only through the database's own functions, for the members who may", async () => {
    await seedStock(admin, { tenantId: tenantA, warehouseId: mainWarehouse, userId: userIds.owner, itemId: helmet, quantity: "6", value: "3900" });
    const orderId = await order([line(helmet, "2")]);
    const { id } = await startDelivery(as.salesperson, orderId);
    await dated(as.salesperson, id);
    const mine = and(eq(salesDocuments.tenantId, tenantA), eq(salesDocuments.id, id));

    // Marking the note submitted by hand moves no stock, so the whole transaction is refused when it ends.
    const byHand = { status: "submitted", submittedBy: userIds.salesperson, updatedBy: userIds.salesperson };
    expect(await codeOf(() => withTenant(userIds.salesperson, tenantA, (tx) => tx.update(salesDocuments).set(byHand).where(mine)))).toBe("SE068");
    expect(await codeOf(() => withTenant(userIds.salesperson, tenantA, async (tx) => {
      await tx.execute(sql`set constraints all immediate`);
      await tx.update(salesDocuments).set(byHand).where(mine);
    }))).toBe("SE068");
    expect((await getSalesDocument(as.owner, id))!.status).toBe("draft");
    // Nobody but the functions writes stock or a delivery's journal.
    const move = { tenantId: tenantA, itemId: helmet, warehouseId: mainWarehouse, moveDate: D, quantity: "100", value: "1", sourceType: "delivery_note", sourceId: id, quantityAfter: "106", valueAfter: "3901", createdBy: userIds.owner };
    expect(await codeOf(() => withTenant(userIds.owner, tenantA, (tx) => tx.insert(stockMoves).values(move)))).toBe("42501");
    expect(await codeOf(() => withTenant(userIds.owner, tenantA, (tx) => tx.update(stockBalances).set({ quantity: "999" })))).toBe("42501");
    expect(await codeOf(() => withTenant(userIds.owner, tenantA, (tx) => tx.execute(sql`select app.move_stock(${tenantA}::uuid, ${userIds.owner}::uuid, ${helmet}::uuid, ${mainWarehouse}::uuid, ${D}::date, 100, 1, 'delivery_note', ${id}::uuid, null)`)))).toBe("42501");
    expect(await codeOf(() => withTenant(userIds.owner, tenantA, (tx) => tx.execute(sql`select app.post_journal(${D}::date, 'delivery_note', ${id}::uuid, '[]'::jsonb)`)))).toBe("23514");
    // Roles that do not deliver, other companies, and another salesperson get nowhere.
    for (const who of [as.auditor, as.recovery_officer]) expect(await codeOf(() => withTenant(who.userId, tenantA, (tx) => tx.execute(sql`select * from app.post_delivery(${id}::uuid)`))), who.role).toBe("42501");
    expect(await codeOf(() => withTenant(seller2, tenantA, (tx) => tx.execute(sql`select * from app.post_delivery(${id}::uuid)`)))).toBe("SE063");
    expect(await codeOf(() => withTenant(ownerB, tenantB, (tx) => tx.execute(sql`select * from app.post_delivery(${id}::uuid)`)))).toBe("SE063");
    expect(await codeOf(() => withTenant(cityKeeper, tenantA, (tx) => tx.execute(sql`select * from app.post_delivery(${id}::uuid)`)))).toBe("SE063");
    await expect(postDelivery(second, id)).rejects.toThrow("That document is not in this company.");
    // A transaction that reads an older picture is not let near it.
    expect(await codeOf(() => getConnection().db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.user_id', ${userIds.salesperson}, true), set_config('app.tenant_id', ${tenantA}, true)`);
      await tx.execute(sql`select * from app.post_delivery(${id}::uuid)`);
    }, { isolationLevel: "repeatable read" }))).toBe("SE056");
    // A line that is not a line of the order, or in another unit, never gets onto the note.
    expect(await codeOf(() => withTenant(userIds.salesperson, tenantA, (tx) => tx.execute(sql`insert into public.sales_lines (tenant_id, document_id, line_no, item_id, description, unit_id, quantity, base_quantity, unit_price, value, total, created_by)
      select ${tenantA}, ${id}, 9, ${helmet}, 'Extra', base_unit_id, 1, 1, 1000, 1000, 1000, ${userIds.salesperson} from public.items where id = ${helmet}`)))).toBe("SE052");

    expect(await postDelivery(as.salesperson, id)).toEqual({ number: "DN-2627-00004" });
    // 2 of 6 helmets worth 3,900: 1,300.
    expect(await stock(helmet)).toBe("4 worth 2600.0000");
    await expect(postDelivery(as.salesperson, id)).rejects.toThrow("This delivery note is already posted.");
    await expect(saveDeliveryDraft(as.salesperson, id, { date: D, lines: [] })).rejects.toThrow("This delivery note is posted and cannot be changed.");
    await expect(discardSalesDraft(as.salesperson, id)).rejects.toThrow("Only a draft can be thrown away.");
    expect(await codeOf(() => withTenant(userIds.owner, tenantA, (tx) => tx.delete(salesLines).where(eq(salesLines.documentId, id))))).toBe("SE050");
    // The moves and the journal stay as they were written, even for postgres.
    expect(await codeOf(() => admin`update public.stock_moves set value = 0 where source_id = ${id}`)).toBe("SE062");
    expect(await codeOf(() => admin`delete from public.stock_moves where source_id = ${id}`)).toBe("SE062");

    // Cancelling by hand puts nothing back, so it is refused; through the app the goods come back at what they went out at.
    expect(await codeOf(() => withTenant(userIds.salesperson, tenantA, (tx) => tx.update(salesDocuments).set({ status: "cancelled", cancelledBy: userIds.salesperson, cancelReason: "By hand", updatedBy: userIds.salesperson }).where(mine)))).toBe("SE068");
    await expect(cancelDelivery(as.auditor, id, { date: D, reason: "Wrong customer" })).rejects.toThrow("Your role cannot write delivery notes.");
    await expect(cancelDelivery(as.salesperson, id, { date: D, reason: " " })).rejects.toThrow("Say why it is cancelled, in a few words.");
    await expect(cancelDelivery(as.salesperson, id, { date: "2026-11-09", reason: "Wrong customer" })).rejects.toThrow("A delivery note is cancelled on or after its own date.");
    await seedStock(admin, { tenantId: tenantA, warehouseId: mainWarehouse, userId: userIds.owner, itemId: helmet, quantity: "4", value: "3400" });
    await cancelDelivery(as.salesperson, id, { date: "2026-11-12", reason: "Wrong customer" });
    // 8 worth 6,000 before the goods came back; 10 worth 7,300 after: the 1,300 they left at, not today's average.
    expect(await stock(helmet)).toBe("10 worth 7300.0000");
    expect(await getSalesDocument(as.owner, id)).toMatchObject({ status: "cancelled", number: "DN-2627-00004", cancelReason: "Wrong customer" });
    const [original] = await admin`select id from public.journals where source_type = 'delivery_note' and source_id = ${id}`;
    const reversal = await admin`select j.journal_date::text, j.memo, (select string_agg(a.code || ' ' || l.debit::text || ' ' || l.credit::text, '; ' order by l.line_no) from public.journal_lines l join public.accounts a on a.id = l.account_id where l.journal_id = j.id) as lines from public.journals j where j.reverses_journal_id = ${original.id}`;
    expect(reversal).toEqual([{ journal_date: "2026-11-12", memo: "Delivery note DN-2627-00004 cancelled: Wrong customer", lines: "5100 0.0000 1300.0000; 1300 1300.0000 0.0000" }]);
    await expect(cancelDelivery(as.salesperson, id, { date: "2026-11-12", reason: "Again" })).rejects.toThrow("This delivery note is already cancelled.");
    // The order can be delivered again, or cancelled now that nothing is out.
    expect(await progress(orderId)).toEqual(["HL-1 2 pc: 0 delivered, 2 to go"]);
    await cancelSalesDocument(as.salesperson, orderId, { reason: "Wrong customer" });
    await expect(startDelivery(as.salesperson, orderId)).rejects.toThrow("This order is cancelled.");
  });

  it("shows the warehouse its own branch's orders and notes, and nothing of prices it should not write", async () => {
    await seedStock(admin, { tenantId: tenantA, warehouseId: cityWarehouse, userId: userIds.owner, itemId: grip, quantity: "50", value: "1000" });
    const cityOrder = await order([line(grip, "10")], as.sales_manager, cityWarehouse);
    const mainOrder = await order([line(helmet, "1")]);
    // The city's storekeeper sees the city's order to deliver, not the main store's, and no drafts or quotations.
    expect((await listOrdersToDeliver(keeper)).map((o) => o.id)).toEqual([cityOrder]);
    expect(await getSalesDocument(keeper, mainOrder)).toBeNull();
    await expect(startDelivery(keeper, mainOrder)).rejects.toThrow("A delivery note is made from a sales order.");
    const draft = await saveSalesDraft(as.sales_manager, null, { kind: "order", date: D, customerId: dealer, warehouseId: cityWarehouse, lines: [line(grip, "1")] });
    expect(await getSalesDocument(keeper, draft.id)).toBeNull();
    await expect(listSalesDocuments(keeper, { kind: "quotation" })).rejects.toThrow("Your role does not include sales documents.");
    await expect(saveSalesDraft(keeper, null, { kind: "order", date: D, customerId: dealer, warehouseId: cityWarehouse, lines: [line(grip, "1")] })).rejects.toThrow("Your role cannot write sales documents.");
    // The warehouse writes delivery notes, not orders, even with its own SQL.
    expect(await codeOf(() => withTenant(cityKeeper, tenantA, (tx) => tx.update(salesDocuments).set({ notes: "mine", updatedBy: cityKeeper }).where(eq(salesDocuments.id, draft.id))))).toBeUndefined();
    expect((await admin`select notes from public.sales_documents where id = ${draft.id}`)[0].notes).toBeNull();
    expect(await codeOf(() => withTenant(cityKeeper, tenantA, (tx) => tx.insert(salesDocuments).values({ tenantId: tenantA, kind: "order", documentDate: D, customerId: dealer, warehouseId: cityWarehouse, branchId: cityBranch, currency: "PKR", taxed: false, pricesIncludeTax: false, createdBy: cityKeeper, updatedBy: cityKeeper })))).toBe("42501");
    await discardSalesDraft(as.sales_manager, draft.id);

    const { id } = await startDelivery(keeper, cityOrder);
    await dated(keeper, id);
    expect(await postDelivery(keeper, id)).toMatchObject({ number: expect.stringMatching(/^DN-2627-/) });
    expect(await stock(grip, cityWarehouse)).toBe("40 worth 800.0000");
    expect((await listSalesDocuments(keeper, { kind: "delivery" })).rows.map((r) => `${r.customerName} ${r.status}`)).toEqual(["Registered Dealer submitted"]);
    // The main store's warehouse manager sees every branch; another company sees nothing.
    expect((await listSalesDocuments(as.warehouse_manager, { kind: "delivery" })).rows.length).toBeGreaterThan(1);
    expect((await listSalesDocuments(otherOwner, { kind: "delivery" })).rows).toEqual([]);
    expect(await withTenant(ownerB, tenantB, (tx) => tx.select({ id: stockMoves.id }).from(stockMoves))).toEqual([]);
    expect(await withTenant(userIds.recovery_officer, tenantA, (tx) => tx.select({ id: stockBalances.id }).from(stockBalances))).toEqual([]);
    expect((await withTenant(cityKeeper, tenantA, (tx) => tx.select({ id: stockBalances.id }).from(stockBalances))).length).toBe(1);
  });
  it("keeps a colleague's order, the order's prices and the cost of stock out of reach", async () => {
    await seedStock(admin, { tenantId: tenantA, warehouseId: mainWarehouse, userId: userIds.owner, itemId: grip, quantity: "3", value: "10" });
    await seedStock(admin, { tenantId: tenantA, warehouseId: mainWarehouse, userId: userIds.owner, itemId: chain, quantity: "4", value: "0" });
    // The salesperson's order: three lines of the same item, and a line of goods that cost nothing.
    const [before] = await admin`select quantity::text, value::text from public.stock_balances where item_id = ${chain} and warehouse_id = ${mainWarehouse}`;
    const orderId = await order([line(grip, "1"), line(grip, "1", { unitPrice: "55" }), line(grip, "1", { unitPrice: "60" })]);
    const [orderLine] = await admin`select id, unit_id from public.sales_lines where document_id = ${orderId} and line_no = 1`;

    // Another salesperson cannot write a note against it, by any path.
    const note = { tenantId: tenantA, kind: "delivery", documentDate: D, customerId: dealer, warehouseId: mainWarehouse, branchId: mainBranch, currency: "PKR", taxed: false, pricesIncludeTax: false, sourceDocumentId: orderId, createdBy: seller2, updatedBy: seller2 };
    expect(await codeOf(() => withTenant(seller2, tenantA, (tx) => tx.insert(salesDocuments).values(note)))).toBe("SE066");
    // The warehouse may, and the note is filed under the order's salesperson whatever it says.
    const [planted] = await withTenant(userIds.warehouse_manager, tenantA, (tx) => tx.insert(salesDocuments).values({ ...note, salespersonId: seller2, createdBy: userIds.warehouse_manager, updatedBy: userIds.warehouse_manager }).returning({ id: salesDocuments.id, salespersonId: salesDocuments.salespersonId }));
    expect(planted.salespersonId).toBe(userIds.salesperson);
    expect(await getSalesDocument(second, planted.id)).toBeNull();
    // A line of the note is the order's line at the order's price, with no tax.
    const lineAt = (price: string, tax = "0") => codeOf(() => withTenant(userIds.warehouse_manager, tenantA, (tx) => tx.execute(sql`insert into public.sales_lines (tenant_id, document_id, line_no, item_id, description, unit_id, quantity, base_quantity, list_price, price_source, unit_price, tax_amount, value, total, source_line_id, created_by)
      values (${tenantA}, ${planted.id}, 1, ${grip}, 'Grip', ${orderLine.unit_id}, 1, 1, 50, 'item', ${price}, ${tax}, ${price}, ${price}::numeric + ${tax}::numeric, ${orderLine.id}, ${userIds.warehouse_manager})`)));
    expect(await lineAt("1")).toBe("SE052");
    expect(await lineAt("50", "9")).toBe("SE052");
    expect(await lineAt("50")).toBeUndefined();
    await discardSalesDraft(as.warehouse_manager, planted.id);

    // What stock is worth is not for the warehouse or the sales team to read.
    for (const who of [userIds.warehouse_manager, userIds.salesperson, userIds.owner]) expect(await codeOf(() => withTenant(who, tenantA, (tx) => tx.execute(sql`select value from public.stock_balances`))), who).toBe("42501");
    for (const who of [userIds.warehouse_manager, userIds.salesperson, userIds.sales_manager]) expect(await withTenant(who, tenantA, (tx) => tx.select({ id: stockMoves.id }).from(stockMoves)), who).toEqual([]);
    expect((await withTenant(userIds.accountant, tenantA, (tx) => tx.select({ id: stockMoves.id }).from(stockMoves))).length).toBeGreaterThan(0);

    // Three grips worth 10 leave on three lines: 3.33, then 3.34, then the last 3.33, and nothing is left behind.
    const { id } = await startDelivery(as.salesperson, orderId);
    await dated(as.salesperson, id);
    await postDelivery(as.salesperson, id);
    const moves = await admin`select m.value::text, m.value_after::text from public.stock_moves m where m.source_id = ${id} order by m.created_at, m.quantity_after desc`;
    expect(moves.map((m) => `${m.value} -> ${m.value_after}`)).toEqual(["-3.3300 -> 6.6700", "-3.3400 -> 3.3300", "-3.3300 -> 0.0000"]);
    expect(await stock(grip)).toBe("0 worth 0.0000");
    expect((await journalOf(id)).map((l) => l.line)).toEqual(["5100 Cost of goods sold 10.0000 0.0000", "1300 Stock in trade 0.0000 10.0000"]);

    // Goods that cost nothing leave stock with no journal, and come back the same way.
    await admin`update public.stock_balances set value = 0 where item_id = ${chain} and warehouse_id = ${mainWarehouse}`;
    const freeOrder = await order([line(chain, "2")]);
    const free = await startDelivery(as.salesperson, freeOrder);
    await dated(as.salesperson, free.id);
    expect(await postDelivery(as.salesperson, free.id)).toMatchObject({ number: expect.stringMatching(/^DN-/) });
    expect(await journalOf(free.id)).toEqual([]);
    await cancelDelivery(as.salesperson, free.id, { date: D, reason: "Free samples withdrawn" });
    expect((await admin`select count(*)::int as n from public.journals where source_id = ${free.id}`)[0].n).toBe(0);
    await admin`update public.stock_balances set value = ${before.value} where item_id = ${chain} and warehouse_id = ${mainWarehouse}`;

    // Two notes for the whole of one order, posted at the same moment: one goes through.
    await seedStock(admin, { tenantId: tenantA, warehouseId: mainWarehouse, userId: userIds.owner, itemId: grip, quantity: "10", value: "500" });
    const raced = await order([line(grip, "4")]);
    const notes = [await startDelivery(as.salesperson, raced), await startDelivery(as.warehouse_manager, raced)];
    await dated(as.salesperson, notes[0].id);
    await dated(as.warehouse_manager, notes[1].id);
    const results = await Promise.allSettled([postDelivery(as.salesperson, notes[0].id), postDelivery(as.warehouse_manager, notes[1].id)]);
    expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(await stock(grip)).toBe("6 worth 300.0000");
    expect(await progress(raced)).toEqual(["GR-3 4 pc: 4 delivered, 0 to go"]);

    // A company that has registered for sales tax since the order was written can still deliver it.
    const late = await order([line(grip, "1")]);
    await admin`update public.company_setup set sales_tax_registered = true, strn = '1234567890123', tax_rates_confirmed_at = now() where tenant_id = ${tenantA}`;
    const afterwards = await startDelivery(as.salesperson, late);
    await dated(as.salesperson, afterwards.id);
    expect(await postDelivery(as.salesperson, afterwards.id)).toMatchObject({ number: expect.stringMatching(/^DN-/) });
    await admin`update public.company_setup set sales_tax_registered = false, strn = null, tax_rates_confirmed_at = null where tenant_id = ${tenantA}`;

    // After everything: what each warehouse holds is the sum of its moves, to the paisa, and the
    // ledger's cost of goods sold is what the delivery notes that stand took out of stock.
    const drift = await admin`
      select b.item_id from public.stock_balances b
      left join (select item_id, warehouse_id, sum(quantity) as quantity, sum(value) as value from public.stock_moves where tenant_id = ${tenantA} group by 1, 2) m
        on m.item_id = b.item_id and m.warehouse_id = b.warehouse_id
      where b.tenant_id = ${tenantA} and (b.quantity <> coalesce(m.quantity, 0) or (b.value <> coalesce(m.value, 0) and b.item_id <> ${chain}))`;
    expect(drift).toEqual([]);
    const [ledger] = await admin`select coalesce(sum(l.debit - l.credit), 0)::text as cogs from public.journal_lines l join public.accounts a on a.id = l.account_id where l.tenant_id = ${tenantA} and a.control_type = 'cogs'`;
    const [out] = await admin`select coalesce(-sum(value), 0)::text as cost from public.stock_moves where tenant_id = ${tenantA} and source_type = 'delivery_note'`;
    expect(Number(ledger.cogs)).toBe(Number(out.cost));
  });
});

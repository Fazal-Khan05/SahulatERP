import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, withTenant } from "@/db";
import { setBaseCurrency } from "@/modules/currencies/commands";
import { addUnit, createItem } from "@/modules/items/commands";
import { seedAccounts } from "@/modules/ledger/commands";
import { postOpening, setAccountBalance, startOpening } from "@/modules/opening/commands";
import { openFiscalYear } from "@/modules/numbering/commands";
import type { TenantContext } from "@/modules/tenant/rules";
import { adminSql, deleteTenants, hasAdminDb, type AdminSql } from "../../../tests/support/admin-db";
import {
  addCountItem,
  discardAdjustment,
  discardCount,
  discardTransfer,
  importOpeningStock,
  postAdjustment,
  postCount,
  postTransfer,
  rebookCount,
  returnCount,
  saveAdjustmentDraft,
  saveCounts,
  saveTransferDraft,
  startCount,
  submitCount,
} from "./commands";
import { getStockAdjustment, getStockCount, getStockTransfer, listCountsToPost, listStockAdjustments, listStockCounts, listStockOnHand, listStockTransfers } from "./queries";

// Stock transfers, adjustments, opening stock and counts against a real database, through the
// app's own path (app_runtime, withTenant, row-level security): what each posts, what is
// refused, and that the books always agree with the stock. Skipped when the database URLs are
// absent.

const hasDb = hasAdminDb() && Boolean(process.env.DATABASE_URL);
const PREFIX = "zz-stock-test";
const tenantA = randomUUID();
const tenantB = randomUUID();
const roles = ["owner", "accountant", "auditor", "sales_manager", "salesperson", "warehouse_manager", "recovery_officer"] as const;
const userIds = Object.fromEntries(roles.map((role) => [role, randomUUID()])) as Record<(typeof roles)[number], string>;
const cityKeeper = randomUUID();
const ownerB = randomUUID();
const mainBranch = randomUUID();
const northBranch = randomUUID();
const mainWarehouse = randomUUID();
const cityWarehouse = randomUUID();
const northWarehouse = randomUUID();
const ctx = (userId: string, tenantId: string, role: TenantContext["role"], branchIds: string[] | null = null): TenantContext => ({ userId, email: `${role}-${userId.slice(0, 4)}@stock.test`, tenantId, tenantName: "x", role, branchIds });
const as = Object.fromEntries(roles.map((role) => [role, ctx(userIds[role], tenantA, role)])) as Record<(typeof roles)[number], TenantContext>;
const keeper = ctx(cityKeeper, tenantA, "warehouse_manager", [northBranch]);
const otherOwner = ctx(ownerB, tenantB, "owner");
const D = "2026-11-10";

let admin: AdminSql;

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
const stock = async (code: string, warehouseId = mainWarehouse) => {
  const [row] = await admin`
    select b.quantity::text, b.value::text from public.stock_balances b join public.items i on i.id = b.item_id
    where b.tenant_id = ${tenantA} and i.code = ${code} and b.warehouse_id = ${warehouseId}`;
  return row ? `${Number(row.quantity)} worth ${Number(row.value).toFixed(2)}` : "none";
};
const journalOf = (sourceId: string, sourceType: string) => admin<{ line: string }[]>`
  select a.code || ' ' || a.name || ': ' || trim_scale(l.debit)::text || ' / ' || trim_scale(l.credit)::text as line
  from public.journals j join public.journal_lines l on l.journal_id = j.id join public.accounts a on a.id = l.account_id
  where j.source_type = ${sourceType} and j.source_id = ${sourceId} order by l.line_no`;
const lines = async (id: string, type: string) => (await journalOf(id, type)).map((row) => row.line);
const add = (itemCode: string, quantity: string, unitCost = "") => ({ itemCode, direction: "in", quantity, unitCost });
const take = (itemCode: string, quantity: string) => ({ itemCode, direction: "out", quantity, unitCost: "" });
/** A posted transfer, by the warehouse manager unless someone else is named. */
async function transfer(itemCode: string, quantity: string, from = mainWarehouse, to = cityWarehouse, who: TenantContext = as.warehouse_manager): Promise<string> {
  const { id } = await saveTransferDraft(who, null, { date: D, fromWarehouseId: from, toWarehouseId: to, lines: [{ itemCode, quantity }] });
  await postTransfer(who, id);
  return id;
}
/** Posts a count as the sheet stands at this moment: the poster has just looked at it. */
async function postSeen(who: TenantContext, id: string, countedFirst = false): Promise<{ number: string }> {
  return postCount(who, id, (await getStockCount(as.owner, id))!.updatedAt, countedFirst);
}
/** What the stock account says stock is worth, against what the warehouses hold and what the moves add up to. */
async function booksAgree(): Promise<{ ledger: string; balances: string; moves: string }> {
  const [ledger] = await admin`select coalesce(sum(l.debit - l.credit), 0)::numeric(20,2)::text as v from public.journal_lines l join public.accounts a on a.id = l.account_id where l.tenant_id = ${tenantA} and a.control_type = 'inventory'`;
  const [balances] = await admin`select coalesce(sum(value), 0)::numeric(20,2)::text as v from public.stock_balances where tenant_id = ${tenantA}`;
  const [moves] = await admin`select coalesce(sum(value), 0)::numeric(20,2)::text as v from public.stock_moves where tenant_id = ${tenantA}`;
  return { ledger: ledger.v, balances: balances.v, moves: moves.v };
}

describe.skipIf(!hasDb)("stock transfers, adjustments, opening stock and counts", () => {
  beforeAll(async () => {
    admin = adminSql();
    const stale = await admin<{ id: string }[]>`select id from public.tenants where name like ${PREFIX + "%"}`;
    await deleteTenants(admin, stale.map((r) => r.id));
    await admin`insert into public.tenants (id, name, created_by) values (${tenantA}, ${PREFIX + " A"}, ${userIds.owner}), (${tenantB}, ${PREFIX + " B"}, ${ownerB})`;
    await admin`insert into public.branches (id, tenant_id, name, created_by) values (${mainBranch}, ${tenantA}, 'Main', ${userIds.owner}), (${northBranch}, ${tenantA}, 'North', ${userIds.owner})`;
    await admin`insert into public.warehouses (id, tenant_id, branch_id, name, created_by) values (${mainWarehouse}, ${tenantA}, ${mainBranch}, 'Main store', ${userIds.owner}), (${cityWarehouse}, ${tenantA}, ${mainBranch}, 'City store', ${userIds.owner}), (${northWarehouse}, ${tenantA}, ${northBranch}, 'North store', ${userIds.owner})`;
    await admin`insert into public.memberships ${admin([
      ...roles.map((role) => ({ tenant_id: tenantA, user_id: userIds[role], email: as[role].email, role, branch_ids: null, created_by: userIds.owner })),
      { tenant_id: tenantA, user_id: cityKeeper, email: keeper.email, role: "warehouse_manager", branch_ids: [northBranch], created_by: userIds.owner },
      { tenant_id: tenantB, user_id: ownerB, email: otherOwner.email, role: "owner", branch_ids: null, created_by: ownerB },
    ])}`;
    await admin`insert into public.company_setup (tenant_id, sales_tax_registered, accounts_template, completed_by) values (${tenantA}, false, 'trading', ${userIds.owner})`;
    await setBaseCurrency(as.owner, { code: "PKR", name: "Pakistani Rupee" });
    await seedAccounts(as.owner, "trading");
    await openFiscalYear(as.owner, { month: "7", year: "2026" });
    const piece = (await addUnit(as.owner, { code: "pc", name: "Piece" })).id;
    await createItem(as.owner, { code: "HL-1", name: "Helmet", unit: piece, defaultPrice: "1000" });
    await createItem(as.owner, { code: "CH-2", name: "Chain", unit: piece, defaultPrice: "400" });
    await createItem(as.owner, { code: "GR-3", name: "Grip", unit: piece, defaultPrice: "50" });
    await createItem(as.owner, { code: "BL-4", name: "Bell", unit: piece, defaultPrice: "80" });
    await createItem(as.owner, { code: "TB-5", name: "Tube", unit: piece, defaultPrice: "20" });
  }, 240_000);

  afterAll(async () => {
    await deleteTenants(admin, [tenantA, tenantB]);
    await admin.end();
    await closeDb();
  }, 120_000);

  it("brings opening stock in at its cost, against opening balance equity", async () => {
    // Not for the warehouse, nor for anyone who only reads.
    for (const role of ["warehouse_manager", "auditor", "salesperson"] as const) {
      await expect(saveAdjustmentDraft(as[role], "opening", null, { date: D, warehouseId: mainWarehouse, lines: [add("HL-1", "10", "600")] }), role).rejects.toThrow("Only an owner or an accountant can do that.");
    }
    // Opening stock states what each item cost, names real items, and each of them once.
    const head = { date: D, warehouseId: mainWarehouse };
    await expect(saveAdjustmentDraft(as.owner, "opening", null, { ...head, lines: [add("HL-1", "10")] })).rejects.toThrow("Line 1: enter what one HL-1 cost.");
    await expect(saveAdjustmentDraft(as.owner, "opening", null, { ...head, lines: [add("NOPE", "1", "5")] })).rejects.toThrow("Line 1: there is no item with the code NOPE.");
    await expect(saveAdjustmentDraft(as.owner, "opening", null, { ...head, lines: [add("HL-1", "1", "5"), add("hl-1", "2", "5")] })).rejects.toThrow("hl-1 is entered twice.");
    await expect(saveAdjustmentDraft(as.owner, "opening", null, { ...head, lines: [add("HL-1", "1,000", "5")] })).rejects.toThrow("Line 1: Enter the quantity as a plain number");

    const { id, updatedAt } = await saveAdjustmentDraft(as.owner, "opening", null, { ...head, lines: [add("HL-1", "10", "600"), add("CH-2", "20", "270")] });
    expect(await getStockAdjustment(as.accountant, id)).toMatchObject({ kind: "opening", status: "draft", number: null, reason: null, warehouse: "Main store" });
    expect(await stock("HL-1")).toBe("none");
    // A screen opened before someone else's change does not post what it no longer shows.
    await expect(postAdjustment(as.owner, id, new Date(updatedAt.getTime() - 1000))).rejects.toThrow("Someone changed this opening stock entry after you opened it.");
    expect(await postAdjustment(as.owner, id, updatedAt)).toEqual({ number: "SA-2627-00001" });
    expect(await stock("HL-1")).toBe("10 worth 6000.00");
    expect(await stock("CH-2")).toBe("20 worth 5400.00");
    expect(await lines(id, "stock_adjustment")).toEqual(["1300 Stock in trade: 11400 / 0", "3900 Opening balance equity: 0 / 11400"]);
    const posted = await getStockAdjustment(as.auditor, id);
    expect(posted).toMatchObject({ status: "posted", number: "SA-2627-00001" });
    expect(posted!.lines.map((l) => `${l.code} ${l.quantity.toFixed()} at ${l.unitCost?.toFixed()} worth ${l.value?.toFixed(2)}`)).toEqual(["HL-1 10 at 600 worth 6000.00", "CH-2 20 at 270 worth 5400.00"]);

    // Posted: it does not change, is not posted twice and is not thrown away.
    await expect(saveAdjustmentDraft(as.owner, "opening", id, { ...head, lines: [add("HL-1", "11", "600")] })).rejects.toThrow("This is posted and cannot be changed.");
    await expect(postAdjustment(as.owner, id)).rejects.toThrow("This is already posted.");
    await expect(discardAdjustment(as.owner, id)).rejects.toThrow("This is posted and cannot be removed.");

    // From a file: every row right, or nothing kept and each wrong row named.
    const bad = await importOpeningStock(as.accountant, { date: D, warehouseId: northWarehouse, csv: "Item code,Quantity,Unit cost\nGR-3,40,12.5\nNOPE,1,1\nBL-4,x,\n" });
    expect(bad).toEqual({ ok: false, problems: [{ row: 4, name: "BL-4", problems: ["Quantity: Enter the quantity as a plain number without commas, such as 12 or 2.5.", "Unit cost: Enter what one cost."] }] });
    const unknown = await importOpeningStock(as.accountant, { date: D, warehouseId: northWarehouse, csv: "Item code,Quantity,Unit cost\nGR-3,40,12.5\nNOPE,1,1\n" });
    expect(unknown).toEqual({ ok: false, problems: [{ row: 3, name: "NOPE", problems: ["There is no item with this code. Add it to the item list first, or correct the code."] }] });
    expect(await importOpeningStock(as.accountant, { date: D, warehouseId: northWarehouse, csv: "Item code,Quantity\nGR-3,40\n" })).toEqual({ ok: false, reason: 'The file needs a "Unit cost" column in its first row.' });
    const imported = await importOpeningStock(as.accountant, { date: D, warehouseId: northWarehouse, csv: "﻿Item code,Quantity,Unit cost\r\ngr-3,40,12.5\r\n" });
    expect(imported).toMatchObject({ ok: true, lines: 1 });
    if (!imported.ok) throw new Error("not imported");
    expect(await postAdjustment(as.accountant, imported.id)).toEqual({ number: "SA-2627-00002" });
    expect(await stock("GR-3", northWarehouse)).toBe("40 worth 500.00");
    expect((await listStockAdjustments(as.auditor)).rows.map((r) => `${r.number} ${r.kind} ${r.warehouse} ${r.lines}`)).toEqual(["SA-2627-00002 opening North store 1", "SA-2627-00001 opening Main store 2"]);
    expect(await booksAgree()).toEqual({ ledger: "11900.00", balances: "11900.00", moves: "11900.00" });
  });

  it("transfers goods between warehouses at what they cost, with no entry in the books", async () => {
    for (const role of ["salesperson", "sales_manager", "auditor", "recovery_officer"] as const) {
      await expect(saveTransferDraft(as[role], null, { date: D, fromWarehouseId: mainWarehouse, toWarehouseId: cityWarehouse, lines: [{ itemCode: "HL-1", quantity: "4" }] }), role).rejects.toThrow("Only an owner, an accountant or the warehouse can do that.");
    }
    await expect(saveTransferDraft(as.warehouse_manager, null, { date: D, fromWarehouseId: mainWarehouse, toWarehouseId: mainWarehouse, lines: [] })).rejects.toThrow("Choose two different warehouses.");

    const { id } = await saveTransferDraft(as.warehouse_manager, null, { date: D, fromWarehouseId: mainWarehouse, toWarehouseId: cityWarehouse, note: "For the city counter", lines: [{ itemCode: "HL-1", quantity: "40" }] });
    await expect(postTransfer(as.warehouse_manager, id)).rejects.toThrow("There is not enough in stock for this transfer.");
    expect(await stock("HL-1")).toBe("10 worth 6000.00");
    await saveTransferDraft(as.warehouse_manager, id, { date: D, fromWarehouseId: mainWarehouse, toWarehouseId: cityWarehouse, note: "For the city counter", lines: [{ itemCode: "HL-1", quantity: "4" }] });
    expect(await postTransfer(as.warehouse_manager, id)).toEqual({ number: "ST-2627-00001" });
    expect(await stock("HL-1")).toBe("6 worth 3600.00");
    expect(await stock("HL-1", cityWarehouse)).toBe("4 worth 2400.00");
    expect(await lines(id, "stock_transfer")).toEqual([]);
    const moves = await admin`select quantity::int as quantity, value::int as value, warehouse_id from public.stock_moves where source_type = 'stock_transfer' and source_id = ${id} order by quantity`;
    expect(moves.map((m) => `${m.quantity} worth ${m.value} ${m.warehouse_id === mainWarehouse ? "main" : "city"}`)).toEqual(["-4 worth -2400 main", "4 worth 2400 city"]);
    await expect(postTransfer(as.warehouse_manager, id)).rejects.toThrow("This transfer is already posted.");
    await expect(discardTransfer(as.owner, id)).rejects.toThrow("This transfer is posted and cannot be removed.");

    // A transfer stays inside one branch for now: between branches each branch's books would need an entry of their own.
    await expect(saveTransferDraft(as.owner, null, { date: D, fromWarehouseId: mainWarehouse, toWarehouseId: northWarehouse, lines: [{ itemCode: "HL-1", quantity: "1" }] })).rejects.toThrow("These two warehouses belong to different branches.");
    const across = randomUUID();
    const [helmet] = await admin<{ id: string }[]>`select id from public.items where tenant_id = ${tenantA} and code = 'HL-1'`;
    expect(await codeOf(as.owner, sql`insert into public.stock_transfers (id, tenant_id, transfer_date, from_warehouse_id, to_warehouse_id, created_by, updated_by) values (${across}, ${tenantA}, ${D}, ${mainWarehouse}, ${northWarehouse}, ${userIds.owner}, ${userIds.owner})`)).toBeUndefined();
    expect(await codeOf(as.owner, sql`insert into public.stock_transfer_lines (tenant_id, transfer_id, line_no, item_id, quantity, created_by) values (${tenantA}, ${across}, 1, ${helmet.id}, 1, ${userIds.owner})`)).toBeUndefined();
    expect(await codeOf(as.owner, sql`select app.post_stock_transfer(${across})`)).toBe("SE208");
    await expect(postTransfer(as.owner, across)).rejects.toThrow("These two warehouses belong to different branches.");
    await discardTransfer(as.owner, across);

    // A member of the north branch sees nothing of the main branch's transfers and cannot move its stock.
    expect(await getStockTransfer(keeper, id)).toBeNull();
    await expect(saveTransferDraft(keeper, null, { date: D, fromWarehouseId: mainWarehouse, toWarehouseId: cityWarehouse, lines: [{ itemCode: "HL-1", quantity: "1" }] })).rejects.toThrow("Choose the warehouse the goods leave, from your own warehouses.");
    const pull = await saveTransferDraft(as.owner, null, { date: D, fromWarehouseId: mainWarehouse, toWarehouseId: cityWarehouse, lines: [{ itemCode: "HL-1", quantity: "1" }] });
    await expect(postTransfer(keeper, pull.id)).rejects.toThrow("That transfer is not in this company.");
    expect(await codeOf(keeper, sql`select app.post_stock_transfer(${pull.id})`)).toBe("SE200");
    // A line slipped into a document the member cannot write is refused the same way whether the
    // document is a draft, is posted, or does not exist: it learns nothing about it.
    const slip = (transferId: string) => codeOf(keeper, sql`insert into public.stock_transfer_lines (tenant_id, transfer_id, line_no, item_id, quantity, created_by) values (${tenantA}, ${transferId}, 9, ${helmet.id}, 5, ${cityKeeper})`);
    expect([await slip(pull.id), await slip(id), await slip(randomUUID())]).toEqual(["42501", "42501", "42501"]);
    await discardTransfer(as.owner, pull.id);
    expect((await listStockTransfers(as.auditor)).rows.map((r) => `${r.number} ${r.fromWarehouse} to ${r.toWarehouse}, ${r.lines}`)).toEqual(["ST-2627-00001 Main store to City store, 1"]);
    // Another company sees and posts nothing of this one.
    expect(await getStockTransfer(otherOwner, id)).toBeNull();
    expect(await codeOf(otherOwner, sql`select app.post_stock_transfer(${id})`)).toBe("SE200");
    expect(await booksAgree()).toEqual({ ledger: "11900.00", balances: "11900.00", moves: "11900.00" });
  });

  it("adjusts stock with a reason: out at the average cost, in at a stated or the average cost", async () => {
    const head = { date: D, warehouseId: mainWarehouse };
    await expect(saveAdjustmentDraft(as.warehouse_manager, "adjustment", null, { ...head, reason: "damaged", lines: [take("HL-1", "1")] })).rejects.toThrow("Only an owner or an accountant can do that.");
    await expect(saveAdjustmentDraft(as.accountant, "adjustment", null, { ...head, lines: [take("HL-1", "1")] })).rejects.toThrow("Choose the reason for the adjustment.");
    await expect(saveAdjustmentDraft(as.accountant, "adjustment", null, { ...head, reason: "other", lines: [take("HL-1", "1")] })).rejects.toThrow('Say in the note what the reason is, when it is "Other".');
    await expect(saveAdjustmentDraft(as.accountant, "adjustment", null, { ...head, reason: "damaged", lines: [{ ...take("HL-1", "1"), unitCost: "5" }] })).rejects.toThrow("goods taken out leave at their average cost");

    // One helmet broken; five grips found, which this warehouse has never held, at a stated cost.
    const { id } = await saveAdjustmentDraft(as.accountant, "adjustment", null, { ...head, reason: "damaged", note: "Dropped while unloading", lines: [take("HL-1", "1"), add("GR-3", "5", "10")] });
    expect(await postAdjustment(as.accountant, id)).toEqual({ number: "SA-2627-00003" });
    expect(await stock("HL-1")).toBe("5 worth 3000.00");
    expect(await stock("GR-3")).toBe("5 worth 50.00");
    expect(await lines(id, "stock_adjustment")).toEqual(["1300 Stock in trade: 50 / 0", "5110 Stock adjustments: 0 / 50", "5110 Stock adjustments: 600 / 0", "1300 Stock in trade: 0 / 600"]);
    const [journal] = await admin`select j.document_number, j.memo, j.branch_id from public.journals j where j.source_id = ${id}`;
    expect(journal).toMatchObject({ document_number: "SA-2627-00003", memo: "Stock adjustment in Main store: damaged, Dropped while unloading", branch_id: mainBranch });

    // Goods found with no cost stated come in at the cost the warehouse holds them at: the average does not move.
    const found = await saveAdjustmentDraft(as.owner, "adjustment", null, { ...head, reason: "found", lines: [add("CH-2", "2")] });
    await postAdjustment(as.owner, found.id);
    expect(await stock("CH-2")).toBe("22 worth 5940.00");
    // An item the warehouse has never held has no cost to go by.
    const blind = await saveAdjustmentDraft(as.owner, "adjustment", null, { date: D, warehouseId: cityWarehouse, reason: "found", lines: [add("BL-4", "3")] });
    await expect(postAdjustment(as.owner, blind.id)).rejects.toThrow("No cost is known for one of the items being added.");
    expect(await stock("BL-4", cityWarehouse)).toBe("none");
    await discardAdjustment(as.owner, blind.id);
    // Goods that came in for nothing give no cost to go by either: more of them are not let in for free without anyone saying so.
    const adjust = async (reason: string, line: ReturnType<typeof add>) => postAdjustment(as.owner, (await saveAdjustmentDraft(as.owner, "adjustment", null, { ...head, reason, lines: [line] })).id);
    await adjust("found", add("TB-5", "3", "0"));
    expect(await stock("TB-5")).toBe("3 worth 0.00");
    await expect(adjust("found", add("TB-5", "1"))).rejects.toThrow("No cost is known for one of the items being added.");
    await adjust("lost", take("TB-5", "3"));
    // A warehouse that holds none of an item takes what one cost the last time it came in.
    await adjust("found", add("TB-5", "3", "7"));
    await adjust("lost", take("TB-5", "3"));
    await adjust("found", add("TB-5", "2"));
    expect(await stock("TB-5")).toBe("2 worth 14.00");
    await adjust("lost", take("TB-5", "2"));
    // A sliver of a unit, worth a paisa after rounding, is too little to read a cost from:
    // what is found beside it comes in at the last cost worth reading, 7, not at 100.
    await adjust("found", add("TB-5", "0.0001", "50"));
    expect(await stock("TB-5")).toBe("0.0001 worth 0.01");
    await adjust("found", add("TB-5", "10"));
    expect(await stock("TB-5")).toBe("10.0001 worth 70.01");
    await adjust("lost", take("TB-5", "10.0001"));
    // More than the warehouse holds never leaves it.
    const over = await saveAdjustmentDraft(as.owner, "adjustment", null, { ...head, reason: "lost", lines: [take("GR-3", "6")] });
    await expect(postAdjustment(as.owner, over.id)).rejects.toThrow("There is not enough in stock for this stock adjustment.");
    await discardAdjustment(as.owner, over.id);
    // A date with no fiscal period is refused, and nothing is kept of the attempt: no number is lost.
    const early = await saveAdjustmentDraft(as.owner, "adjustment", null, { date: "2025-01-05", warehouseId: mainWarehouse, reason: "lost", lines: [take("GR-3", "1")] });
    await expect(postAdjustment(as.owner, early.id)).rejects.toThrow("No fiscal period is open for 05-01-2025.");
    await discardAdjustment(as.owner, early.id);

    // The warehouse does not read adjustments, on the screen or in the database.
    await expect(getStockAdjustment(as.warehouse_manager, id)).rejects.toThrow("Only an owner, an accountant or an auditor can see stock adjustments.");
    const seen = await withTenant(as.warehouse_manager.userId, tenantA, (tx) => tx.execute(sql`select (select count(*)::int from public.stock_adjustments) as documents, (select count(*)::int from public.stock_adjustment_lines) as lines`));
    expect(seen[0]).toEqual({ documents: 0, lines: 0 });
    expect(await booksAgree()).toEqual({ ledger: "11890.00", balances: "11890.00", moves: "11890.00" });
  });

  it("posts the differences of a stock count to the stock adjustments account", async () => {
    await expect(startCount(as.salesperson, { date: D, warehouseId: mainWarehouse })).rejects.toThrow("Only an owner, an accountant or the warehouse can do that.");
    const { id, lines: sheet } = await startCount(as.warehouse_manager, { date: D, warehouseId: mainWarehouse, note: "November count" });
    expect(sheet).toBe(3);
    let count = (await getStockCount(as.warehouse_manager, id))!;
    expect(count.lines.map((l) => `${l.code} book ${l.book.toFixed()} counted ${l.counted?.toFixed() ?? "-"}`)).toEqual(["CH-2 book 22 counted -", "GR-3 book 5 counted -", "HL-1 book 5 counted -"]);
    const line = (code: string) => count.lines.find((l) => l.code === code)!.id;

    // Nothing counted yet: it is not finished. Then: a chain over, a helmet short, the grips as the books say.
    await expect(submitCount(as.warehouse_manager, id)).rejects.toThrow("Nothing has been counted yet.");
    await expect(saveCounts(as.warehouse_manager, id, { date: D, note: "November count", lines: [{ lineId: line("HL-1"), counted: "-1", label: "HL-1" }] })).rejects.toThrow("HL-1: Enter what was counted as a plain number");
    await saveCounts(as.warehouse_manager, id, { date: D, note: "November count", lines: [{ lineId: line("CH-2"), counted: "23" }, { lineId: line("HL-1"), counted: "4" }, { lineId: line("GR-3"), counted: "5" }] });
    // Something on the shelf that the sheet does not list is added to it; the database says what the books held.
    await addCountItem(as.warehouse_manager, id, { itemCode: "bl-4" });
    await expect(addCountItem(as.warehouse_manager, id, { itemCode: "BL-4" })).rejects.toThrow("BL-4 is already on the sheet.");
    count = (await getStockCount(as.warehouse_manager, id))!;
    expect(count.lines.find((l) => l.code === "BL-4")).toMatchObject({ counted: null });
    expect(count.lines.find((l) => l.code === "BL-4")!.book.toFixed()).toBe("0");

    // The warehouse marks it finished. It cannot post it, and a finished sheet is closed.
    await expect(postSeen(as.owner, id)).rejects.toThrow("Mark the count finished before posting it.");
    await submitCount(as.warehouse_manager, id);
    await expect(postSeen(as.warehouse_manager, id)).rejects.toThrow("Only an owner or an accountant can post a stock count.");
    expect(await codeOf(as.warehouse_manager, sql`select app.post_stock_count(${id}, (select updated_at from public.stock_counts where id = ${id}), true)`)).toBe("42501");
    await expect(saveCounts(as.warehouse_manager, id, { date: D, lines: [{ lineId: line("HL-1"), counted: "5" }] })).rejects.toThrow("This count is finished and cannot be changed.");
    expect(await codeOf(as.warehouse_manager, sql`update public.stock_count_lines set counted_quantity = 5 where id = ${line("HL-1")} returning id`)).toBeUndefined();
    expect((await getStockCount(as.owner, id))!.lines.find((l) => l.code === "HL-1")!.counted!.toFixed()).toBe("4");
    // It waits for whoever keeps the books.
    expect((await listCountsToPost(as.accountant)).map((c) => `${c.warehouse} ${c.counted} of ${c.lines}`)).toEqual(["Main store 3 of 4"]);
    expect(await listCountsToPost(as.warehouse_manager)).toEqual([]);

    // The owner posts the sheet the owner looked at. One taken back, changed and finished again in between is refused.
    const looked = (await getStockCount(as.owner, id))!.updatedAt;
    await returnCount(as.warehouse_manager, id);
    await saveCounts(as.warehouse_manager, id, { date: D, note: "November count", lines: [{ lineId: line("HL-1"), counted: "1" }] });
    await submitCount(as.warehouse_manager, id);
    await expect(postCount(as.owner, id, looked)).rejects.toThrow("Someone changed this count after you opened it.");
    await expect(postCount(as.owner, id, undefined)).rejects.toThrow("Open the count again and look it over before posting it.");
    expect(await codeOf(as.owner, sql`select app.post_stock_count(${id}, ${looked.toISOString()}::timestamptz)`)).toBe("SE209");
    expect(await codeOf(as.owner, sql`select app.post_stock_count(${id}, null)`)).toBe("SE209");
    expect(await stock("HL-1")).toBe("5 worth 3000.00");
    await returnCount(as.owner, id);
    await saveCounts(as.warehouse_manager, id, { date: D, note: "November count", lines: [{ lineId: line("HL-1"), counted: "4" }] });
    await submitCount(as.warehouse_manager, id);

    expect(await postSeen(as.owner, id)).toEqual({ number: "SC-2627-00001" });
    // A helmet short leaves at the average, 600; a chain over comes in at the average, 270; the bell was not counted.
    expect(await stock("HL-1")).toBe("4 worth 2400.00");
    expect(await stock("CH-2")).toBe("23 worth 6210.00");
    expect(await stock("GR-3")).toBe("5 worth 50.00");
    expect(await stock("BL-4")).toBe("none");
    expect(await lines(id, "stock_count")).toEqual(["1300 Stock in trade: 270 / 0", "5110 Stock adjustments: 0 / 270", "5110 Stock adjustments: 600 / 0", "1300 Stock in trade: 0 / 600"]);
    expect(await getStockCount(as.auditor, id)).toMatchObject({ status: "posted", number: "SC-2627-00001" });
    const [logged] = await admin`select actor_role, after from public.audit_log where tenant_id = ${tenantA} and action = 'stock_count.post' and entity_id = ${id}`;
    expect(logged).toMatchObject({ actor_role: "owner", after: { number: "SC-2627-00001", counted: 3, differences: 2, surplus: "270.00", shortage: "600.00" } });

    // Posted: nothing about it changes.
    await expect(returnCount(as.owner, id)).rejects.toThrow("Only a finished count that is not yet posted can be sent back.");
    await expect(postSeen(as.owner, id)).rejects.toThrow("This count is already posted.");
    await expect(discardCount(as.owner, id)).rejects.toThrow("Only a count that is still being counted can be thrown away.");
    expect((await listStockCounts(as.warehouse_manager)).rows.map((r) => `${r.number} ${r.status} ${r.warehouse}`)).toEqual(["SC-2627-00001 posted Main store"]);
    expect(await booksAgree()).toEqual({ ledger: "11560.00", balances: "11560.00", moves: "11560.00" });
  });

  it("warns when stock moved after a count sheet was started, and applies the difference either way round", async () => {
    // Counted after the stock moved: the sheet is sent back and brought up to date.
    const first = await startCount(as.warehouse_manager, { date: D, warehouseId: mainWarehouse });
    let count = (await getStockCount(as.owner, first.id))!;
    const chain = count.lines.find((l) => l.code === "CH-2")!.id;
    await saveCounts(as.warehouse_manager, first.id, { date: D, lines: [{ lineId: chain, counted: "20" }] });
    await transfer("CH-2", "2");
    await submitCount(as.warehouse_manager, first.id);
    count = (await getStockCount(as.owner, first.id))!;
    expect(count.lines.filter((l) => !l.onHand.eq(l.book)).map((l) => `${l.code}: book ${l.book.toFixed()}, now ${l.onHand.toFixed()}`)).toEqual(["CH-2: book 23, now 21"]);
    await expect(postSeen(as.owner, first.id)).rejects.toThrow("Stock has moved since this sheet was started.");
    expect(await codeOf(as.owner, sql`select app.post_stock_count(${first.id}, (select updated_at from public.stock_counts where id = ${first.id}))`)).toBe("SE206");
    await expect(rebookCount(as.owner, first.id)).rejects.toThrow("Send the count back first");
    await returnCount(as.owner, first.id);
    await rebookCount(as.warehouse_manager, first.id);
    // The item that moved is compared with what the books hold now, and is counted again: what was
    // entered for it before is gone, so no difference appears that nobody found on the shelf.
    count = (await getStockCount(as.owner, first.id))!;
    expect(count.lines.find((l) => l.code === "CH-2")).toMatchObject({ counted: null });
    expect(count.lines.find((l) => l.code === "CH-2")!.book.toFixed()).toBe("21");
    await expect(submitCount(as.warehouse_manager, first.id)).rejects.toThrow("Nothing has been counted yet.");
    await saveCounts(as.warehouse_manager, first.id, { date: D, lines: [{ lineId: chain, counted: "20" }] });
    await submitCount(as.warehouse_manager, first.id);
    expect(await postSeen(as.accountant, first.id)).toEqual({ number: "SC-2627-00002" });
    expect(await stock("CH-2")).toBe("20 worth 5400.00");

    // Counted before the stock moved: the difference is applied on top of what is there now.
    const second = await startCount(as.owner, { date: D, warehouseId: mainWarehouse });
    count = (await getStockCount(as.owner, second.id))!;
    await saveCounts(as.owner, second.id, { date: D, lines: [{ lineId: count.lines.find((l) => l.code === "CH-2")!.id, counted: "19" }] });
    await transfer("CH-2", "1");
    await submitCount(as.owner, second.id);
    await expect(postSeen(as.owner, second.id)).rejects.toThrow("Stock has moved since this sheet was started.");
    expect(await postSeen(as.owner, second.id, true)).toEqual({ number: "SC-2627-00003" });
    expect(await stock("CH-2")).toBe("18 worth 4860.00");
    expect(await stock("CH-2", cityWarehouse)).toBe("3 worth 810.00");

    // A count that finds everything as the books say is posted too, and posts nothing.
    const third = await startCount(as.owner, { date: D, warehouseId: cityWarehouse });
    count = (await getStockCount(as.owner, third.id))!;
    await saveCounts(as.owner, third.id, { date: D, lines: count.lines.map((l) => ({ lineId: l.id, counted: l.book.toFixed() })) });
    await submitCount(as.owner, third.id);
    expect(await postSeen(as.owner, third.id)).toEqual({ number: "SC-2627-00004" });
    expect(await lines(third.id, "stock_count")).toEqual([]);
    expect(await getStockCount(as.owner, third.id)).toMatchObject({ status: "posted", journalId: null });
    expect(await booksAgree()).toEqual({ ledger: "11020.00", balances: "11020.00", moves: "11020.00" });
  });

  it("lets the app's role write nothing that only the posting functions may write", async () => {
    const draft = await saveTransferDraft(as.owner, null, { date: D, fromWarehouseId: mainWarehouse, toWarehouseId: cityWarehouse, lines: [{ itemCode: "HL-1", quantity: "1" }] });
    const [posted] = await admin<{ id: string }[]>`select id from public.stock_transfers where tenant_id = ${tenantA} and number = 'ST-2627-00001'`;
    const [adjustment] = await admin<{ id: string }[]>`select id from public.stock_adjustments where tenant_id = ${tenantA} and number = 'SA-2627-00003'`;
    const [helmet] = await admin<{ id: string }[]>`select id from public.items where tenant_id = ${tenantA} and code = 'HL-1'`;

    // The status, the number and who posted are closed to the app, on a draft and on a posted document alike.
    expect(await codeOf(as.owner, sql`update public.stock_transfers set status = 'posted', number = 'ST-2627-00099', posted_at = now(), posted_by = ${userIds.owner} where id = ${draft.id}`)).toBe("42501");
    expect(await codeOf(as.owner, sql`update public.stock_transfers set number = 'ST-2627-00099' where id = ${draft.id}`)).toBe("42501");
    expect(await codeOf(as.owner, sql`update public.stock_adjustments set journal_id = null where id = ${adjustment.id}`)).toBe("42501");
    expect(await codeOf(as.owner, sql`update public.stock_counts set status = 'submitted' where tenant_id = ${tenantA}`)).toBe("42501");
    expect(await codeOf(as.owner, sql`insert into public.stock_transfers (tenant_id, status, number, posted_at, posted_by, transfer_date, from_warehouse_id, to_warehouse_id, created_by, updated_by)
      values (${tenantA}, 'posted', 'ST-2627-00099', now(), ${userIds.owner}, ${D}, ${mainWarehouse}, ${cityWarehouse}, ${userIds.owner}, ${userIds.owner})`)).toBe("SE201");
    // A posted document and its lines stay as they are.
    await withTenant(as.owner.userId, tenantA, (tx) => tx.execute(sql`update public.stock_transfers set note = 'changed' where id = ${posted.id}`));
    await withTenant(as.owner.userId, tenantA, (tx) => tx.execute(sql`delete from public.stock_transfers where id = ${posted.id}`));
    await withTenant(as.owner.userId, tenantA, (tx) => tx.execute(sql`delete from public.stock_transfer_lines where transfer_id = ${posted.id}`));
    expect(await getStockTransfer(as.owner, posted.id)).toMatchObject({ status: "posted", note: "For the city counter", lines: [{ code: "HL-1" }] });
    expect(await codeOf(as.owner, sql`insert into public.stock_transfer_lines (tenant_id, transfer_id, line_no, item_id, quantity, created_by) values (${tenantA}, ${posted.id}, 2, ${helmet.id}, 1, ${userIds.owner})`)).toBe("SE204");
    expect(await codeOf(as.owner, sql`update public.stock_count_lines set book_quantity = 0 where tenant_id = ${tenantA}`)).toBe("42501");
    // Stock moves, the functions behind them and journals of these kinds are not the app's to write.
    expect(await codeOf(as.owner, sql`insert into public.stock_moves (tenant_id, item_id, warehouse_id, move_date, quantity, value, source_type, source_id, quantity_after, value_after, created_by)
      values (${tenantA}, ${helmet.id}, ${mainWarehouse}, ${D}, 5, 5, 'stock_adjustment', ${adjustment.id}, 5, 5, ${userIds.owner})`)).toBe("42501");
    expect(await codeOf(as.owner, sql`select app.move_stock(${tenantA}, ${userIds.owner}, ${helmet.id}, ${mainWarehouse}, ${D}::date, 5, 5, 'stock_adjustment', ${adjustment.id}, null)`)).toBe("42501");
    expect(await codeOf(as.owner, sql`select app.stock_gain_value(${tenantA}, ${helmet.id}, ${mainWarehouse}, 1)`)).toBe("42501");
    expect(await codeOf(as.owner, sql`select app.post_stock_journal(${tenantA}, ${userIds.owner}, 'owner', ${D}::date, 'stock_adjustment', ${adjustment.id}, 'SA-2627-00099', 'x', null, 'stock_adjustment', 5, 0)`)).toBe("42501");
    expect(await codeOf(as.owner, sql`select app.hold_stock_count(${adjustment.id}, array['owner']::public.member_role[])`)).toBe("42501");
    expect(await codeOf(as.owner, sql`select app.post_journal(${D}::date, 'stock_adjustment', ${randomUUID()}, '[]'::jsonb)`)).toBe("23514");
    // Nor the audit rows the posting functions write.
    for (const action of ["stock_transfer.post", "stock_adjustment.post", "stock_count.post", "stock_count.submit"]) {
      expect(await codeOf(as.owner, sql`insert into public.audit_log (tenant_id, actor_user_id, actor_role, action, entity) values (${tenantA}, ${userIds.owner}, 'owner', ${action}, 'x')`), action).toBe("42501");
    }
    // The warehouse cannot post what only the books' keepers post, whatever it calls.
    expect(await codeOf(as.warehouse_manager, sql`select app.post_stock_adjustment(${adjustment.id})`)).toBe("42501");
    // Posting is refused outside the kind of transaction its checks were written for.
    const strict = await codeOf(as.owner, sql`select set_config('transaction_isolation', 'repeatable read', true), app.post_stock_transfer(${draft.id})`);
    expect(["SE207", "25001"]).toContain(strict);
    await discardTransfer(as.owner, draft.id);
  });

  it("gives the last of the stock to one of two transfers posted at the same moment, and lets opposite transfers both through", async () => {
    // Four helmets in the main store; two transfers of three each.
    const drafts = await Promise.all([1, 2].map(() => saveTransferDraft(as.owner, null, { date: D, fromWarehouseId: mainWarehouse, toWarehouseId: cityWarehouse, lines: [{ itemCode: "HL-1", quantity: "3" }] })));
    const results = await Promise.allSettled(drafts.map((draft) => postTransfer(as.owner, draft.id)));
    expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(await stock("HL-1")).toBe("1 worth 600.00");
    expect(await stock("HL-1", cityWarehouse)).toBe("7 worth 4200.00");
    await discardTransfer(as.owner, drafts[results[0].status === "rejected" ? 0 : 1].id);

    // Main to city and city to main, of the same two items, ten times over: nobody waits on anybody for ever.
    const pairs = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        saveTransferDraft(as.owner, null, {
          date: D,
          fromWarehouseId: i % 2 === 0 ? mainWarehouse : cityWarehouse,
          toWarehouseId: i % 2 === 0 ? cityWarehouse : mainWarehouse,
          lines: i % 2 === 0 ? [{ itemCode: "CH-2", quantity: "1" }, { itemCode: "HL-1", quantity: "1" }] : [{ itemCode: "HL-1", quantity: "1" }, { itemCode: "CH-2", quantity: "1" }],
        }),
      ),
    );
    const posted = await Promise.allSettled(pairs.map((draft) => postTransfer(as.owner, draft.id)));
    // One helmet in the main store: a transfer out of it may find none left, and is refused for that and nothing else.
    for (const result of posted) if (result.status === "rejected") expect(String(result.reason)).toContain("There is not enough in stock for this transfer.");
    expect(posted.filter((r) => r.status === "fulfilled").length).toBeGreaterThanOrEqual(5);
    const drift = await admin`
      select b.item_id from public.stock_balances b
      left join (select item_id, warehouse_id, sum(quantity) as quantity, sum(value) as value from public.stock_moves where tenant_id = ${tenantA} group by 1, 2) m
        on m.item_id = b.item_id and m.warehouse_id = b.warehouse_id
      where b.tenant_id = ${tenantA} and (b.quantity <> coalesce(m.quantity, 0) or b.value <> coalesce(m.value, 0))`;
    expect(drift).toEqual([]);
    const books = await booksAgree();
    expect(books).toEqual({ ledger: "11020.00", balances: "11020.00", moves: "11020.00" });
    // What every warehouse holds, as the stock screen lists it.
    const onHand = await listStockOnHand(as.sales_manager);
    expect(onHand.rows.every((row) => row.quantity.gt(0))).toBe(true);
    expect(await listStockOnHand(keeper).then((found) => [...new Set(found.rows.map((row) => row.warehouse))])).toEqual(["North store"]);
    await expect(listStockOnHand(as.salesperson)).rejects.toThrow("Your role does not include stock.");
  });

  it("dates opening stock on the day the books opened, once the opening balances are posted", async () => {
    const [cash] = await admin<{ id: string }[]>`select id from public.accounts where tenant_id = ${tenantA} and code = '1111'`;
    await startOpening(as.owner, { date: D });
    await setAccountBalance(as.owner, { accountId: cash.id, debit: "1000", credit: "" });
    await postOpening(as.owner);
    // Opening stock goes past the profit and loss account, so it is not for any other day.
    const late = await saveAdjustmentDraft(as.owner, "opening", null, { date: "2026-11-12", warehouseId: cityWarehouse, lines: [add("BL-4", "2", "30")] });
    await expect(postAdjustment(as.owner, late.id)).rejects.toThrow("Opening stock is dated on the same day as they are");
    expect(await stock("BL-4", cityWarehouse)).toBe("none");
    await saveAdjustmentDraft(as.owner, "opening", late.id, { date: D, warehouseId: cityWarehouse, lines: [add("BL-4", "2", "30")] });
    expect(await postAdjustment(as.owner, late.id)).toEqual({ number: expect.stringMatching(/^SA-2627-/) });
    expect(await stock("BL-4", cityWarehouse)).toBe("2 worth 60.00");
    // A wrong opening quantity is put right against opening balance equity too, not against this year's profit.
    const fix = await saveAdjustmentDraft(as.owner, "opening", null, { date: D, warehouseId: cityWarehouse, lines: [take("BL-4", "1")] });
    await postAdjustment(as.owner, fix.id);
    expect(await lines(fix.id, "stock_adjustment")).toEqual(["3900 Opening balance equity: 30 / 0", "1300 Stock in trade: 0 / 30"]);
    // An ordinary adjustment is dated as it happens.
    const later = await saveAdjustmentDraft(as.owner, "adjustment", null, { date: "2026-11-12", warehouseId: cityWarehouse, reason: "sample", lines: [take("BL-4", "1")] });
    await postAdjustment(as.owner, later.id);
    expect(await booksAgree()).toEqual({ ledger: "11020.00", balances: "11020.00", moves: "11020.00" });
  });
});

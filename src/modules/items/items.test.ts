import { randomUUID } from "node:crypto";
import Decimal from "decimal.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, withTenant } from "@/db";
import { UserError } from "@/lib/errors";
import type { TenantContext } from "@/modules/tenant/rules";
import { adminSql, deleteTenants, hasAdminDb, type AdminSql } from "../../../tests/support/admin-db";
import { addItemCategory, addUnit, createItem, importItems, removeItemUnit, setItemArchived, setItemUnit, updateItem } from "./commands";
import { ITEM_LIST_LIMIT, convertToBase, getItem, getItemSetup, listItems } from "./queries";
import { itemCategories, itemUnits, items, units } from "./schema";

// Items, units and conversions against a real database, through the app's own path
// (app_runtime, withTenant, row-level security). Skipped when the database URLs are absent.

const hasDb = hasAdminDb() && Boolean(process.env.DATABASE_URL);
const PREFIX = "zz-item-test";
const tenantA = randomUUID();
const tenantB = randomUUID();
const roles = ["owner", "accountant", "sales_manager", "salesperson", "warehouse_manager", "recovery_officer", "auditor"] as const;
const userIds = Object.fromEntries(roles.map((role) => [role, randomUUID()])) as Record<(typeof roles)[number], string>;
const ownerB = randomUUID();
const ctx = (userId: string, tenantId: string, role: TenantContext["role"]): TenantContext => ({ userId, email: `${role}@item.test`, tenantId, tenantName: "x", role, branchIds: null });
const as = Object.fromEntries(roles.map((role) => [role, ctx(userIds[role], tenantA, role)])) as Record<(typeof roles)[number], TenantContext>;
const otherOwner = ctx(ownerB, tenantB, "owner");
const DENIED = "42501";
const CHECK = "23514";
const d = (value: string) => new Decimal(value);

let admin: AdminSql;
let piece: string;
let carton: string;
let kg: string;
let parts: string;
let brakePad: string;

async function codeOf(run: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await run();
    return undefined;
  } catch (error) {
    const e = error as { code?: string; cause?: { code?: string } };
    return e.cause?.code ?? e.code ?? "unknown";
  }
}
const count = async (table: "items" | "item_units" | "units", tenantId = tenantA) =>
  (await admin<{ n: number }[]>`select count(*)::int as n from public.${admin(table)} where tenant_id = ${tenantId}`)[0].n;

describe.skipIf(!hasDb)("items, units and conversions", () => {
  beforeAll(async () => {
    admin = adminSql();
    const stale = await admin<{ id: string }[]>`select id from public.tenants where name like ${PREFIX + "%"}`;
    await deleteTenants(admin, stale.map((r) => r.id));
    await admin`insert into public.tenants (id, name, created_by) values (${tenantA}, ${PREFIX + " A"}, ${userIds.owner}), (${tenantB}, ${PREFIX + " B"}, ${ownerB})`;
    await admin`insert into public.memberships ${admin([
      ...roles.map((role) => ({ tenant_id: tenantA, user_id: userIds[role], email: as[role].email, role, created_by: userIds.owner })),
      { tenant_id: tenantB, user_id: ownerB, email: otherOwner.email, role: "owner", created_by: ownerB },
    ])}`;
    await admin`select app.seed_tax_defaults(${tenantA}, ${userIds.owner})`;
  });

  afterAll(async () => {
    await deleteTenants(admin, [tenantA, tenantB]);
    await admin.end();
    await closeDb();
  }, 120_000);

  it("adds units and categories once each, by an owner or an accountant", async () => {
    piece = (await addUnit(as.owner, { code: "pc", name: "Piece" })).id;
    carton = (await addUnit(as.accountant, { code: "ctn", name: "Carton" })).id;
    kg = (await addUnit(as.owner, { code: "kg", name: "Kilogram" })).id;
    parts = (await addItemCategory(as.accountant, "Engine parts")).id;
    await expect(addUnit(as.owner, { code: "PC", name: "Pieces" })).rejects.toThrow("A unit with this name or short form already exists.");
    await expect(addUnit(as.owner, { code: "p", name: "piece" })).rejects.toThrow("A unit with this name or short form already exists.");
    // A name that is another unit's short form, or the reverse, would make one word mean two units.
    await expect(addUnit(as.owner, { code: "crt", name: "ctn" })).rejects.toThrow("A unit with this name or short form already exists.");
    await expect(addUnit(as.owner, { code: "Piece", name: "Single piece" })).rejects.toThrow("A unit with this name or short form already exists.");
    await expect(addItemCategory(as.owner, "ENGINE PARTS")).rejects.toThrow("A category with this name already exists.");
    await expect(addUnit(as.owner, { code: "2x", name: "Pair" })).rejects.toBeInstanceOf(UserError);
    for (const role of ["sales_manager", "warehouse_manager", "auditor"] as const) {
      await expect(addUnit(as[role], { code: "dz", name: "Dozen" }), role).rejects.toThrow("Only an owner or an accountant can change items.");
      await expect(addItemCategory(as[role], "Tyres"), role).rejects.toBeInstanceOf(UserError);
    }
    const setup = await getItemSetup(as.salesperson);
    expect(setup.units.map((u) => u.code)).toEqual(["ctn", "kg", "pc"]);
    expect(setup.categories.map((c) => c.name)).toEqual(["Engine parts"]);
    expect(setup.taxCategories.map((c) => c.name)).toContain("Standard rate");
    const audited = await admin`select action, after from public.audit_log where tenant_id = ${tenantA} and entity_id in (${piece}, ${parts}) order by action`;
    expect(audited).toEqual([
      { action: "item_category.add", after: { name: "Engine parts" } },
      { action: "unit.add", after: { code: "pc", name: "Piece" } },
    ]);
  }, 120_000);

  it("adds an item with every field and its pack, and writes the audit row", async () => {
    brakePad = (
      await createItem(as.accountant, {
        code: "BP-100",
        name: "Brake pad",
        category: parts,
        unit: piece,
        taxCategory: "Standard rate",
        hsCode: "8714.1090",
        fbrUomCode: "U1000069",
        saleType: "Goods at standard rate (default)",
        retailPrice: "1250.50",
        reorderLevel: "20",
        weight: "0.35",
        volume: "0.0012",
        trackBatches: "",
        trackSerials: "",
        packUnit: carton,
        packSize: "24",
      })
    ).id;
    const [row] = await admin`
      select i.code, i.name, c.name as category, u.code as unit, t.kind as tax, i.hs_code, i.fbr_uom_code, i.sale_type, i.retail_price::text,
        i.reorder_level::text, i.weight::text, i.volume::text, i.track_batches, i.track_serials, i.created_by, i.archived_at,
        (select factor::text from public.item_units x where x.item_id = i.id and x.unit_id = ${carton}) as carton_holds
      from public.items i join public.units u on u.id = i.base_unit_id
      left join public.item_categories c on c.id = i.category_id left join public.tax_categories t on t.id = i.tax_category_id where i.id = ${brakePad}`;
    expect(row).toEqual({
      code: "BP-100", name: "Brake pad", category: "Engine parts", unit: "pc", tax: "standard", hs_code: "8714.1090", fbr_uom_code: "U1000069",
      sale_type: "Goods at standard rate (default)", retail_price: "1250.5000", reorder_level: "20.0000", weight: "0.3500", volume: "0.0012",
      track_batches: false, track_serials: false, created_by: userIds.accountant, archived_at: null, carton_holds: "24.000000",
    });
    const [audited] = await admin`select actor_role, action, after from public.audit_log where entity_id = ${brakePad}`;
    expect(audited).toMatchObject({ actor_role: "accountant", action: "item.create", after: { code: "BP-100", retailPrice: "1250.5000", pack: { unitId: carton, factor: "24.000000" } } });

    await expect(createItem(as.owner, { code: "bp-100", name: "Brake pad again", unit: piece })).rejects.toThrow("Another item already has this code.");
    await expect(createItem(as.owner, { code: "BP-200", name: "Chain", unit: "box" })).rejects.toThrow('Unit: there is no unit called "box". Add it under Items, Units and categories first.');
    await expect(createItem(as.owner, { code: "BP-200", name: "Chain" })).rejects.toThrow("Unit: choose the unit the item is counted in.");
    for (const role of ["sales_manager", "salesperson", "warehouse_manager", "auditor"] as const) {
      await expect(createItem(as[role], { code: "BP-200", name: "Chain", unit: piece }), role).rejects.toThrow("Only an owner or an accountant can change items.");
    }
    expect(await count("items")).toBe(1);
  }, 120_000);

  it("applies the carton-to-piece conversion to a line entered in cartons", async () => {
    // Asked as a salesperson: whoever writes the line needs it.
    const base = async (quantity: string, unit: string) => {
      const result = await convertToBase(as.salesperson, brakePad, unit, d(quantity));
      return result.ok ? [result.quantity.toFixed(), result.baseUnitId] : result.reason;
    };
    expect(await base("3", carton)).toEqual(["72", piece]);
    expect(await base("0.5", carton)).toEqual(["12", piece]);
    expect(await base("7", piece)).toEqual(["7", piece]);
    expect(await base("3", kg)).toBe("This item is not bought or sold in that unit.");
    expect(await base("0", carton)).toBe("The quantity must be more than zero.");
    expect(await base("3", randomUUID())).toBe("This item is not bought or sold in that unit.");
    expect((await convertToBase(as.salesperson, randomUUID(), carton, d("3")))).toEqual({ ok: false, reason: "That item is not in this company." });

    // The carton is corrected to 20: lines entered from now on use the new size. Both sizes are in the audit log.
    await setItemUnit(as.owner, brakePad, { unit: "ctn", factor: "20" });
    expect(await base("3", carton)).toEqual(["60", piece]);
    await setItemUnit(as.accountant, brakePad, { unit: carton, factor: "24" });
    expect(await base("3", carton)).toEqual(["72", piece]);
    const audited = await admin`select actor_role, before->>'factor' as was, after->>'factor' as now from public.audit_log where entity_id = ${brakePad} and action = 'item_unit.set' order by at`;
    expect(audited).toEqual([
      { actor_role: "owner", was: "24.000000", now: "20.000000" },
      { actor_role: "accountant", was: "20.000000", now: "24.000000" },
    ]);

    await expect(setItemUnit(as.owner, brakePad, { unit: piece, factor: "1" })).rejects.toThrow("That is the item's own unit; it needs no conversion.");
    await expect(setItemUnit(as.owner, brakePad, { unit: "crate", factor: "10" })).rejects.toThrow("Choose a unit.");
    await expect(setItemUnit(as.owner, brakePad, { unit: kg, factor: "0" })).rejects.toThrow("Units per pack: The number of units must be more than zero.");
    await expect(setItemUnit(as.warehouse_manager, brakePad, { unit: kg, factor: "2" })).rejects.toBeInstanceOf(UserError);

    // A second unit, then removed again: the item is no longer counted in it.
    await setItemUnit(as.owner, brakePad, { unit: kg, factor: "0.35" });
    expect(await base("2", kg)).toEqual(["0.7", piece]);
    await removeItemUnit(as.owner, brakePad, kg);
    expect(await base("2", kg)).toBe("This item is not bought or sold in that unit.");
    expect((await getItem(as.auditor, brakePad))!.conversions.map((c) => [c.code, c.factor.toFixed()])).toEqual([["ctn", "24"]]);
  }, 120_000);

  it("changes an item, records only what changed, and never its unit", async () => {
    const form = { code: "BP-100", name: "Brake pad", category: parts, taxCategory: "Standard rate", hsCode: "8714.1090", fbrUomCode: "U1000069", saleType: "Goods at standard rate (default)", retailPrice: "1250.50", reorderLevel: "20", weight: "0.35", volume: "0.0012" };
    await updateItem(as.accountant, brakePad, form); // untouched: nothing written
    expect(await admin`select 1 from public.audit_log where entity_id = ${brakePad} and action = 'item.update'`).toHaveLength(0);

    const opened = (await getItem(as.owner, brakePad))!.updatedAt.toISOString();
    await updateItem(as.owner, brakePad, { ...form, retailPrice: "1300", reorderLevel: "", unit: kg }, opened);
    const [row] = await admin`select retail_price::text, reorder_level, base_unit_id, updated_by from public.items where id = ${brakePad}`;
    // The unit sent with the form is ignored: it stays the piece.
    expect(row).toEqual({ retail_price: "1300.0000", reorder_level: null, base_unit_id: piece, updated_by: userIds.owner });
    const [audited] = await admin`select before, after from public.audit_log where entity_id = ${brakePad} and action = 'item.update'`;
    expect(audited).toEqual({ before: { retailPrice: "1250.5000", reorderLevel: "20.0000" }, after: { retailPrice: "1300.0000", reorderLevel: null } });

    // A form opened before that change is refused; the conversion is untouched by an update.
    await expect(updateItem(as.accountant, brakePad, { ...form, name: "Brake pad (front)" }, opened)).rejects.toThrow(
      "Someone else changed this item while you had it open. Reload the page to see their change, then make yours.",
    );
    expect((await getItem(as.owner, brakePad))!.conversions).toHaveLength(1);
    await expect(updateItem(as.owner, brakePad, { ...form, name: "" })).rejects.toThrow("Enter the item's name.");
    await expect(updateItem(as.owner, randomUUID(), form)).rejects.toThrow("That item is not in this company.");
    await expect(updateItem(as.sales_manager, brakePad, form)).rejects.toBeInstanceOf(UserError);
  }, 120_000);

  it("archives and restores without deleting anything", async () => {
    await setItemArchived(as.owner, brakePad, true);
    expect((await listItems(as.owner, {})).rows).toEqual([]);
    expect((await listItems(as.owner, { archived: true })).rows.map((r) => r.code)).toEqual(["BP-100"]);
    await expect(updateItem(as.owner, brakePad, { code: "BP-100", name: "Renamed" })).rejects.toThrow("Restore the item before changing it.");
    await expect(createItem(as.owner, { code: "BP-100", name: "New pad", unit: piece })).rejects.toThrow("Another item already has this code.");
    await setItemArchived(as.accountant, brakePad, false);
    expect((await listItems(as.owner, {})).rows.map((r) => [r.code, r.category, r.unit, r.retailPrice?.toFixed(2)])).toEqual([["BP-100", "Engine parts", "pc", "1300.00"]]);
    const audited = await admin`select actor_role, action from public.audit_log where entity_id = ${brakePad} and action in ('item.archive', 'item.restore') order by at`;
    expect(audited).toEqual([{ actor_role: "owner", action: "item.archive" }, { actor_role: "accountant", action: "item.restore" }]);
    await expect(setItemArchived(as.warehouse_manager, brakePad, true)).rejects.toBeInstanceOf(UserError);
    // Archived, its units cannot be changed or removed either.
    await setItemArchived(as.owner, brakePad, true);
    await expect(removeItemUnit(as.owner, brakePad, carton)).rejects.toThrow("Restore the item before changing it.");
    await expect(setItemUnit(as.owner, brakePad, { unit: carton, factor: "30" })).rejects.toThrow("Restore the item before changing it.");
    await setItemArchived(as.owner, brakePad, false);
    expect((await getItem(as.owner, brakePad))!.conversions.map((c) => c.factor.toFixed())).toEqual(["24"]);
  }, 120_000);

  it("imports all or nothing, listing every bad row at once", async () => {
    const lines = ["Code,Name,Unit,Category,Retail price,Pack unit,Units per pack"];
    for (let i = 1; i <= 500; i++) lines.push(`IM-${String(i).padStart(4, "0")},Import Item ${i},pc,${i % 2 ? "Engine parts" : ""},${i * 10},${i % 5 ? "" : "ctn"},${i % 5 ? "" : "12"}`);
    lines[100] = "IM-0100,,pc,,,,"; // row 101: no name
    lines[200] = "IM-0200,Import Item 200,box,,,,"; // row 201: a unit the company does not have
    lines[300] = "bp-100,Import Item 300,pc,,,,"; // row 301: the code of an item already there
    const before = { items: await count("items"), units: await count("item_units") };
    expect(await importItems(as.accountant, { name: "items.csv", text: lines.join("\n") })).toEqual({
      problems: [
        { row: 101, name: "IM-0100", problems: ["Enter the item's name."] },
        { row: 201, name: "Import Item 200", problems: ['Unit: there is no unit called "box". Add it under Items, Units and categories first.'] },
        { row: 301, name: "Import Item 300", problems: ["Another item already has this code."] },
      ],
    });
    expect({ items: await count("items"), units: await count("item_units") }).toEqual(before);
    expect(await admin`select 1 from public.audit_log where tenant_id = ${tenantA} and action = 'item.import'`).toHaveLength(0);

    lines[100] = "IM-0100,Import Item 100,pc,,1000,ctn,12";
    lines[200] = "IM-0200,Import Item 200,pc,,2000,ctn,12";
    lines[300] = "IM-0300,Import Item 300,pc,,3000,ctn,12";
    expect(await importItems(as.accountant, { name: "items.csv", text: lines.join("\n") })).toEqual({ imported: 500 });
    expect(await count("items")).toBe(before.items + 500);
    expect(await count("item_units")).toBe(before.units + 100); // every fifth row has a pack
    const packed = await convertToBase(as.warehouse_manager, (await admin`select id from public.items where tenant_id = ${tenantA} and code = 'IM-0005'`)[0].id, carton, d("2"));
    expect(packed.ok && packed.quantity.toFixed()).toBe("24");
    const [audited] = await admin`select actor_role, after from public.audit_log where tenant_id = ${tenantA} and action = 'item.import'`;
    expect(audited).toMatchObject({ actor_role: "accountant", after: { rows: 500, file: "items.csv" } });
    expect(audited.after.ids).toHaveLength(500);

    const again = await importItems(as.owner, { name: "items.csv", text: lines.join("\n") });
    expect("problems" in again && again.problems.length).toBe(500);
    await expect(importItems(as.owner, { name: "x.csv", text: "Name\nChain\n" })).rejects.toThrow('The file needs a "Code" column in its first row.');
    await expect(importItems(as.sales_manager, { name: "x.csv", text: "Code,Name,Unit\nX1,Chain,pc\n" })).rejects.toBeInstanceOf(UserError);

    // The list is by code, searchable, and says when there is more than it shows.
    const all = await listItems(as.salesperson, {});
    expect([all.rows.length, all.more, all.rows[0].code]).toEqual([ITEM_LIST_LIMIT, true, "BP-100"]);
    expect((await listItems(as.salesperson, { search: "im-0499" })).rows.map((r) => r.name)).toEqual(["Import Item 499"]);
    expect((await listItems(as.salesperson, { search: "brake" })).rows.map((r) => r.code)).toEqual(["BP-100"]);
    expect((await listItems(as.salesperson, { search: "%" })).rows).toEqual([]);
    await expect(listItems(as.recovery_officer, {})).rejects.toThrow("Your role does not include the item list.");
  }, 120_000);

  it("keeps the same rules in the database, whatever the app does", async () => {
    const owner = userIds.owner;
    const by = (who: string) => ({ createdBy: who, updatedBy: who });
    const item = { tenantId: tenantA, code: "DIRECT", name: "Direct", baseUnitId: piece };
    for (const role of ["sales_manager", "salesperson", "warehouse_manager", "auditor"] as const) {
      const who = userIds[role];
      expect(await codeOf(() => withTenant(who, tenantA, (tx) => tx.insert(items).values({ ...item, ...by(who) }))), role).toBe(DENIED);
      expect(await codeOf(() => withTenant(who, tenantA, (tx) => tx.insert(units).values({ tenantId: tenantA, code: "dz", name: "Dozen", createdBy: who }))), role).toBe(DENIED);
      expect(await codeOf(() => withTenant(who, tenantA, (tx) => tx.insert(itemUnits).values({ tenantId: tenantA, itemId: brakePad, unitId: kg, factor: "2", ...by(who) }))), role).toBe(DENIED);
      expect((await withTenant(who, tenantA, (tx) => tx.select({ id: items.id }).from(items).limit(1))).length, role).toBe(1);
    }
    expect(await withTenant(userIds.recovery_officer, tenantA, (tx) => tx.select({ id: items.id }).from(items))).toEqual([]);
    expect(await withTenant(userIds.recovery_officer, tenantA, (tx) => tx.select({ id: units.id }).from(units))).toEqual([]);
    // An item's own unit never gets a conversion, a factor is above zero, formats hold.
    expect(await codeOf(() => withTenant(owner, tenantA, (tx) => tx.insert(itemUnits).values({ tenantId: tenantA, itemId: brakePad, unitId: piece, factor: "1", ...by(owner) })))).toBe(CHECK);
    expect(await codeOf(() => withTenant(owner, tenantA, (tx) => tx.insert(itemUnits).values({ tenantId: tenantA, itemId: brakePad, unitId: kg, factor: "0", ...by(owner) })))).toBe(CHECK);
    for (const bad of [{ code: "has space" }, { name: "x" }, { hsCode: "87" }, { retailPrice: "-1" }, { reorderLevel: "-1" }]) {
      expect(await codeOf(() => withTenant(owner, tenantA, (tx) => tx.insert(items).values({ ...item, ...bad, ...by(owner) }))), JSON.stringify(bad)).toBe(CHECK);
    }
    // The unit of an item, whose it is and who made it cannot be rewritten; nothing deletes an item, a unit or a category.
    for (const change of [{ baseUnitId: kg }, { tenantId: tenantB }, { createdBy: ownerB }]) {
      expect(await codeOf(() => withTenant(owner, tenantA, (tx) => tx.update(items).set(change))), JSON.stringify(change)).toBe(DENIED);
    }
    expect(await codeOf(() => withTenant(owner, tenantA, (tx) => tx.update(itemUnits).set({ unitId: kg })))).toBe(DENIED);
    expect(await codeOf(() => withTenant(owner, tenantA, (tx) => tx.update(units).set({ name: "Renamed" })))).toBe(DENIED);
    for (const table of [items, units, itemCategories]) expect(await codeOf(() => withTenant(owner, tenantA, (tx) => tx.delete(table)))).toBe(DENIED);
    expect(await admin`select 1 from public.items where tenant_id = ${tenantA} and code = 'DIRECT'`).toHaveLength(0);
  }, 120_000);

  it("keeps each company's items and units to itself", async () => {
    const pcB = (await addUnit(otherOwner, { code: "pc", name: "Piece" })).id;
    const theirs = (await createItem(otherOwner, { code: "BP-100", name: "Their brake pad", unit: pcB })).id;
    expect((await listItems(otherOwner, {})).rows.map((r) => r.name)).toEqual(["Their brake pad"]);
    expect(await count("units", tenantB)).toBe(1);

    expect(await getItem(as.owner, theirs)).toBeNull();
    expect((await listItems(as.owner, { search: "Their" })).rows).toEqual([]);
    expect(await convertToBase(as.owner, theirs, pcB, d("1"))).toEqual({ ok: false, reason: "That item is not in this company." });
    expect(await withTenant(userIds.owner, tenantB, (tx) => tx.select().from(items))).toEqual([]);
    expect(await withTenant(userIds.owner, tenantB, (tx) => tx.select().from(units))).toEqual([]);
    await expect(updateItem(as.owner, theirs, { code: "BP-100", name: "Taken over" })).rejects.toThrow("That item is not in this company.");
    await expect(setItemUnit(as.owner, theirs, { unit: carton, factor: "24" })).rejects.toThrow("That item is not in this company.");
    // A's item cannot be counted in B's unit, nor B's item given A's unit, by any route.
    await expect(setItemUnit(as.owner, brakePad, { unit: pcB, factor: "2" })).rejects.toThrow("Choose a unit.");
    for (const [context, itemId, unitId] of [[tenantA, brakePad, pcB], [tenantA, theirs, carton], [tenantB, theirs, pcB]] as const) {
      expect(
        await codeOf(() => withTenant(userIds.owner, context, (tx) => tx.insert(itemUnits).values({ tenantId: context, itemId, unitId, factor: "2", createdBy: userIds.owner, updatedBy: userIds.owner }))),
      ).toMatch(/^(42501|23503)$/);
    }
    expect(await count("item_units", tenantB)).toBe(0);
  }, 120_000);
});

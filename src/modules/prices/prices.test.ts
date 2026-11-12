import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, withTenant } from "@/db";
import { UserError } from "@/lib/errors";
import { addUnit, createItem, updateItem } from "@/modules/items/commands";
import { getItem } from "@/modules/items/queries";
import { createParty, updateParty } from "@/modules/parties/commands";
import { getParty } from "@/modules/parties/queries";
import type { TenantContext } from "@/modules/tenant/rules";
import { adminSql, deleteTenants, hasAdminDb, type AdminSql } from "../../../tests/support/admin-db";
import { createPriceList, setClassPrice, setCustomerPrice, setDefaultPriceList, setListPrice } from "./commands";
import { getPriceFor, getPriceList, listItemPrices, listPriceLists } from "./queries";
import { customerPrices, itemPricesByClass, priceListItems, priceLists } from "./schema";

// Prices against a real database, through the app's own path (app_runtime, withTenant,
// row-level security). Skipped when the database URLs are absent.

const hasDb = hasAdminDb() && Boolean(process.env.DATABASE_URL);
const PREFIX = "zz-price-test";
const tenantA = randomUUID();
const tenantB = randomUUID();
const roles = ["owner", "accountant", "sales_manager", "salesperson", "warehouse_manager", "auditor"] as const;
const userIds = Object.fromEntries(roles.map((role) => [role, randomUUID()])) as Record<(typeof roles)[number], string>;
const ownerB = randomUUID();
const ctx = (userId: string, tenantId: string, role: TenantContext["role"]): TenantContext => ({ userId, email: `${role}@price.test`, tenantId, tenantName: "x", role, branchIds: null });
const as = Object.fromEntries(roles.map((role) => [role, ctx(userIds[role], tenantA, role)])) as Record<(typeof roles)[number], TenantContext>;
const otherOwner = ctx(ownerB, tenantB, "owner");
const DENIED = "42501";
const CHECK = "23514";
const D = "2026-11-13";

let admin: AdminSql;
let pad: string;
let chain: string;
let wholesale: string; // a customer of class Wholesale, on no list
let retailer: string; // a customer with no class, put on the Retail list
let standard: string;
let retail: string;

async function codeOf(run: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await run();
    return undefined;
  } catch (error) {
    const e = error as { code?: string; cause?: { code?: string } };
    return e.cause?.code ?? e.code ?? "unknown";
  }
}
const pays = async (who: TenantContext, itemId: string, customerId: string | null, date = D) => {
  const found = await getPriceFor(who, { itemId, customerId, date });
  return found ? `${found.price.toFixed()} ${found.source}` : null;
};

describe.skipIf(!hasDb)("price lists and the price a customer pays", () => {
  beforeAll(async () => {
    admin = adminSql();
    const stale = await admin<{ id: string }[]>`select id from public.tenants where name like ${PREFIX + "%"}`;
    await deleteTenants(admin, stale.map((r) => r.id));
    await admin`insert into public.tenants (id, name, created_by) values (${tenantA}, ${PREFIX + " A"}, ${userIds.owner}), (${tenantB}, ${PREFIX + " B"}, ${ownerB})`;
    await admin`insert into public.memberships ${admin([
      ...roles.map((role) => ({ tenant_id: tenantA, user_id: userIds[role], email: as[role].email, role, created_by: userIds.owner })),
      { tenant_id: tenantB, user_id: ownerB, email: otherOwner.email, role: "owner", created_by: ownerB },
    ])}`;
    const piece = (await addUnit(as.owner, { code: "pc", name: "Piece" })).id;
    pad = (await createItem(as.owner, { code: "BP-100", name: "Brake pad", unit: piece, defaultPrice: "110" })).id;
    chain = (await createItem(as.owner, { code: "CH-200", name: "Chain", unit: piece })).id;
    wholesale = (await createParty(as.owner, "customer", { name: "Khan Autos", code: "C-001", customerClass: "Wholesale" })).id;
    retailer = (await createParty(as.owner, "customer", { name: "City Bikes" })).id;
  });

  afterAll(async () => {
    await deleteTenants(admin, [tenantA, tenantB]);
    await admin.end();
    await closeDb();
  });

  it("starts from the item's default price, and from nothing where there is none", async () => {
    expect((await getItem(as.owner, pad))!.item.defaultPrice).toBe("110.0000");
    expect(await pays(as.salesperson, pad, wholesale)).toBe("110 item");
    expect(await pays(as.salesperson, pad, null)).toBe("110 item"); // no particular customer
    expect(await pays(as.salesperson, chain, wholesale)).toBeNull(); // no price anywhere: never a guess
    expect(await pays(as.salesperson, randomUUID(), wholesale)).toBeNull();
    expect(await pays(as.salesperson, pad, randomUUID())).toBeNull();
    expect(await getPriceFor(as.salesperson, { itemId: pad, customerId: null, date: "13-11-2026" })).toBeNull();
    await expect(getPriceFor(as.warehouse_manager, { itemId: pad, customerId: null, date: D })).rejects.toThrow("Your role does not include prices.");
  });

  it("adds price lists; the first is the default until another is chosen", async () => {
    standard = (await createPriceList(as.sales_manager, "Standard")).id;
    retail = (await createPriceList(as.accountant, "Retail")).id;
    await expect(createPriceList(as.owner, "STANDARD")).rejects.toThrow("A price list with this name already exists.");
    await expect(createPriceList(as.owner, "x")).rejects.toBeInstanceOf(UserError);
    for (const role of ["salesperson", "warehouse_manager", "auditor"] as const) {
      await expect(createPriceList(as[role], "Mine"), role).rejects.toThrow("Only an owner, an accountant or a sales manager can change prices.");
    }
    expect((await listPriceLists(as.auditor)).map((l) => [l.name, l.isDefault])).toEqual([["Standard", true], ["Retail", false]]);
    await setDefaultPriceList(as.owner, retail);
    await setDefaultPriceList(as.owner, standard);
    expect((await listPriceLists(as.salesperson)).map((l) => [l.name, l.isDefault])).toEqual([["Standard", true], ["Retail", false]]);
    const audited = await admin`select action, before, after from public.audit_log where tenant_id = ${tenantA} and entity = 'price_list' order by at`;
    expect(audited.map((a) => a.action)).toEqual(["price_list.create", "price_list.create", "price_list.set_default", "price_list.set_default"]);
    expect([audited[3].before, audited[3].after]).toEqual([{ default: "Retail" }, { default: "Standard" }]);
  });

  it("resolves customer-specific > class > list > item default, from stored prices", async () => {
    // List: the default list applies to a customer on no list.
    await setListPrice(as.sales_manager, standard, { item: "bp-100", price: "100", validFrom: "2026-07-01", validTo: "" });
    expect(await pays(as.salesperson, pad, wholesale)).toBe("100 list");
    expect(await pays(as.salesperson, pad, null)).toBe("100 list");
    // A customer put on another list uses that list, and falls to the item default where it has no price.
    await updateParty(as.owner, "customer", retailer, { name: "City Bikes", priceListId: retail });
    expect((await getParty(as.owner, "customer", retailer))!.party.priceListId).toBe(retail);
    expect(await pays(as.salesperson, pad, retailer)).toBe("110 item");
    await setListPrice(as.owner, retail, { item: pad, price: "120", validFrom: "2026-07-01" });
    expect(await pays(as.salesperson, pad, retailer)).toBe("120 list");
    // Class beats list; it reaches only customers of that class, whatever the capitals.
    await setClassPrice(as.accountant, { item: "BP-100", customerClass: "wholesale", price: "95", validFrom: "2026-07-01" });
    expect(await pays(as.salesperson, pad, wholesale)).toBe("95 class");
    expect(await pays(as.salesperson, pad, retailer)).toBe("120 list");
    // The customer's own price beats everything, even when it is dearer.
    await setCustomerPrice(as.owner, { item: "BP-100", customer: "c-001", price: "130", validFrom: "2026-10-01", validTo: "2026-12-31" });
    expect(await pays(as.salesperson, pad, wholesale)).toBe("130 customer");
    // Dates: before it starts and after it ends the class price is back; before any price, the item default.
    expect(await pays(as.salesperson, pad, wholesale, "2026-09-30")).toBe("95 class");
    expect(await pays(as.salesperson, pad, wholesale, "2026-12-31")).toBe("130 customer");
    expect(await pays(as.salesperson, pad, wholesale, "2027-01-01")).toBe("95 class");
    expect(await pays(as.salesperson, pad, wholesale, "2026-06-30")).toBe("110 item");
    // A later list price takes over from its date; an order dated before it keeps the old price.
    await setListPrice(as.owner, standard, { item: pad, price: "105", validFrom: "2026-12-01" });
    expect(await pays(as.salesperson, pad, null, "2026-11-30")).toBe("100 list");
    expect(await pays(as.salesperson, pad, null, "2026-12-01")).toBe("105 list");
    // Many lookups, each a trip to a database far away.
  }, 120_000);

  it("corrects a price that starts the same day, keeping both values in the audit log", async () => {
    await setListPrice(as.accountant, standard, { item: pad, price: "101.5", validFrom: "2026-07-01", validTo: "2026-11-30" });
    expect(await admin`select price::text, valid_to::text, created_by, updated_by from public.price_list_items where price_list_id = ${standard} and valid_from = '2026-07-01'`).toEqual([
      { price: "101.5000", valid_to: "2026-11-30", created_by: userIds.sales_manager, updated_by: userIds.accountant },
    ]);
    const audited = await admin`
      select actor_role, before, after from public.audit_log where tenant_id = ${tenantA} and action = 'price.set' and after->>'list' = 'Standard' and after->>'validFrom' = '2026-07-01' order by at`;
    expect(audited).toEqual([
      { actor_role: "sales_manager", before: null, after: { list: "Standard", item: "BP-100", price: "100.0000", validFrom: "2026-07-01", validTo: null } },
      {
        actor_role: "accountant",
        before: { list: "Standard", item: "BP-100", price: "100.0000", validFrom: "2026-07-01", validTo: null },
        after: { list: "Standard", item: "BP-100", price: "101.5000", validFrom: "2026-07-01", validTo: "2026-11-30" },
      },
    ]);
    // The lists screen counts the prices each list holds.
    expect((await listPriceLists(as.auditor)).map((l) => [l.name, l.prices])).toEqual([["Standard", 2], ["Retail", 1]]);
    const list = (await getPriceList(as.auditor, standard, D))!;
    expect(list.prices.map((p) => [p.itemCode, p.price.toFixed(), p.validFrom, p.validTo, p.inForce])).toEqual([
      ["BP-100", "105", "2026-12-01", null, false],
      ["BP-100", "101.5", "2026-07-01", "2026-11-30", true],
    ]);
    const special = await listItemPrices(as.salesperson, pad, D);
    expect([special.lists.length, special.classes.map((p) => [p.label, p.price.toFixed(), p.inForce]), special.customers.map((p) => [p.label, p.inForce])]).toEqual([
      3,
      [["wholesale", "95", true]],
      [["Khan Autos", true]],
    ]);
  });

  it("refuses a price that makes no sense, and roles that may not set one", async () => {
    const good = { item: "BP-100", price: "99", validFrom: "2027-01-01", validTo: "" };
    await expect(setListPrice(as.owner, standard, { ...good, price: "1,000" })).rejects.toThrow("Price: Enter the amount as a plain number without commas, such as 500000.");
    await expect(setListPrice(as.owner, standard, { ...good, validTo: "2026-12-31" })).rejects.toThrow("The last day cannot be before the first.");
    await expect(setListPrice(as.owner, standard, { ...good, item: "NOPE" })).rejects.toThrow('There is no item with the code "NOPE".');
    await expect(setListPrice(as.owner, randomUUID(), good)).rejects.toThrow("That price list is not in this company.");
    await expect(setClassPrice(as.owner, { ...good, customerClass: " " })).rejects.toThrow("Enter the customer class, such as Wholesale.");
    await expect(setCustomerPrice(as.owner, { ...good, customer: "Nobody Ltd" })).rejects.toThrow('There is no customer with the code or name "Nobody Ltd".');
    for (const role of ["salesperson", "warehouse_manager", "auditor"] as const) {
      await expect(setListPrice(as[role], standard, good), role).rejects.toBeInstanceOf(UserError);
      await expect(setClassPrice(as[role], { ...good, customerClass: "Wholesale" }), role).rejects.toBeInstanceOf(UserError);
      await expect(setCustomerPrice(as[role], { ...good, customer: "C-001" }), role).rejects.toBeInstanceOf(UserError);
      await expect(setDefaultPriceList(as[role], retail), role).rejects.toBeInstanceOf(UserError);
    }
    await expect(listPriceLists(as.warehouse_manager)).rejects.toThrow("Your role does not include prices.");
    expect(await admin`select 1 from public.price_list_items where tenant_id = ${tenantA} and valid_from = '2027-01-01'`).toHaveLength(0);
    // A customer is found by name too. Where one customer's code is another's name, the code wins:
    // the price never lands on the wrong customer.
    const coded = (await createParty(as.owner, "customer", { name: "Zed Traders", code: "ALI" })).id;
    const named = (await createParty(as.owner, "customer", { name: "Ali", code: "C-9" })).id;
    await setCustomerPrice(as.owner, { item: chain, customer: "city bikes", price: "0", validFrom: "2026-07-01" });
    expect(await pays(as.salesperson, chain, retailer)).toBe("0 customer"); // a price of zero is a price
    await setCustomerPrice(as.owner, { item: chain, customer: "Ali", price: "50", validFrom: "2026-07-01" });
    expect([await pays(as.salesperson, chain, coded), await pays(as.salesperson, chain, named)]).toEqual(["50 customer", null]);
    await setCustomerPrice(as.owner, { item: chain, customer: "c-9", price: "60", validFrom: "2026-07-01" });
    expect(await pays(as.salesperson, chain, named)).toBe("60 customer");
    // A customer cannot be put on a price list that does not exist; the default price is the item form's.
    await expect(updateParty(as.owner, "customer", retailer, { name: "City Bikes", priceListId: randomUUID() })).rejects.toThrow("Choose a price list from the list.");
    await updateItem(as.accountant, pad, { code: "BP-100", name: "Brake pad", defaultPrice: "115" });
    expect(await pays(as.salesperson, pad, wholesale, "2026-06-30")).toBe("115 item");
  }, 120_000);

  it("keeps the same rules in the database, whatever the app does", async () => {
    const owner = userIds.owner;
    const by = (who: string) => ({ createdBy: who, updatedBy: who });
    const row = { tenantId: tenantA, priceListId: standard, itemId: chain, price: "50", validFrom: "2026-07-01" };
    for (const role of ["salesperson", "auditor", "warehouse_manager"] as const) {
      const who = userIds[role];
      expect(await codeOf(() => withTenant(who, tenantA, (tx) => tx.insert(priceListItems).values({ ...row, ...by(who) }))), role).toBe(DENIED);
      expect(await codeOf(() => withTenant(who, tenantA, (tx) => tx.insert(priceLists).values({ tenantId: tenantA, name: "Direct", createdBy: who }))), role).toBe(DENIED);
    }
    // The warehouse sees no prices at all; a salesperson reads them.
    expect(await withTenant(userIds.warehouse_manager, tenantA, (tx) => tx.select({ id: priceListItems.id }).from(priceListItems))).toEqual([]);
    expect((await withTenant(userIds.salesperson, tenantA, (tx) => tx.select({ id: customerPrices.id }).from(customerPrices))).length).toBe(4);
    // Class and customer prices are closed to the same roles as list prices.
    for (const who of [userIds.salesperson, userIds.auditor]) {
      expect(await codeOf(() => withTenant(who, tenantA, (tx) => tx.insert(itemPricesByClass).values({ tenantId: tenantA, customerClass: "Retail", itemId: chain, price: "1", validFrom: "2026-07-01", ...by(who) })))).toBe(DENIED);
      expect(await codeOf(() => withTenant(who, tenantA, (tx) => tx.insert(customerPrices).values({ tenantId: tenantA, customerId: retailer, itemId: pad, price: "1", validFrom: "2026-07-01", ...by(who) })))).toBe(DENIED);
    }
    // A price is not negative, its days are in order, and only one list is the default.
    expect(await codeOf(() => withTenant(owner, tenantA, (tx) => tx.insert(priceListItems).values({ ...row, price: "-1", ...by(owner) })))).toBe(CHECK);
    expect(await codeOf(() => withTenant(owner, tenantA, (tx) => tx.insert(priceListItems).values({ ...row, validTo: "2026-06-30", ...by(owner) })))).toBe(CHECK);
    expect(await codeOf(() => withTenant(owner, tenantA, (tx) => tx.insert(priceLists).values({ tenantId: tenantA, name: "Second default", isDefault: true, createdBy: owner })))).toBe("23505");
    // What a price is for cannot be rewritten, and nothing is deleted.
    for (const change of [{ itemId: chain }, { priceListId: retail }, { validFrom: "2020-01-01" }, { tenantId: tenantB }]) {
      expect(await codeOf(() => withTenant(owner, tenantA, (tx) => tx.update(priceListItems).set(change))), JSON.stringify(change)).toBe(DENIED);
    }
    expect(await codeOf(() => withTenant(owner, tenantA, (tx) => tx.update(priceLists).set({ name: "Renamed" })))).toBe(DENIED);
    for (const table of [priceLists, priceListItems, itemPricesByClass, customerPrices]) expect(await codeOf(() => withTenant(owner, tenantA, (tx) => tx.delete(table)))).toBe(DENIED);
  });

  it("keeps each company's prices to itself", async () => {
    const listB = (await createPriceList(otherOwner, "Standard")).id;
    expect(await getPriceList(as.owner, listB, D)).toBeNull();
    await expect(setListPrice(as.owner, listB, { item: pad, price: "1", validFrom: "2026-07-01" })).rejects.toThrow("That price list is not in this company.");
    await expect(setDefaultPriceList(as.owner, listB)).rejects.toThrow("That price list is not in this company.");
    // B cannot price A's item or put A's customer on its list, and sees none of A's prices.
    await expect(setListPrice(otherOwner, listB, { item: pad, price: "1", validFrom: "2026-07-01" })).rejects.toThrow("There is no item with the code");
    await expect(updateParty(as.owner, "customer", retailer, { name: "City Bikes", priceListId: listB })).rejects.toThrow("Choose a price list from the list.");
    expect(await getPriceFor(otherOwner, { itemId: pad, customerId: null, date: D })).toBeNull();
    expect(await withTenant(ownerB, tenantA, (tx) => tx.select().from(priceListItems))).toEqual([]);
    expect(await withTenant(userIds.owner, tenantB, (tx) => tx.select().from(priceLists))).toEqual([]);
    for (const context of [tenantA, tenantB]) {
      expect(
        await codeOf(() => withTenant(userIds.owner, context, (tx) => tx.insert(priceListItems).values({ tenantId: context, priceListId: listB, itemId: pad, price: "1", validFrom: "2026-07-01", createdBy: userIds.owner, updatedBy: userIds.owner }))),
      ).toMatch(/^(42501|23503)$/);
    }
    expect(await admin`select count(*)::int as n from public.price_list_items where tenant_id = ${tenantB}`).toEqual([{ n: 0 }]);
  });
});

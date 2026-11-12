import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, withTenant } from "@/db";
import { UserError } from "@/lib/errors";
import type { TenantContext } from "@/modules/tenant/rules";
import { adminSql, deleteTenants, hasAdminDb, type AdminSql } from "../../../tests/support/admin-db";
import { createParty, importParties, setPartyArchived, updateParty } from "./commands";
import { PARTY_LIST_LIMIT, getParty, listParties } from "./queries";
import { contacts, customers, partyAddresses, suppliers } from "./schema";

// Customers and suppliers against a real database, through the app's own path (app_runtime,
// withTenant, row-level security). Skipped when the database URLs are absent (CI has none).
// Every tax number here is made up: repeated digits that belong to nobody.

const hasDb = hasAdminDb() && Boolean(process.env.DATABASE_URL);
const PREFIX = "zz-party-test";
const tenantA = randomUUID();
const tenantB = randomUUID();
const roles = ["owner", "accountant", "sales_manager", "salesperson", "recovery_officer", "warehouse_manager", "auditor", "payroll_administrator"] as const;
const userIds = Object.fromEntries(roles.map((role) => [role, randomUUID()])) as Record<(typeof roles)[number], string>;
const ownerB = randomUUID();

const ctx = (userId: string, tenantId: string, role: TenantContext["role"]): TenantContext => ({
  userId,
  email: `${role}@party.test`,
  tenantId,
  tenantName: "x",
  role,
  branchIds: null,
});
const as = Object.fromEntries(roles.map((role) => [role, ctx(userIds[role], tenantA, role)])) as Record<(typeof roles)[number], TenantContext>;
const otherOwner = ctx(ownerB, tenantB, "owner");
const DENIED = "42501";
const CHECK = "23514";

let admin: AdminSql;
let khan: string;
let guangzhou: string;

async function codeOf(run: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await run();
    return undefined;
  } catch (error) {
    const e = error as { code?: string; cause?: { code?: string } };
    return e.cause?.code ?? e.code ?? "unknown";
  }
}

const count = async (table: "customers" | "suppliers" | "contacts" | "party_addresses", tenantId = tenantA) =>
  (await admin<{ n: number }[]>`select count(*)::int as n from public.${admin(table)} where tenant_id = ${tenantId}`)[0].n;

/** A file of 500 customers; rows are numbered as a spreadsheet shows them (the heading is row 1). */
function fiveHundred(): string[] {
  const lines = ["Code,Name,NTN,Credit limit,Credit days,Phone,City"];
  for (let i = 1; i <= 500; i++) lines.push(`I${String(i).padStart(4, "0")},Import Customer ${i},,${i % 2 ? "100000" : ""},30,${i % 5 ? "" : "0300-1111111"},${i % 4 ? "" : "Karachi"}`);
  return lines;
}

describe.skipIf(!hasDb)("customers and suppliers", () => {
  beforeAll(async () => {
    admin = adminSql();
    const stale = await admin<{ id: string }[]>`select id from public.tenants where name like ${PREFIX + "%"}`;
    await deleteTenants(
      admin,
      stale.map((r) => r.id),
    );
    await admin`insert into public.tenants (id, name, created_by) values
      (${tenantA}, ${PREFIX + " A"}, ${userIds.owner}), (${tenantB}, ${PREFIX + " B"}, ${ownerB})`;
    await admin`insert into public.memberships ${admin([
      ...roles.map((role) => ({ tenant_id: tenantA, user_id: userIds[role], email: as[role].email, role, created_by: userIds.owner })),
      { tenant_id: tenantB, user_id: ownerB, email: otherOwner.email, role: "owner", created_by: ownerB },
    ])}`;
  });

  afterAll(async () => {
    await deleteTenants(admin, [tenantA, tenantB]);
    await admin.end();
    await closeDb();
  }, 120_000);

  it("adds a customer with its tax fields, contact and address, and writes the audit row", async () => {
    khan = (
      await createParty(as.sales_manager, "customer", {
        code: "C-001",
        name: "Khan Autos",
        registrationType: "registered",
        ntn: "1111111-1",
        cnic: "11111-1111111-1",
        strn: "1111111111111",
        atlStatus: "active",
        province: "Punjab",
        creditLimit: "500000.50",
        creditDays: "30",
        customerClass: "Wholesale",
        withholdingAgent: "on",
        contactName: "Accounts Desk",
        phone: "0300-1111111",
        email: "accounts@khanautos.test",
        address: "12 Circular Road",
        city: "Lahore",
      })
    ).id;
    const [row] = await admin`
      select c.code, c.name, c.registration_type, c.ntn, c.cnic, c.strn, c.atl_status, c.atl_checked_at is not null as checked, c.province,
        c.credit_limit::text, c.credit_days, c.customer_class, c.is_withholding_agent, c.price_list_id, c.created_by, c.archived_at,
        k.name as contact, k.phone, k.email, k.is_primary, a.line, a.city
      from public.customers c
      join public.contacts k on k.customer_id = c.id join public.party_addresses a on a.customer_id = c.id
      where c.id = ${khan}`;
    expect(row).toEqual({
      code: "C-001",
      name: "Khan Autos",
      registration_type: "registered",
      ntn: "1111111-1",
      cnic: "1111111111111",
      strn: "1111111111111",
      atl_status: "active",
      checked: true,
      province: "punjab",
      credit_limit: "500000.5000",
      credit_days: 30,
      customer_class: "Wholesale",
      is_withholding_agent: true,
      price_list_id: null,
      created_by: userIds.sales_manager,
      archived_at: null,
      contact: "Accounts Desk",
      phone: "0300-1111111",
      email: "accounts@khanautos.test",
      is_primary: true,
      line: "12 Circular Road",
      city: "Lahore",
    });
    const [audited] = await admin`select actor_user_id, actor_role, action, entity, before, after from public.audit_log where entity_id = ${khan}`;
    expect(audited).toMatchObject({ actor_user_id: userIds.sales_manager, actor_role: "sales_manager", action: "customer.create", entity: "customer", before: null });
    expect(audited.after).toMatchObject({ name: "Khan Autos", creditLimit: "500000.5000", city: "Lahore", isWithholdingAgent: true });

    // What the screens read back is the same party.
    const read = await getParty(as.salesperson, "customer", khan);
    expect(read?.party).toMatchObject({ name: "Khan Autos", ntn: "1111111-1", creditLimit: "500000.5000", phone: "0300-1111111", city: "Lahore", supplierType: null });
    expect(read?.atlCheckedAt).toBeInstanceOf(Date);
  }, 120_000);

  it("adds a supplier from a name alone, with no contact or address rows", async () => {
    guangzhou = (await createParty(as.accountant, "supplier", { name: "Guangzhou Parts Co" })).id;
    const [row] = await admin`select supplier_type, registration_type, atl_status, atl_checked_at, code from public.suppliers where id = ${guangzhou}`;
    expect(row).toEqual({ supplier_type: "company", registration_type: "unregistered", atl_status: "unknown", atl_checked_at: null, code: null });
    expect(await count("contacts")).toBe(1);
    expect(await count("party_addresses")).toBe(1);
    expect((await getParty(as.warehouse_manager, "supplier", guangzhou))?.party).toMatchObject({ name: "Guangzhou Parts Co", supplierType: "company", creditLimit: null });
  }, 120_000);

  it("refuses a second party with the same name or code, whatever the capitals", async () => {
    await expect(createParty(as.owner, "customer", { name: "KHAN AUTOS" })).rejects.toThrow("A customer with this name already exists.");
    await expect(createParty(as.owner, "customer", { name: "Khan Autos Two", code: "c-001" })).rejects.toThrow("Another customer already has this code.");
    await expect(createParty(as.owner, "customer", { name: "x" })).rejects.toThrow("Enter the name.");
    await expect(createParty(as.owner, "customer", { name: "Bad Tax", cnic: "123" })).rejects.toThrow("CNIC: 13 digits.");
    // The same name may be both a customer and a supplier: they are different lists.
    await createParty(as.owner, "supplier", { name: "Khan Autos", supplierType: "aop" });
    expect(await count("customers")).toBe(1);
    expect(await count("suppliers")).toBe(2);
  }, 120_000);

  it("lets each role do only its part", async () => {
    const customer = { name: "Role Test Customer" };
    const supplier = { name: "Role Test Supplier" };
    for (const role of ["salesperson", "warehouse_manager", "auditor", "payroll_administrator"] as const) {
      await expect(createParty(as[role], "customer", customer), role).rejects.toBeInstanceOf(UserError);
      await expect(updateParty(as[role], "customer", khan, { name: "Renamed" }), role).rejects.toBeInstanceOf(UserError);
      await expect(setPartyArchived(as[role], "customer", khan, true), role).rejects.toBeInstanceOf(UserError);
      await expect(importParties(as[role], "customer", { name: "f.csv", text: "Name\nSomeone\n" }), role).rejects.toBeInstanceOf(UserError);
    }
    // A sales manager looks after customers, not suppliers.
    for (const role of ["sales_manager", "salesperson", "warehouse_manager", "auditor"] as const) {
      await expect(createParty(as[role], "supplier", supplier), role).rejects.toThrow("Only an owner or an accountant can change suppliers.");
    }
    // Reading: sales and the books read customers; the books and the warehouse read suppliers.
    for (const role of ["owner", "accountant", "auditor", "sales_manager", "salesperson", "recovery_officer"] as const) {
      expect((await listParties(as[role], "customer", {})).rows.map((r) => r.name), role).toEqual(["Khan Autos"]);
    }
    await expect(createParty(as.recovery_officer, "customer", customer)).rejects.toBeInstanceOf(UserError);
    await expect(listParties(as.recovery_officer, "supplier", {})).rejects.toThrow("Your role does not include the supplier list.");
    for (const role of ["warehouse_manager", "payroll_administrator"] as const) {
      await expect(listParties(as[role], "customer", {}), role).rejects.toThrow("Your role does not include the customer list.");
      await expect(getParty(as[role], "customer", khan), role).rejects.toBeInstanceOf(UserError);
    }
    expect((await listParties(as.warehouse_manager, "supplier", {})).rows.map((r) => r.name)).toEqual(["Guangzhou Parts Co", "Khan Autos"]);
    for (const role of ["sales_manager", "salesperson", "payroll_administrator"] as const) {
      await expect(listParties(as[role], "supplier", {}), role).rejects.toThrow("Your role does not include the supplier list.");
    }
    expect(await count("customers")).toBe(1);
    expect(await count("suppliers")).toBe(2);
  }, 120_000);

  it("changes a customer and records only what changed, old value and new", async () => {
    const full = (await getParty(as.owner, "customer", khan))!;
    const form = {
      code: "C-001",
      name: "Khan Autos",
      registrationType: "registered",
      ntn: "1111111-1",
      cnic: "1111111111111",
      strn: "1111111111111",
      atlStatus: "active",
      province: "punjab",
      creditLimit: "500000.50",
      creditDays: "30",
      customerClass: "Wholesale",
      withholdingAgent: "on",
      contactName: "Accounts Desk",
      phone: "0300-1111111",
      email: "accounts@khanautos.test",
      address: "12 Circular Road",
      city: "Lahore",
    };
    // Saving the form untouched changes nothing and writes no audit row.
    await updateParty(as.accountant, "customer", khan, form);
    expect(await admin`select 1 from public.audit_log where entity_id = ${khan} and action = 'customer.update'`).toHaveLength(0);

    await updateParty(as.accountant, "customer", khan, { ...form, creditLimit: "750000", creditDays: "45", phone: "0321-2222222", address: "", city: "" });
    const [row] = await admin`
      select c.credit_limit::text, c.credit_days, c.updated_by, c.created_by, c.atl_checked_at, k.phone, k.updated_by as contact_updated_by,
        (select count(*)::int from public.party_addresses a where a.customer_id = c.id) as addresses
      from public.customers c join public.contacts k on k.customer_id = c.id where c.id = ${khan}`;
    expect(row).toMatchObject({
      credit_limit: "750000.0000",
      credit_days: 45,
      updated_by: userIds.accountant,
      created_by: userIds.sales_manager,
      phone: "0321-2222222",
      contact_updated_by: userIds.accountant,
      addresses: 0, // the address was cleared, so its row is gone
    });
    // The status did not change, so the time it was checked did not move.
    expect(new Date(row.atl_checked_at as string).getTime()).toBe(full.atlCheckedAt!.getTime());
    const [audited] = await admin`select actor_role, before, after from public.audit_log where entity_id = ${khan} and action = 'customer.update'`;
    expect(audited).toEqual({
      actor_role: "accountant",
      before: { creditLimit: "500000.5000", creditDays: 30, phone: "0300-1111111", address: "12 Circular Road", city: "Lahore" },
      after: { creditLimit: "750000.0000", creditDays: 45, phone: "0321-2222222", address: null, city: null },
    });

    // A status change moves the check time; back to unknown clears it. An address typed again comes back.
    await updateParty(as.owner, "customer", khan, { ...form, creditLimit: "750000", creditDays: "45", phone: "0321-2222222", atlStatus: "inactive" });
    const moved = (await getParty(as.owner, "customer", khan))!;
    expect(moved.party.atlStatus).toBe("inactive");
    expect(moved.atlCheckedAt!.getTime()).toBeGreaterThan(full.atlCheckedAt!.getTime());
    expect(moved.party.city).toBe("Lahore");
    await updateParty(as.owner, "customer", khan, { ...form, creditLimit: "750000", creditDays: "45", phone: "0321-2222222", atlStatus: "" });
    expect((await getParty(as.owner, "customer", khan))!.atlCheckedAt).toBeNull();

    await expect(updateParty(as.owner, "customer", khan, { ...form, name: "" })).rejects.toThrow("Enter the name.");

    // A form opened before someone else's change is refused: saved, it would undo that change.
    const current = { ...form, creditLimit: "750000", creditDays: "45", phone: "0321-2222222", atlStatus: "" };
    const opened = (await getParty(as.owner, "customer", khan))!.updatedAt.toISOString();
    await updateParty(as.owner, "customer", khan, { ...current, creditLimit: "900000" }, opened);
    await expect(updateParty(as.accountant, "customer", khan, { ...current, creditDays: "60" }, opened)).rejects.toThrow(
      "Someone else changed this customer while you had it open. Reload the page to see their change, then make yours.",
    );
    const kept = (await getParty(as.owner, "customer", khan))!;
    expect([kept.party.creditLimit, kept.party.creditDays]).toEqual(["900000.0000", 45]);
    // Reloaded, the same change goes through, and the limit goes back for the tests that follow.
    await updateParty(as.accountant, "customer", khan, { ...current, creditLimit: "900000", creditDays: "60" }, kept.updatedAt.toISOString());
    await updateParty(as.owner, "customer", khan, current);
    await expect(updateParty(as.owner, "customer", randomUUID(), form)).rejects.toThrow("That customer is not in this company.");
    await expect(updateParty(as.owner, "customer", "not-an-id", form)).rejects.toThrow("That customer is not in this company.");
    await expect(updateParty(as.owner, "supplier", guangzhou, { name: "Khan Autos" })).rejects.toThrow("A supplier with this name already exists.");
  }, 120_000);

  it("archives and restores without deleting anything", async () => {
    await setPartyArchived(as.sales_manager, "customer", khan, true);
    await setPartyArchived(as.sales_manager, "customer", khan, true); // twice is once
    expect((await listParties(as.owner, "customer", {})).rows).toEqual([]);
    expect((await listParties(as.owner, "customer", { archived: true })).rows.map((r) => r.name)).toEqual(["Khan Autos"]);
    const [row] = await admin`select archived_at is not null as archived, archived_by from public.customers where id = ${khan}`;
    expect(row).toEqual({ archived: true, archived_by: userIds.sales_manager });
    // Still there to open, its name is still taken, and it cannot be changed until restored.
    expect((await getParty(as.owner, "customer", khan))?.archivedAt).toBeInstanceOf(Date);
    await expect(createParty(as.owner, "customer", { name: "Khan Autos" })).rejects.toThrow("A customer with this name already exists.");
    await expect(updateParty(as.owner, "customer", khan, { name: "Khan Autos Ltd" })).rejects.toThrow("Restore the customer before changing it.");

    await setPartyArchived(as.owner, "customer", khan, false);
    expect((await listParties(as.owner, "customer", {})).rows.map((r) => r.name)).toEqual(["Khan Autos"]);
    expect(await admin`select archived_at, archived_by from public.customers where id = ${khan}`).toEqual([{ archived_at: null, archived_by: null }]);
    const audited = await admin`
      select actor_role, action, after->>'archived' as archived from public.audit_log
      where entity_id = ${khan} and action in ('customer.archive', 'customer.restore') order by at`;
    expect(audited).toEqual([
      { actor_role: "sales_manager", action: "customer.archive", archived: "true" },
      { actor_role: "owner", action: "customer.restore", archived: "false" },
    ]);
    await expect(setPartyArchived(as.owner, "supplier", khan, true)).rejects.toThrow("That supplier is not in this company.");
  }, 120_000);

  it("imports nothing from 500 rows when 3 are bad, and lists the 3", async () => {
    const lines = fiveHundred();
    lines[120] = "I0120,,,,30,,"; // row 121: no name
    lines[250] = "I0250,Import Customer 250,12345,,30,,"; // row 251: an NTN that is not an NTN
    lines[400] = "I0400,khan autos,,,30,,"; // row 401: a customer who already exists
    const before = { customers: await count("customers"), contacts: await count("contacts"), addresses: await count("party_addresses") };

    // All three are listed at once, whether a row is wrong in itself or names a customer already there. Nothing is written.
    expect(await importParties(as.accountant, "customer", { name: "customers.csv", text: lines.join("\n") })).toEqual({
      problems: [
        { row: 121, name: "", problems: ["Enter the name."] },
        { row: 251, name: "Import Customer 250", problems: ["NTN: 7 digits, with or without the check digit, such as 1234567-8."] },
        { row: 401, name: "khan autos", problems: ["A customer with this name already exists."] },
      ],
    });
    lines[120] = "I0120,Import Customer 120,,,30,,";
    lines[250] = "I0250,Import Customer 250,1111111,,30,,";
    expect({ customers: await count("customers"), contacts: await count("contacts"), addresses: await count("party_addresses") }).toEqual(before);
    expect(await admin`select 1 from public.audit_log where tenant_id = ${tenantA} and action = 'customer.import'`).toHaveLength(0);

    // All three put right: every row arrives, with its contact and address where it has one.
    lines[400] = "I0400,Import Customer 400,,,30,,Karachi";
    expect(await importParties(as.accountant, "customer", { name: "customers.csv", text: lines.join("\n") })).toEqual({ imported: 500 });
    expect(await count("customers")).toBe(before.customers + 500);
    // Every fifth row has a phone and every fourth a city; the three rewritten rows lost three phones and one city.
    expect(await count("contacts")).toBe(before.contacts + 97);
    expect(await count("party_addresses")).toBe(before.addresses + 124);
    const [sample] = await admin`
      select c.code, c.credit_limit::text, c.credit_days, c.ntn, c.created_by, k.phone, a.city from public.customers c
      left join public.contacts k on k.customer_id = c.id left join public.party_addresses a on a.customer_id = c.id
      where c.tenant_id = ${tenantA} and c.name = 'Import Customer 20'`;
    expect(sample).toEqual({ code: "I0020", credit_limit: null, credit_days: 30, ntn: null, created_by: userIds.accountant, phone: "0300-1111111", city: "Karachi" });
    const audited = await admin`select actor_role, entity, entity_id, after from public.audit_log where tenant_id = ${tenantA} and action = 'customer.import'`;
    expect(audited).toHaveLength(1);
    expect(audited[0]).toMatchObject({ actor_role: "accountant", entity: "customer", entity_id: null, after: { rows: 500, file: "customers.csv" } });
    // The audit row names every customer the import made.
    const imported = await admin<{ id: string }[]>`select id from public.customers where tenant_id = ${tenantA} and name like 'Import Customer %'`;
    expect([...(audited[0].after.ids as string[])].sort()).toEqual(imported.map((r) => r.id).sort());

    // The same file again adds nothing: every row now names a customer who exists.
    const again = await importParties(as.owner, "customer", { name: "customers.csv", text: lines.join("\n") });
    expect("problems" in again && again.problems.length).toBe(500);
    expect(await count("customers")).toBe(before.customers + 500);
    // A file that cannot be read at all is refused outright.
    await expect(importParties(as.owner, "customer", { name: "x.csv", text: "City\nLahore\n" })).rejects.toThrow('The file needs a "Name" column in its first row.');
  }, 120_000);

  it("lists by name, searches, and says when there are more than it shows", async () => {
    const all = await listParties(as.auditor, "customer", {});
    expect(all.rows).toHaveLength(PARTY_LIST_LIMIT);
    expect(all.more).toBe(true);
    const found = async (search: string) => (await listParties(as.salesperson, "customer", { search })).rows.map((r) => r.name);
    expect(await found("khan")).toEqual(["Khan Autos"]);
    expect(await found("c-001")).toEqual(["Khan Autos"]); // by code
    expect(await found("0321-2222")).toEqual(["Khan Autos"]); // by phone
    expect(await found("lahore")).toEqual(["Khan Autos"]); // by city
    expect(await found("Import Customer 49")).toEqual(["Import Customer 49", "Import Customer 490", ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => `Import Customer 49${n}`)]);
    // What is typed is looked for as it is: a percent sign is not "anything".
    expect(await found("%")).toEqual([]);
    expect(await found("nobody by this name")).toEqual([]);
    const khanRow = (await listParties(as.owner, "customer", { search: "Khan Autos" })).rows[0];
    expect([khanRow.creditLimit?.toFixed(2), khanRow.creditDays, khanRow.customerClass, khanRow.city]).toEqual(["750000.00", 45, "Wholesale", "Lahore"]);
  }, 120_000);

  it("imports suppliers with their own columns", async () => {
    const csv = "Name,Supplier type,Registration,STRN,Province,Credit days,Contact person,Email\nShenzhen Bearings,Company,,,,60,Li Wei,sales@shenzhen.test\nAnwar & Brothers,AOP,Registered,1111111111111,Sindh,15,,\n";
    await expect(importParties(as.sales_manager, "supplier", { name: "s.csv", text: csv })).rejects.toThrow("Only an owner or an accountant can change suppliers.");
    expect(await importParties(as.owner, "supplier", { name: "s.csv", text: csv })).toEqual({ imported: 2 });
    const rows = await admin`
      select s.name, s.supplier_type, s.registration_type, s.strn, s.province, s.credit_days, k.name as contact, k.email from public.suppliers s
      left join public.contacts k on k.supplier_id = s.id where s.tenant_id = ${tenantA} and s.name in ('Shenzhen Bearings', 'Anwar & Brothers') order by s.name`;
    expect(rows).toEqual([
      { name: "Anwar & Brothers", supplier_type: "aop", registration_type: "registered", strn: "1111111111111", province: "sindh", credit_days: 15, contact: null, email: null },
      { name: "Shenzhen Bearings", supplier_type: "company", registration_type: "unregistered", strn: null, province: null, credit_days: 60, contact: "Li Wei", email: "sales@shenzhen.test" },
    ]);
  }, 120_000);

  it("keeps the same rules in the database, whatever the app does", async () => {
    const by = (who: string) => ({ createdBy: who, updatedBy: who });
    // Roles that may not write cannot insert; roles that may not read see no rows.
    for (const role of ["salesperson", "warehouse_manager", "auditor"] as const) {
      expect(await codeOf(() => withTenant(userIds[role], tenantA, (tx) => tx.insert(customers).values({ tenantId: tenantA, name: "Direct", ...by(userIds[role]) }))), role).toBe(DENIED);
      expect(await codeOf(() => withTenant(userIds[role], tenantA, (tx) => tx.insert(suppliers).values({ tenantId: tenantA, name: "Direct", ...by(userIds[role]) }))), role).toBe(DENIED);
    }
    expect(await codeOf(() => withTenant(userIds.sales_manager, tenantA, (tx) => tx.insert(suppliers).values({ tenantId: tenantA, name: "Direct", ...by(userIds.sales_manager) })))).toBe(DENIED);
    for (const role of ["warehouse_manager", "payroll_administrator"] as const) {
      expect(await withTenant(userIds[role], tenantA, (tx) => tx.select().from(customers)), role).toEqual([]);
      expect(await withTenant(userIds[role], tenantA, (tx) => tx.select({ id: contacts.id }).from(contacts)), role).toHaveLength(role === "warehouse_manager" ? 1 : 0);
    }
    for (const role of ["sales_manager", "salesperson"] as const) {
      expect(await withTenant(userIds[role], tenantA, (tx) => tx.select().from(suppliers)), role).toEqual([]);
      // They read customers' contacts and addresses, never a supplier's.
      const seen = await withTenant(userIds[role], tenantA, (tx) => tx.select({ supplierId: contacts.supplierId }).from(contacts));
      expect(seen.length, role).toBeGreaterThan(0);
      expect(seen.every((row) => row.supplierId === null), role).toBe(true);
    }
    // An owner may not sign as someone else, break a format, or rewrite who created a row or whose it is.
    const owner = userIds.owner;
    expect(await codeOf(() => withTenant(owner, tenantA, (tx) => tx.insert(customers).values({ tenantId: tenantA, name: "Direct", createdBy: ownerB, updatedBy: owner })))).toBe(DENIED);
    for (const bad of [{ cnic: "123" }, { ntn: "12345" }, { strn: "1111111111111" }, { creditDays: 400 }, { creditLimit: "-1" }, { name: "x" }, { atlStatus: "active" as const }]) {
      expect(await codeOf(() => withTenant(owner, tenantA, (tx) => tx.insert(customers).values({ tenantId: tenantA, name: "Direct", ...bad, ...by(owner) }))), JSON.stringify(bad)).toBe(CHECK);
    }
    for (const change of [{ tenantId: tenantB }, { createdBy: ownerB }]) {
      expect(await codeOf(() => withTenant(owner, tenantA, (tx) => tx.update(customers).set(change))), JSON.stringify(change)).toBe(DENIED);
    }
    // A customer's price list must be one of the company's own.
    expect(await codeOf(() => withTenant(owner, tenantA, (tx) => tx.update(customers).set({ priceListId: randomUUID(), updatedBy: owner })))).toBe("23503");
    // Nothing deletes a party; a contact belongs to exactly one party of this company.
    expect(await codeOf(() => withTenant(owner, tenantA, (tx) => tx.delete(customers)))).toBe(DENIED);
    expect(await codeOf(() => withTenant(owner, tenantA, (tx) => tx.delete(suppliers)))).toBe(DENIED);
    expect(await codeOf(() => withTenant(owner, tenantA, (tx) => tx.insert(contacts).values({ tenantId: tenantA, name: "Nobody's", ...by(owner) })))).toBe(CHECK);
    expect(
      await codeOf(() => withTenant(owner, tenantA, (tx) => tx.insert(contacts).values({ tenantId: tenantA, customerId: khan, supplierId: guangzhou, name: "Both", isPrimary: false, ...by(owner) }))),
    ).toBe(CHECK);
    expect(await codeOf(() => withTenant(owner, tenantA, (tx) => tx.insert(contacts).values({ tenantId: tenantA, customerId: khan, name: "Second primary", ...by(owner) })))).toBe("23505");
    expect(await codeOf(() => withTenant(owner, tenantA, (tx) => tx.insert(partyAddresses).values({ tenantId: tenantA, customerId: khan, isPrimary: false, ...by(owner) })))).toBe(CHECK);
    expect(await admin`select 1 from public.customers where tenant_id = ${tenantA} and name = 'Direct'`).toHaveLength(0);
  }, 120_000);

  it("keeps each company's customers and suppliers to itself", async () => {
    // The other company may use the same names and codes.
    const theirs = (await createParty(otherOwner, "customer", { name: "Khan Autos", code: "C-001", phone: "0333-3333333" })).id;
    expect((await listParties(otherOwner, "customer", {})).rows.map((r) => r.name)).toEqual(["Khan Autos"]);
    expect(await count("customers", tenantB)).toBe(1);

    // A never sees B's customer, by list, by id, or with B's id as the context; and cannot change it.
    expect((await listParties(as.owner, "customer", { search: "0333-3333333" })).rows).toEqual([]);
    expect(await getParty(as.owner, "customer", theirs)).toBeNull();
    expect(await withTenant(userIds.owner, tenantB, (tx) => tx.select().from(customers))).toEqual([]);
    expect(await withTenant(userIds.owner, tenantB, (tx) => tx.select().from(contacts))).toEqual([]);
    await expect(updateParty(as.owner, "customer", theirs, { name: "Taken over" })).rejects.toThrow("That customer is not in this company.");
    await expect(setPartyArchived(as.owner, "customer", theirs, true)).rejects.toThrow("That customer is not in this company.");
    // Nor hang a contact on it, as A or as B.
    for (const context of [tenantA, tenantB]) {
      expect(
        await codeOf(() =>
          withTenant(userIds.owner, context, (tx) =>
            tx.insert(contacts).values({ tenantId: context, customerId: theirs, name: "Planted", isPrimary: false, createdBy: userIds.owner, updatedBy: userIds.owner }),
          ),
        ),
      ).toMatch(/^(42501|23503)$/);
    }
    const [untouched] = await admin`select name, archived_at from public.customers where id = ${theirs}`;
    expect(untouched).toEqual({ name: "Khan Autos", archived_at: null });
  }, 120_000);
});

import { randomUUID } from "node:crypto";
import ExcelJS from "exceljs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb } from "@/db";
import { addUnit } from "@/modules/items/commands";
import { seedAccounts } from "@/modules/ledger/commands";
import { openFiscalYear } from "@/modules/numbering/commands";
import { startOpening } from "@/modules/opening/commands";
import type { TenantContext } from "@/modules/tenant/rules";
import { adminSql, deleteTenants, hasAdminDb, type AdminSql } from "../../../tests/support/admin-db";
import { previewImport, readFileForMapping, runImport, type ImportAsk } from "./commands";
import type { DataImportKind } from "./rules";

// Step 49 against a real database, through the app's own path (app_runtime, withTenant,
// row-level security): a file from another system, matched, checked without keeping anything,
// imported all or nothing, recorded, and never imported twice. Every name and figure here is
// made up. Skipped when the database URLs are absent.

const hasDb = hasAdminDb() && Boolean(process.env.DATABASE_URL);
const PREFIX = "zz-data-import-test";
const tenantA = randomUUID();
const roles = ["owner", "accountant", "auditor", "salesperson"] as const;
const userIds = Object.fromEntries(roles.map((role) => [role, randomUUID()])) as Record<(typeof roles)[number], string>;
const branch = randomUUID();
const ctx = (userId: string, role: TenantContext["role"]): TenantContext => ({ userId, email: `${role}-${userId.slice(0, 4)}@import.test`, tenantId: tenantA, tenantName: "x", role, branchIds: null });
const as = Object.fromEntries(roles.map((role) => [role, ctx(userIds[role], role)])) as Record<(typeof roles)[number], TenantContext>;

let admin: AdminSql;

async function workbook(rows: (string | number | Date | null)[][]): Promise<Uint8Array> {
  const book = new ExcelJS.Workbook();
  book.addWorksheet("Export").addRows(rows);
  return new Uint8Array((await book.xlsx.writeBuffer()) as ArrayBuffer);
}
const csv = (lines: string[]) => new TextEncoder().encode(lines.join("\r\n"));

/** What the form sends: the file, and for each of our columns the index of the file's column. */
function ask(kind: DataImportKind, name: string, bytes: Uint8Array, mapping: Record<string, number>, extra: Partial<ImportAsk> & { leftOut?: string } = {}): ImportAsk {
  const fields: Record<string, string> = { leftOut: extra.leftOut ?? "" };
  for (const [key, index] of Object.entries(mapping)) fields[`map_${key}`] = String(index);
  return { kind, file: { name, bytes }, field: (field) => fields[field] ?? "", ...extra };
}

const count = async (table: string) => (await admin.unsafe<{ n: number }[]>(`select count(*)::int as n from public.${table} where tenant_id = $1`, [tenantA]))[0].n;

describe.skipIf(!hasDb)("importing a company's data from another system", () => {
  beforeAll(async () => {
    admin = adminSql();
    const stale = await admin<{ id: string }[]>`select id from public.tenants where name like ${PREFIX + "%"}`;
    await deleteTenants(admin, stale.map((r) => r.id));
    await admin`insert into public.tenants (id, name, created_by) values (${tenantA}, ${PREFIX + " A"}, ${userIds.owner})`;
    await admin`insert into public.branches (id, tenant_id, name, created_by) values (${branch}, ${tenantA}, 'Main', ${userIds.owner})`;
    await admin`insert into public.memberships ${admin(roles.map((role) => ({ tenant_id: tenantA, user_id: userIds[role], email: as[role].email, role, branch_ids: null, created_by: userIds.owner })))}`;
    await admin`insert into public.warehouses (id, tenant_id, branch_id, name, created_by) values (${randomUUID()}, ${tenantA}, ${branch}, 'Main store', ${userIds.owner}), (${randomUUID()}, ${tenantA}, ${branch}, 'City godown', ${userIds.owner})`;
    await seedAccounts(as.owner, "trading");
    await openFiscalYear(as.owner, { month: "7", year: "2026" });
    await addUnit(as.owner, { code: "pc", name: "Piece" });
  });

  afterAll(async () => {
    await deleteTenants(admin, [tenantA]);
    await admin.end();
    await closeDb();
  });

  // An old system's customer list: its name and the date above the headings, its own headings,
  // and a total at the bottom. Made once: a workbook made again carries another time inside it.
  let made: Promise<Uint8Array> | null = null;
  const customersFile = () =>
    (made ??= workbook([
      ["Old Ledger Pro - Customer List"],
      ["Printed on", new Date(Date.UTC(2026, 10, 20))],
      [],
      ["Cust Code", "Customer Name", "Mobile No", "City", "Opening"],
      ["C-101", "Zeta Traders", "0300-0000001", "Lahore", 1500],
      ["C-102", "Eta Autos", "0300-0000002", "Multan", 0],
      ["C-103", "Theta Store", null, "Karachi", 250.5],
      [null, "Total", null, null, 1750.5],
    ]));

  it("reads where the headings are and guesses the columns, from the headings other systems give them", async () => {
    const read = await readFileForMapping(as.owner, "customers", { name: "customers.xlsx", bytes: await customersFile() });
    expect(read.headingRow).toBe(4);
    expect(read.headings).toEqual(["Cust Code", "Customer Name", "Mobile No", "City", "Opening"]);
    // "Customer Name" and "Mobile No" are headings other systems use; "Cust Code" is not guessed at.
    expect(read.mapping).toMatchObject({ code: null, name: 1, phone: 2, city: 3 });
    expect(read.remembered).toBe(false);
    expect(read.sample[0]).toEqual({ row: 5, cells: ["C-101", "Zeta Traders", "0300-0000001", "Lahore", "1500"] });
  });

  it("checks a file without keeping anything, names each problem by the file's own row, and imports it all or nothing", async () => {
    const bytes = await customersFile();
    const mapping = { code: 0, name: 1, phone: 2, city: 3 };
    // A column matched wrongly: the phone numbers read as credit limits. Each row is named by its row in the file.
    const wrong = await previewImport(as.owner, ask("customers", "customers.xlsx", bytes, { code: 0, name: 1, creditLimit: 2, city: 3 }));
    expect(wrong.status).toBe("problems");
    if (wrong.status === "problems") expect(wrong.problems.map((problem) => problem.row)).toEqual([5, 6]);
    expect(await count("customers")).toBe(0);
    // The total row has no code but a name: left in, it would be a customer called "Total", and the sample shows it.
    const withTotal = await previewImport(as.owner, ask("customers", "customers.xlsx", bytes, mapping));
    expect(withTotal).toMatchObject({ status: "ready", count: 4 });
    expect(withTotal.sample.at(-1)).toEqual({ row: 8, cells: ["", "Total", "", ""] });

    const ready = await previewImport(as.owner, ask("customers", "customers.xlsx", bytes, mapping, { leftOut: "8" }));
    expect(ready).toMatchObject({ status: "ready", count: 3, before: null, columns: ["Code", "Name", "Phone", "City"] });
    expect(ready.sample.map((row) => row.row)).toEqual([5, 6, 7]);
    expect(await count("customers")).toBe(0);
    expect(await count("data_imports")).toBe(0);

    const done = await runImport(as.owner, ask("customers", "customers.xlsx", bytes, mapping, { leftOut: "8" }));
    expect(done).toEqual({ status: "imported", imported: 3, location: null });
    const kept = await admin`
      select c.code, c.name, k.phone, a.city from public.customers c
      left join public.contacts k on k.tenant_id = c.tenant_id and k.customer_id = c.id
      left join public.party_addresses a on a.tenant_id = c.tenant_id and a.customer_id = c.id
      where c.tenant_id = ${tenantA} order by c.code`;
    expect(kept.map((row) => ({ ...row }))).toEqual([
      { code: "C-101", name: "Zeta Traders", phone: "0300-0000001", city: "Lahore" },
      { code: "C-102", name: "Eta Autos", phone: "0300-0000002", city: "Multan" },
      { code: "C-103", name: "Theta Store", phone: null, city: "Karachi" },
    ]);
    const [recorded] = await admin`select kind, file_name, rows, mapping, created_by from public.data_imports where tenant_id = ${tenantA}`;
    expect({ ...recorded }).toEqual({ kind: "customers", file_name: "customers.xlsx", rows: 3, mapping: { code: "Cust Code", name: "Customer Name", phone: "Mobile No", city: "City" }, created_by: userIds.owner });
    const [audited] = await admin`select action, after->>'rows' as rows from public.audit_log where tenant_id = ${tenantA} and action = 'customer.import'`;
    expect({ ...audited }).toEqual({ action: "customer.import", rows: "3" });
  });

  it("never imports the same rows twice: the same file again is known, and every row is refused", async () => {
    const again = await previewImport(as.owner, ask("customers", "customers again.xlsx", await customersFile(), { code: 0, name: 1, phone: 2, city: 3 }, { leftOut: "8" }));
    expect(again.before).toEqual({ on: expect.stringMatching(/^\d{2}-\d{2}-\d{4}$/), rows: 3 });
    expect(again.status).toBe("problems");
    if (again.status === "problems") {
      expect(again.problems.map((problem) => problem.row)).toEqual([5, 6, 7]);
      expect(again.problems[0].problems).toContain("A customer with this name already exists.");
    }
    const done = await runImport(as.owner, ask("customers", "customers again.xlsx", await customersFile(), { code: 0, name: 1, phone: 2, city: 3 }, { leftOut: "8" }));
    expect(done.status).toBe("problems");
    expect(await count("customers")).toBe(3);
    expect(await count("data_imports")).toBe(1);
  });

  it("offers the last mapping of a kind for its next file, by the file's headings", async () => {
    const next = csv(["Customer Name,Cust Code,City", "Iota Mart,C-104,Quetta"]);
    const read = await readFileForMapping(as.accountant, "customers", { name: "more.csv", bytes: next });
    expect(read.remembered).toBe(true);
    expect(read.mapping).toMatchObject({ name: 0, code: 1, city: 2, phone: null });
  });

  it("brings items in, then each warehouse's opening stock from one file, as a draft for each, and never twice", async () => {
    const items = await workbook([
      ["Item Code", "Item Name", "UOM", "Sale Rate"],
      ["P-1", "Brake pad", "Piece", 950],
      ["P-2", "Oil filter", "Piece", 420],
    ]);
    expect(await runImport(as.accountant, ask("items", "items.xlsx", items, { code: 0, name: 1, unit: 2, defaultPrice: 3 }))).toMatchObject({ status: "imported", imported: 2 });

    const stock = await workbook([
      ["Godown", "Item Code", "Closing Qty", "Avg Cost"],
      ["Main store", "P-1", 10, 600],
      ["City godown", "P-1", 4, 600],
      ["City godown", "P-2", 25, 275.25],
    ]);
    const stockAsk = () => ask("opening_stock", "stock.xlsx", stock, { warehouse: 0, code: 1, quantity: 2, cost: 3 }, { date: "2026-07-01", warehouseId: "", note: "" });
    expect(await previewImport(as.accountant, stockAsk())).toMatchObject({ status: "ready", count: 3 });
    expect(await count("stock_adjustments")).toBe(0);
    const done = await runImport(as.accountant, stockAsk());
    expect(done).toEqual({ status: "imported", imported: 3, location: "/stock/adjustments" });
    const drafts = await admin`
      select w.name, a.status, count(l.*)::int as lines from public.stock_adjustments a
      join public.warehouses w on w.tenant_id = a.tenant_id and w.id = a.warehouse_id
      join public.stock_adjustment_lines l on l.tenant_id = a.tenant_id and l.adjustment_id = a.id
      where a.tenant_id = ${tenantA} and a.kind = 'opening' group by w.name, a.status order by w.name`;
    expect(drafts.map((row) => ({ ...row }))).toEqual([
      { name: "City godown", status: "draft", lines: 2 },
      { name: "Main store", status: "draft", lines: 1 },
    ]);

    const again = await runImport(as.accountant, stockAsk());
    expect(again.status).toBe("problems");
    if (again.status === "problems") {
      expect(again.problems.map((problem) => problem.row)).toEqual([2, 3, 4]);
      expect(again.problems[0].problems[0]).toContain("already has opening stock in this warehouse, in a draft");
    }
    expect(await count("stock_adjustments")).toBe(2);

    // A warehouse the company does not have is named.
    const unknown = csv(["Warehouse,Item code,Quantity,Unit cost", "Back room,P-2,1,1"]);
    const refused = await previewImport(as.accountant, ask("opening_stock", "stock.csv", unknown, { warehouse: 0, code: 1, quantity: 2, cost: 3 }, { date: "2026-07-01" }));
    expect(refused).toMatchObject({ status: "problems", problems: [{ row: 2, problems: ['There is no warehouse named "Back room". Add it first, or correct the name.'] }] });
  });

  it("brings a trial balance onto the opening entry by our account codes, and names a wrong row by the file's row", async () => {
    await startOpening(as.owner, { date: "2026-07-01" });
    const tb = await workbook([
      ["Trial Balance as on 30-06-2026"],
      [],
      ["A/C Code", "Particulars", "Dr", "Cr"],
      ["1111", "Cash in hand", 85000, null],
      ["3100", "Owner's capital", null, 85000],
      ["1999", "Suspense", 10, null],
    ]);
    const mapping = { code: 0, name: 1, debit: 2, credit: 3 };
    const checked = await previewImport(as.owner, ask("ledger_balances", "tb.xlsx", tb, mapping));
    expect(checked).toMatchObject({ status: "problems", problems: [{ row: 6, problems: ["No account has the code 1999. Add it under Settings, Accounts, or correct the code."] }] });
    const done = await runImport(as.owner, ask("ledger_balances", "tb.xlsx", tb, mapping, { leftOut: "6" }));
    expect(done).toEqual({ status: "imported", imported: 2, location: null });
    expect((await admin`select count(*)::int as n from public.opening_balances where tenant_id = ${tenantA} and kind = 'account'`)[0].n).toBe(2);
  });

  it("is for the owner and an accountant, and refuses a column chosen twice or a needed one left out", async () => {
    const file = { name: "c.csv", bytes: csv(["Name", "Kappa"]) };
    await expect(readFileForMapping(as.salesperson, "customers", file)).rejects.toThrow("Only an owner or an accountant can import a company's data.");
    await expect(readFileForMapping(as.auditor, "customers", file)).rejects.toThrow("Only an owner or an accountant can import a company's data.");
    await expect(previewImport(as.owner, ask("customers", "c.csv", file.bytes, { name: 0, code: 0 }))).rejects.toThrow('The column "Name" is chosen for both "Code" and "Name". Choose one column of the file for each.');
    await expect(previewImport(as.owner, ask("customers", "c.csv", file.bytes, { code: 0 }))).rejects.toThrow('Choose the column of the file that holds "Name": it is needed.');
    // The record is the owner's and the accountant's to write, and the auditor's to read.
    expect(await count("data_imports")).toBe(4);
  });
});

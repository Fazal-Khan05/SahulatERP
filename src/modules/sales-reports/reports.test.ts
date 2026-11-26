import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb } from "@/db";
import { postCreditNote, saveCreditNoteDraft, startCreditNote } from "@/modules/credit-notes/commands";
import { setBaseCurrency } from "@/modules/currencies/commands";
import { postAdjustment, saveAdjustmentDraft } from "@/modules/inventory/commands";
import { addUnit, createItem } from "@/modules/items/commands";
import { seedAccounts } from "@/modules/ledger/commands";
import { openFiscalYear } from "@/modules/numbering/commands";
import { createParty } from "@/modules/parties/commands";
import type { Cell, ReportTable } from "@/modules/reports/rules";
import { postInvoice, saveInvoiceDraft, saveSalesDraft, startInvoice, submitSalesDocument } from "@/modules/sales/commands";
import { getSalesDocument } from "@/modules/sales/queries";
import { getStockReport } from "@/modules/stock-reports/queries";
import { readStockFilter } from "@/modules/stock-reports/rules";
import type { TenantContext } from "@/modules/tenant/rules";
import { adminSql, deleteTenants, hasAdminDb, type AdminSql } from "../../../tests/support/admin-db";
import { getSalesReport } from "./queries";
import { readSalesFilter, type SalesReportKey } from "./rules";

// The sales analysis against a real database, through the app's own path: invoices (one shared
// between two salespeople, one in another branch), a credit note on the shared one, then every
// report read back to the paisa, with each total agreeing with the Sales account in the books
// and the cost columns agreeing with Item profit. Skipped without the database URLs.

const hasDb = hasAdminDb() && Boolean(process.env.DATABASE_URL);
const PREFIX = "zz-sales-reports-test";
const tenantA = randomUUID();
const roles = ["owner", "accountant", "auditor", "sales_manager", "salesperson", "warehouse_manager"] as const;
const userIds = Object.fromEntries(roles.map((role) => [role, randomUUID()])) as Record<(typeof roles)[number], string>;
const northAccountant = randomUUID();
const mainBranch = randomUUID();
const northBranch = randomUUID();
const mainStore = randomUUID();
const northStore = randomUUID();
const ctx = (userId: string, role: TenantContext["role"], branchIds: string[] | null = null): TenantContext => ({ userId, email: `${role}-${userId.slice(0, 4)}@sales-reports.test`, tenantId: tenantA, tenantName: "x", role, branchIds });
const as = Object.fromEntries(roles.map((role) => [role, ctx(userIds[role], role)])) as Record<(typeof roles)[number], TenantContext>;
const north = ctx(northAccountant, "accountant", [northBranch]);
const TODAY = "2026-12-20";

let admin: AdminSql;
let helmet: string;
let chain: string;
let khan: string;
let bilal: string;
let walk: string;

const report = (who: TenantContext, key: SalesReportKey, raw: Record<string, string> = {}) =>
  getSalesReport(who, key, readSalesFilter({ from: "2026-11-01", to: "2026-11-30", ...raw }, { yearStart: "2026-07-01", today: TODAY }));
const text = (cell: Cell) => (cell === null ? "" : typeof cell === "string" ? cell : cell.toFixed(2));
const shown = (table: ReportTable) => table.rows.map((row) => row.cells.map(text).join(" | "));
const add = (itemCode: string, quantity: string, unitCost: string) => ({ itemCode, direction: "in", quantity, unitCost });

/** An order for the lines, invoiced and posted in one go (the invoice delivers as it bills), with the sellers' shares. */
async function sell(date: string, customerId: string, warehouseId: string, items: [string, string][], shares: { userId: string; percent: string }[] = []): Promise<string> {
  const { id } = await saveSalesDraft(as.owner, null, { kind: "order", date, customerId, warehouseId, lines: items.map(([itemId, quantity]) => ({ itemId, quantity, unitId: "", unitPrice: "", discountPercent: "", description: "" })), shares });
  await submitSalesDocument(as.owner, id);
  const { id: invoice } = await startInvoice(as.owner, id);
  const draft = (await getSalesDocument(as.owner, invoice))!;
  await saveInvoiceDraft(as.owner, invoice, { date, lines: draft.lines.map((l) => ({ sourceLineId: l.sourceLineId, quantity: l.quantity.toFixed() })) });
  await postInvoice(as.owner, invoice);
  return invoice;
}

describe.skipIf(!hasDb)("sales reports", { timeout: 600_000 }, () => {
  beforeAll(async () => {
    admin = adminSql();
    const stale = await admin<{ id: string }[]>`select id from public.tenants where name like ${PREFIX + "%"}`;
    await deleteTenants(admin, stale.map((r) => r.id));
    await admin`insert into public.tenants (id, name, created_by) values (${tenantA}, ${PREFIX + " A"}, ${userIds.owner})`;
    await admin`insert into public.branches (id, tenant_id, name, created_by) values (${mainBranch}, ${tenantA}, 'Main', ${userIds.owner}), (${northBranch}, ${tenantA}, 'North', ${userIds.owner})`;
    await admin`insert into public.warehouses (id, tenant_id, branch_id, name, created_by) values (${mainStore}, ${tenantA}, ${mainBranch}, 'Main store', ${userIds.owner}), (${northStore}, ${tenantA}, ${northBranch}, 'North store', ${userIds.owner})`;
    await admin`insert into public.memberships ${admin([
      ...roles.map((role) => ({ tenant_id: tenantA, user_id: userIds[role], email: as[role].email, role, branch_ids: null, created_by: userIds.owner })),
      { tenant_id: tenantA, user_id: northAccountant, email: north.email, role: "accountant", branch_ids: [northBranch], created_by: userIds.owner },
    ])}`;
    await admin`insert into public.company_setup (tenant_id, sales_tax_registered, accounts_template, completed_by) values (${tenantA}, false, 'trading', ${userIds.owner})`;
    await setBaseCurrency(as.owner, { code: "PKR", name: "Pakistani Rupee" });
    await seedAccounts(as.owner, "trading");
    await openFiscalYear(as.owner, { month: "7", year: "2026" });
    const piece = (await addUnit(as.owner, { code: "pc", name: "Piece" })).id;
    helmet = (await createItem(as.owner, { code: "HL-1", name: "Helmet", unit: piece, defaultPrice: "1000" })).id;
    chain = (await createItem(as.owner, { code: "CH-2", name: "Chain", unit: piece, defaultPrice: "400" })).id;
    khan = (await createParty(as.owner, "customer", { name: "Khan Autos", code: "C-001", city: "Lahore" })).id;
    bilal = (await createParty(as.owner, "customer", { name: "Bilal Traders", code: "C-002", city: "Karachi" })).id;
    walk = (await createParty(as.owner, "customer", { name: "Walk Garage", code: "C-003" })).id;

    // Opening stock: Main store 10 helmets at 600 and 20 chains at 270; North store 4 helmets at 650.
    for (const [store, lines] of [[mainStore, [add("HL-1", "10", "600"), add("CH-2", "20", "270")]], [northStore, [add("HL-1", "4", "650")]]] as const) {
      const { id } = await saveAdjustmentDraft(as.owner, "opening", null, { date: "2026-08-01", warehouseId: store, lines: [...lines] });
      await postAdjustment(as.owner, id);
    }
    // 5 Nov: Khan Autos, 2 helmets and 6 chains (4,400), no salesperson named.
    await sell("2026-11-05", khan, mainStore, [[helmet, "2"], [chain, "6"]]);
    // 10 Nov: Bilal Traders, 3 helmets (3,000), shared 60/40 between the owner and the salesperson.
    const shared = await sell("2026-11-10", bilal, mainStore, [[helmet, "3"]], [{ userId: userIds.owner, percent: "60" }, { userId: userIds.salesperson, percent: "40" }]);
    // 12 Nov: Khan Autos, 10 chains (4,000), all the salesperson's.
    await sell("2026-11-12", khan, mainStore, [[chain, "10"]], [{ userId: userIds.salesperson, percent: "100" }]);
    // 15 Nov, North branch: Bilal Traders, 2 helmets (2,000).
    await sell("2026-11-15", bilal, northStore, [[helmet, "2"]]);
    // 20 Nov: one helmet comes back from the shared invoice: minus 1,000, 600 of it the owner's and 400 the salesperson's.
    const { id: back } = await startCreditNote(as.owner, shared);
    const invoice = (await getSalesDocument(as.owner, shared))!;
    await saveCreditNoteDraft(as.owner, back, { date: "2026-11-20", lines: [{ sourceLineId: invoice.lines[0].id, quantity: "1", damaged: "" }] });
    await postCreditNote(as.owner, back);
    // 15 Dec: Walk Garage (no city), 1 helmet (1,000), the sales manager's.
    await sell("2026-12-15", walk, mainStore, [[helmet, "1"]], [{ userId: userIds.sales_manager, percent: "100" }]);
  }, 400_000);

  afterAll(async () => {
    await deleteTenants(admin, [tenantA]);
    await admin.end();
    await closeDb();
  }, 120_000);

  const BOOKS = ["Sales in the books for the period", "Difference"];
  const footer = (table: ReportTable) => table.rows.filter((r) => BOOKS.includes(String(r.cells[0]))).map((r) => `${r.cells[0]}: ${text(r.cells[r.cells.length - 1 - (table.columns.length > 4 ? 3 : 0)] ?? null)}`);

  it("sales by customer: invoices less credit notes, with cost and margin, largest first, agreeing with the books", async () => {
    const table = await report(as.accountant, "sales-by-customer");
    expect(table.period).toBe("01-11-2026 to 30-11-2026");
    expect(shown(table)).toEqual([
      "Khan Autos (C-001) | 8400.00 | 5520.00 | 2880.00 | 34.3%",
      // 3,000 and 2,000 sold, one helmet back (1,000); cost 1,800 and 1,300, less the 600 that came back.
      "Bilal Traders (C-002) | 4000.00 | 2500.00 | 1500.00 | 37.5%",
      "Total | 12400.00 | 8020.00 | 4380.00 | 35.3%",
      "Sales in the books for the period | 12400.00 |  |  | ",
      "Difference | 0.00 |  |  | ",
    ]);
    expect(table.notes.some((note) => note.includes("do not agree"))).toBe(false);
  });

  it("sales by item: with quantity, and agreeing with Item profit", async () => {
    const table = await report(as.owner, "sales-by-item");
    expect(shown(table).slice(0, 3)).toEqual(["CH-2 | Chain | 16 pc | 6400.00 | 4320.00 | 2080.00 | 32.5%", "HL-1 | Helmet | 6 pc | 6000.00 | 3700.00 | 2300.00 | 38.3%", "Total |  |  | 12400.00 | 8020.00 | 4380.00 | 35.3%"]);
    const profit = await getStockReport(as.owner, "item-profit", readStockFilter({ from: "2026-11-01", to: "2026-11-30" }, { yearStart: "2026-07-01", today: TODAY }), TODAY);
    const strip = (t: ReportTable) => t.rows.filter((r) => r.kind === "line").map((r) => r.cells.map(text).filter((_, at) => at !== 1).join("|"));
    expect(strip(profit).map((line) => line.split("|").slice(0, 1).concat(line.split("|").slice(2, 5)).join("|"))).toEqual(strip(table).map((line) => line.split("|").slice(0, 1).concat(line.split("|").slice(2, 5)).join("|")));
  });

  it("sales by salesperson counts each person's share of a shared invoice, and a credit note takes back from the same people", async () => {
    const table = await report(as.owner, "sales-by-salesperson");
    const rows = shown(table);
    // Cost follows the shares too (owner 2,820 + 60% of 1,800 + 1,300 less 60% of 600). Owner: the unattributed 4,400 and the North invoice's 2,000 (the owner wrote them), 60% of 3,000, less 60% of the return.
    // Salesperson: 40% of 3,000 and all of 4,000, less 40% of the return.
    expect(rows.slice(0, 3)).toEqual([`${as.owner.email} | 7600.00 | 4840.00 | 2760.00 | 36.3%`, `${as.salesperson.email} | 4800.00 | 3180.00 | 1620.00 | 33.8%`, "Total | 12400.00 | 8020.00 | 4380.00 | 35.3%"]);
    expect(rows.slice(3)).toEqual(["Sales in the books for the period | 12400.00 |  |  | ", "Difference | 0.00 |  |  | "]);
  });

  it("sales by city and by month", async () => {
    const city = await report(as.owner, "sales-by-city");
    expect(shown(city).slice(0, 3)).toEqual(["Lahore | 8400.00 | 5520.00 | 2880.00 | 34.3%", "Karachi | 4000.00 | 2500.00 | 1500.00 | 37.5%", "Total | 12400.00 | 8020.00 | 4380.00 | 35.3%"]);
    // November and December together: no city for Walk Garage, and the largest month first.
    const wide = await report(as.owner, "sales-by-city", { to: "2026-12-31" });
    expect(shown(wide).slice(0, 4)).toEqual(["Lahore | 8400.00 | 5520.00 | 2880.00 | 34.3%", "Karachi | 4000.00 | 2500.00 | 1500.00 | 37.5%", "No city recorded | 1000.00 | 600.00 | 400.00 | 40.0%", "Total | 13400.00 | 8620.00 | 4780.00 | 35.7%"]);
    const month = await report(as.owner, "sales-by-month", { to: "2026-12-31" });
    expect(shown(month).slice(0, 3)).toEqual(["November 2026 | 12400.00 | 8020.00 | 4380.00 | 35.3%", "December 2026 | 1000.00 | 600.00 | 400.00 | 40.0%", "Total | 13400.00 | 8620.00 | 4780.00 | 35.7%"]);
    expect(footer(month)).toEqual(["Sales in the books for the period: 13400.00", "Difference: 0.00"]);
  });

  it("the sales register lists every invoice and credit note, credit notes as minus, with totals that agree with the books", async () => {
    const table = await report(as.accountant, "sales-register");
    const numbered = shown(table).map((line) => line.replace(/(INV|CN)-\d{4}-\d{5}/, "$1-N"));
    expect(numbered).toEqual([
      expect.stringMatching(/^05-11-2026 \| Invoice \S+ \| Khan Autos \| .*owner.* \| 4400\.00 \|  \| 4400\.00$/),
      expect.stringMatching(/^10-11-2026 \| Invoice \S+ \| Bilal Traders \| .*owner.*, .*salesperson.* \| 3000\.00 \|  \| 3000\.00$/),
      expect.stringMatching(/^12-11-2026 \| Invoice \S+ \| Khan Autos \| .*salesperson.* \| 4000\.00 \|  \| 4000\.00$/),
      expect.stringMatching(/^15-11-2026 \| Invoice \S+ \| Bilal Traders \| .*owner.* \| 2000\.00 \|  \| 2000\.00$/),
      expect.stringMatching(/^20-11-2026 \| Credit note \S+ \| Bilal Traders \| .* \| -1000\.00 \|  \| -1000\.00$/),
      "Total |  |  |  | 12400.00 | 0.00 | 12400.00",
      "Sales in the books for the period |  |  |  | 12400.00 |  | ",
      "Difference |  |  |  | 0.00 |  | ",
    ]);
  });

  it("narrows to a branch, and a member limited to a branch sees that branch's sales only, still agreeing with the books", async () => {
    const mine = await report(as.owner, "sales-by-customer", { branch: northBranch });
    expect(shown(mine)).toEqual(["Bilal Traders (C-002) | 2000.00 | 1300.00 | 700.00 | 35.0%", "Total | 2000.00 | 1300.00 | 700.00 | 35.0%", "Sales in the books for the period | 2000.00 |  |  | ", "Difference | 0.00 |  |  | "]);
    expect(shown(await report(north, "sales-by-customer"))).toEqual(shown(mine));
    expect(shown(await report(north, "sales-by-item")).slice(-3)).toEqual(["Total |  |  | 2000.00 | 1300.00 | 700.00 | 35.0%", "Sales in the books for the period |  |  | 2000.00 |  |  | ", "Difference |  |  | 0.00 |  |  | "]);
  });

  it("shows the sales manager the sales but no cost and no books; refuses a salesperson and the others", async () => {
    const table = await report(as.sales_manager, "sales-by-customer");
    expect(table.columns.map((c) => c.label)).toEqual(["Customer", "Sales"]);
    expect(shown(table)).toEqual(["Khan Autos (C-001) | 8400.00", "Bilal Traders (C-002) | 4000.00", "Total | 12400.00"]);
    const register = await report(as.sales_manager, "sales-register");
    expect(shown(register).at(-1)).toBe("Total |  |  |  | 12400.00 | 0.00 | 12400.00");
    for (const who of [as.salesperson, as.warehouse_manager]) {
      for (const key of ["sales-by-customer", "sales-by-item", "sales-by-salesperson", "sales-by-city", "sales-by-month", "sales-register"] as const) {
        await expect(report(who, key), `${who.role} ${key}`).rejects.toThrow("Only an owner, an accountant, an auditor or the sales manager can see the sales reports.");
      }
    }
  });
});

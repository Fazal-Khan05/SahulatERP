import { randomUUID } from "node:crypto";
import Decimal from "decimal.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb } from "@/db";
import { setBaseCurrency } from "@/modules/currencies/commands";
import { postAdjustment, postTransfer, saveAdjustmentDraft, saveTransferDraft } from "@/modules/inventory/commands";
import { addUnit, createItem } from "@/modules/items/commands";
import { seedAccounts } from "@/modules/ledger/commands";
import { openFiscalYear } from "@/modules/numbering/commands";
import { createParty } from "@/modules/parties/commands";
import type { Cell, ReportTable } from "@/modules/reports/rules";
import { postDelivery, postInvoice, saveDeliveryDraft, saveInvoiceDraft, saveSalesDraft, startDelivery, startInvoice, submitSalesDocument } from "@/modules/sales/commands";
import { getSalesDocument } from "@/modules/sales/queries";
import type { TenantContext } from "@/modules/tenant/rules";
import { adminSql, deleteTenants, hasAdminDb, type AdminSql } from "../../../tests/support/admin-db";
import { getStockReport } from "./queries";
import { readStockFilter, type StockFilter } from "./rules";

// Step 31 against a real database, through the app's own path: stock brought in, adjusted,
// moved between warehouses, delivered and invoiced by the app's own documents, then every stock
// report read back, with the valuation agreeing with the stock account in the books (the step's
// acceptance test). Skipped without the database URLs.

const hasDb = hasAdminDb() && Boolean(process.env.DATABASE_URL);
const PREFIX = "zz-stock-reports-test";
const tenantA = randomUUID();
const roles = ["owner", "accountant", "auditor", "sales_manager", "salesperson", "warehouse_manager"] as const;
const userIds = Object.fromEntries(roles.map((role) => [role, randomUUID()])) as Record<(typeof roles)[number], string>;
const northKeeper = randomUUID();
const mainBranch = randomUUID();
const northBranch = randomUUID();
const mainStore = randomUUID();
const cityStore = randomUUID();
const northStore = randomUUID();
const ctx = (userId: string, role: TenantContext["role"], branchIds: string[] | null = null): TenantContext => ({ userId, email: `${role}-${userId.slice(0, 4)}@stock-reports.test`, tenantId: tenantA, tenantName: "x", role, branchIds });
const as = Object.fromEntries(roles.map((role) => [role, ctx(userIds[role], role)])) as Record<(typeof roles)[number], TenantContext>;
const keeper = ctx(northKeeper, "warehouse_manager", [northBranch]);
const TODAY = "2026-11-14";

let admin: AdminSql;
let customer: string;

const filter = (raw: Record<string, string> = {}): StockFilter => readStockFilter(raw, { yearStart: "2026-07-01", today: TODAY });
const report = (who: TenantContext, key: Parameters<typeof getStockReport>[1], raw: Record<string, string> = {}) => getStockReport(who, key, filter(raw), TODAY);
const text = (cell: Cell) => (cell === null ? "" : typeof cell === "string" ? cell : cell.toFixed(2));
const lines = (table: ReportTable) => table.rows.filter((row) => row.kind === "line").map((row) => row.cells.map(text).join(" | "));
const row = (table: ReportTable, label: string) => table.rows.find((r) => r.cells[1] === label)!.cells.map(text);
const add = (itemCode: string, quantity: string, unitCost = "") => ({ itemCode, direction: "in", quantity, unitCost });

async function opening(warehouseId: string, date: string, lines: ReturnType<typeof add>[]) {
  const { id } = await saveAdjustmentDraft(as.owner, "opening", null, { date, warehouseId, lines });
  await postAdjustment(as.owner, id);
}
async function order(date: string, items: [string, string][]): Promise<string> {
  const { id } = await saveSalesDraft(as.owner, null, { kind: "order", date, customerId: customer, warehouseId: mainStore, lines: items.map(([itemId, quantity]) => ({ itemId, quantity, unitId: "", unitPrice: "", discountPercent: "", description: "" })), shares: [] });
  await submitSalesDocument(as.owner, id);
  return id;
}
async function billAll(sourceId: string, date: string): Promise<void> {
  const { id } = await startInvoice(as.owner, sourceId);
  const draft = (await getSalesDocument(as.owner, id))!;
  await saveInvoiceDraft(as.owner, id, { date, lines: draft.lines.map((l) => ({ sourceLineId: l.sourceLineId, quantity: l.quantity.toFixed() })) });
  await postInvoice(as.owner, id);
}

describe.skipIf(!hasDb)("stock reports", () => {
  let helmet: string;
  let chain: string;

  beforeAll(async () => {
    admin = adminSql();
    const stale = await admin<{ id: string }[]>`select id from public.tenants where name like ${PREFIX + "%"}`;
    await deleteTenants(admin, stale.map((r) => r.id));
    await admin`insert into public.tenants (id, name, created_by) values (${tenantA}, ${PREFIX + " A"}, ${userIds.owner})`;
    await admin`insert into public.branches (id, tenant_id, name, created_by) values (${mainBranch}, ${tenantA}, 'Main', ${userIds.owner}), (${northBranch}, ${tenantA}, 'North', ${userIds.owner})`;
    await admin`insert into public.warehouses (id, tenant_id, branch_id, name, created_by) values (${mainStore}, ${tenantA}, ${mainBranch}, 'Main store', ${userIds.owner}), (${cityStore}, ${tenantA}, ${mainBranch}, 'City store', ${userIds.owner}), (${northStore}, ${tenantA}, ${northBranch}, 'North store', ${userIds.owner})`;
    await admin`insert into public.memberships ${admin([
      ...roles.map((role) => ({ tenant_id: tenantA, user_id: userIds[role], email: as[role].email, role, branch_ids: null, created_by: userIds.owner })),
      { tenant_id: tenantA, user_id: northKeeper, email: keeper.email, role: "warehouse_manager", branch_ids: [northBranch], created_by: userIds.owner },
    ])}`;
    await admin`insert into public.company_setup (tenant_id, sales_tax_registered, accounts_template, completed_by) values (${tenantA}, false, 'trading', ${userIds.owner})`;
    await setBaseCurrency(as.owner, { code: "PKR", name: "Pakistani Rupee" });
    await seedAccounts(as.owner, "trading");
    await openFiscalYear(as.owner, { month: "7", year: "2026" });
    const piece = (await addUnit(as.owner, { code: "pc", name: "Piece" })).id;
    helmet = (await createItem(as.owner, { code: "HL-1", name: "Helmet", unit: piece, defaultPrice: "1000", reorderLevel: "5" })).id;
    chain = (await createItem(as.owner, { code: "CH-2", name: "Chain", unit: piece, defaultPrice: "400", reorderLevel: "10" })).id;
    await createItem(as.owner, { code: "GR-3", name: "Grip", unit: piece, defaultPrice: "50" });
    customer = (await createParty(as.owner, "customer", { name: "Khan Autos", code: "C-001" })).id;

    // 1 August: opening stock. Main store: 10 helmets at 600 and 20 chains at 270; North store: 4 helmets at 650.
    await opening(mainStore, "2026-08-01", [add("HL-1", "10", "600"), add("CH-2", "20", "270")]);
    await opening(northStore, "2026-08-01", [add("HL-1", "4", "650")]);
    // 20 October: 5 chains found in Main store, at 300 each. Main store's chains are then 25 worth 6,900, 276 each.
    const { id: found } = await saveAdjustmentDraft(as.owner, "adjustment", null, { date: "2026-10-20", warehouseId: mainStore, reason: "found", lines: [add("CH-2", "5", "300")] });
    await postAdjustment(as.owner, found);
    // 1 November: 3 helmets go from Main store to City store.
    const { id: transfer } = await saveTransferDraft(as.owner, null, { date: "2026-11-01", fromWarehouseId: mainStore, toWarehouseId: cityStore, lines: [{ itemCode: "HL-1", quantity: "3" }] });
    await postTransfer(as.owner, transfer);
    // 5 November: an order for 2 helmets and 6 chains, delivered on the 6th and invoiced on the 7th.
    const first = await order("2026-11-05", [[helmet, "2"], [chain, "6"]]);
    const { id: note } = await startDelivery(as.owner, first);
    const draft = (await getSalesDocument(as.owner, note))!;
    await saveDeliveryDraft(as.owner, note, { date: "2026-11-06", lines: draft.lines.map((l) => ({ sourceLineId: l.sourceLineId, quantity: l.quantity.toFixed() })) });
    await postDelivery(as.owner, note);
    await billAll(note, "2026-11-07");
    // 10 November: one helmet invoiced and delivered at once.
    await billAll(await order("2026-11-10", [[helmet, "1"]]), "2026-11-10");
    // 12 November: 15 chains ordered, not delivered yet.
    await order("2026-11-12", [[chain, "15"]]);
  }, 300_000);

  afterAll(async () => {
    await deleteTenants(admin, [tenantA]);
    await admin.end();
    await closeDb();
  }, 120_000);

  it("values the stock at weighted-average cost, and the total equals the stock account in the books", async () => {
    const today = await report(as.accountant, "valuation");
    expect(lines(today)).toEqual([
      "CH-2 | Chain | Main store | 19 pc | 276.00 | 5244.00",
      "HL-1 | Helmet | City store | 3 pc | 600.00 | 1800.00",
      "HL-1 | Helmet | Main store | 4 pc | 600.00 | 2400.00",
      "HL-1 | Helmet | North store | 4 pc | 650.00 | 2600.00",
    ]);
    expect(row(today, "Total").at(-1)).toBe("12044.00");
    expect(row(today, "Stock account in the books").at(-1)).toBe("12044.00");
    expect(row(today, "Difference").at(-1)).toBe("0.00");
    expect(today.notes).toEqual([]);

    // On an earlier day, and for one branch, they agree too.
    const october = await report(as.owner, "valuation", { to: "2026-10-31" });
    expect(row(october, "Total").at(-1)).toBe("15500.00");
    expect(row(october, "Difference").at(-1)).toBe("0.00");
    const main = await report(as.auditor, "valuation", { branch: mainBranch });
    expect(row(main, "Total").at(-1)).toBe("9444.00");
    expect(row(main, "Difference").at(-1)).toBe("0.00");
    // For one warehouse there is nothing in the books to compare with.
    const city = await report(as.owner, "valuation", { warehouse: cityStore });
    expect(lines(city)).toEqual(["HL-1 | Helmet | City store | 3 pc | 600.00 | 1800.00"]);
    expect(city.rows.some((r) => r.cells[1] === "Difference")).toBe(false);
  });

  it("shows costs to the owner, the accountant and the auditor only", async () => {
    for (const who of [as.sales_manager, as.salesperson, as.warehouse_manager, keeper]) {
      for (const key of ["valuation", "movement", "ageing", "item-profit"] as const) {
        await expect(report(who, key), `${who.role} ${key}`).rejects.toThrow("Only an owner, an accountant or an auditor can see what stock cost.");
      }
    }
  });

  it("tells what came in and went out in a period, and every move of one item", async () => {
    const november = await report(as.owner, "movement", { from: "2026-11-01", branch: mainBranch });
    expect(lines(november)).toEqual([
      "CH-2 | Chain | Main store | 25 pc | 6900.00 |  |  | 6 | 1656.00 | 19 pc | 5244.00",
      "HL-1 | Helmet | City store |  |  | 3 | 1800.00 |  |  | 3 pc | 1800.00",
      "HL-1 | Helmet | Main store | 10 pc | 6000.00 |  |  | 6 | 3600.00 | 4 pc | 2400.00",
    ]);
    expect(row(november, "Total").slice(3).filter(Boolean)).toEqual(["12900.00", "1800.00", "5256.00", "9444.00"]);

    const helmets = await report(as.owner, "movement", { from: "2026-11-01", item: helmet });
    expect(helmets.title).toBe("Stock movement: HL-1 Helmet");
    expect(lines(helmets).map((line) => line.replace(/[A-Z]{2}-2627-\d{5}/, "NO"))).toEqual([
      "01-11-2026 | Transfer NO | Main store |  | 3 | -1800.00 | 11 | 6800.00",
      "01-11-2026 | Transfer NO | City store | 3 |  | 1800.00 | 14 | 8600.00",
      "06-11-2026 | Delivery note NO | Main store |  | 2 | -1200.00 | 12 | 7400.00",
      "10-11-2026 | Sales invoice NO | Main store |  | 1 | -600.00 | 11 | 6800.00",
    ]);
    expect(row(helmets, "Opening").slice(6)).toEqual(["14", "8600.00"]);
    expect(row(helmets, "Closing").slice(6)).toEqual(["11", "6800.00"]);
  });

  it("ages the stock on hand by when it came in, and says when each item last sold", async () => {
    const ageing = await report(as.owner, "ageing");
    expect(ageing.columns.map((c) => c.label).slice(3, 9)).toEqual(["On hand", "0-30 days", "31-60 days", "61-90 days", "91-180 days", "Over 180 days"]);
    expect(lines(ageing)).toEqual([
      // 5 found on 20 October (25 days), the other 14 from 1 August (105 days).
      "CH-2 | Chain | Main store | 19 pc | 5 |  |  | 14 |  | 5244.00 | 06-11-2026 | 8",
      // Transferred in on 1 November: aged from then.
      "HL-1 | Helmet | City store | 3 pc | 3 |  |  |  |  | 1800.00 | Never | ",
      "HL-1 | Helmet | Main store | 4 pc |  |  |  | 4 |  | 2400.00 | 10-11-2026 | 4",
      "HL-1 | Helmet | North store | 4 pc |  |  |  | 4 |  | 2600.00 | Never | ",
    ]);
  });

  it("lists free stock at or below the reorder level for whoever reads stock", async () => {
    // Chains: 19 on hand, 15 on an open order, 4 free against a reorder level of 10. Helmets: 11 free against 5, not listed.
    for (const who of [as.warehouse_manager, as.sales_manager, as.owner]) {
      const low = await report(who, "low-stock");
      expect(lines(low), who.role).toEqual(["CH-2 | Chain | 10 pc | 19 | 15 | 4 | 6 | Main store 19"]);
    }
    // A member of the North branch sees North's warehouse and orders only.
    // There, chains are short by the whole reorder level, and North's 4 helmets are one below theirs.
    expect(lines(await report(keeper, "low-stock"))).toEqual(["CH-2 | Chain | 10 pc | 0 | 0 | 0 | 10 | ", "HL-1 | Helmet | 5 pc | 4 | 0 | 4 | 1 | North store 4"]);
    await expect(report(as.salesperson, "low-stock")).rejects.toThrow("Your role does not include stock.");
  });

  it("gives each item's sales, cost and margin, and they agree with the books", async () => {
    const profit = await report(as.accountant, "item-profit", { from: "2026-11-01" });
    expect(lines(profit)).toEqual(["CH-2 | Chain | 6 pc | 2400.00 | 1656.00 | 744.00 | 31.0%", "HL-1 | Helmet | 3 pc | 3000.00 | 1800.00 | 1200.00 | 40.0%"]);
    expect(row(profit, "Total").slice(3)).toEqual(["5400.00", "3456.00", "1944.00", "36.0%"]);
    // The books for November: sales credited 5,400 and cost of goods sold debited 3,456.
    const books = await admin<{ code: string; amount: string }[]>`
      select a.code, sum(l.credit - l.debit)::text as amount from public.journal_lines l
      join public.journals j on j.id = l.journal_id join public.accounts a on a.id = l.account_id
      where l.tenant_id = ${tenantA} and j.journal_date between '2026-11-01' and '2026-11-30' and a.code in ('4100', '5100') group by a.code order by a.code`;
    expect(books.map((b) => `${b.code} ${new Decimal(b.amount).toFixed(2)}`)).toEqual(["4100 5400.00", "5100 -3456.00"]);
    // October sold nothing.
    expect(lines(await report(as.accountant, "item-profit", { from: "2026-10-01", to: "2026-10-31" }))).toEqual([]);
  });
});

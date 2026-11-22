import { randomUUID } from "node:crypto";
import Decimal from "decimal.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, withTenant } from "@/db";
import { addAccount, seedAccounts } from "@/modules/ledger/commands";
import { listAccounts } from "@/modules/ledger/queries";
import type { AccountNode } from "@/modules/ledger/rules";
import { openFiscalYear } from "@/modules/numbering/commands";
import type { TenantContext } from "@/modules/tenant/rules";
import { adminSql, deleteTenants, hasAdminDb, type AdminSql } from "../../../tests/support/admin-db";
import { postBacked } from "../../../tests/support/journal";
import { getCashFlow, getOwnerFigures, getTrialBalance } from "./queries";
import type { ReportFilter, ReportTable } from "./rules";

// Step 36's cash-flow statement against a real database, through the app's own path: its net
// change is what the cash and bank accounts moved (the acceptance), for the company and for one
// branch, and who may read it. Skipped when the database URLs are absent.

const hasDb = hasAdminDb() && Boolean(process.env.DATABASE_URL);
const PREFIX = "zz-cash-flow-test";
const tenant = randomUUID();
const roles = ["owner", "accountant", "auditor", "salesperson"] as const;
const userIds = Object.fromEntries(roles.map((role) => [role, randomUUID()])) as Record<(typeof roles)[number], string>;
const mainBranch = randomUUID();
const cityBranch = randomUUID();
const cityClerk = randomUUID();
const ctx = (userId: string, role: TenantContext["role"], branchIds: string[] | null = null): TenantContext => ({ userId, email: `${role}-${userId.slice(0, 4)}@flow.test`, tenantId: tenant, tenantName: "x", role, branchIds });
const as = Object.fromEntries(roles.map((role) => [role, ctx(userIds[role], role)])) as Record<(typeof roles)[number], TenantContext>;
const cityAccountant = ctx(cityClerk, "accountant", [cityBranch]);
const HALF = { from: "2026-07-01", to: "2026-12-31", branchId: null, accountId: null } satisfies ReportFilter;

let admin: AdminSql;
let chart: AccountNode[];
let bank: string;
const account = (code: string) => chart.find((a) => a.code === code)!.id;
const cell = (table: ReportTable, label: string) => {
  const found = table.rows.find((row) => row.cells[0] === label);
  return found ? (found.cells[1] as Decimal).toFixed(2) : null;
};

describe.skipIf(!hasDb)("the cash-flow statement", () => {
  beforeAll(async () => {
    admin = adminSql();
    const stale = await admin<{ id: string }[]>`select id from public.tenants where name like ${PREFIX + "%"}`;
    await deleteTenants(admin, stale.map((r) => r.id));
    await admin`insert into public.tenants (id, name, created_by) values (${tenant}, ${PREFIX}, ${userIds.owner})`;
    await admin`insert into public.branches (id, tenant_id, name, created_by) values (${mainBranch}, ${tenant}, 'Main', ${userIds.owner}), (${cityBranch}, ${tenant}, 'City', ${userIds.owner})`;
    await admin`insert into public.memberships ${admin([
      ...roles.map((role) => ({ tenant_id: tenant, user_id: userIds[role], email: as[role].email, role, branch_ids: null, created_by: userIds.owner })),
      { tenant_id: tenant, user_id: cityClerk, email: cityAccountant.email, role: "accountant", branch_ids: [cityBranch], created_by: userIds.owner },
    ])}`;
    await seedAccounts(as.owner, "trading");
    await openFiscalYear(as.owner, { month: "7", year: "2026" });
    chart = await listAccounts(as.owner);
    bank = (await addAccount(as.owner, { parentId: account("1120"), name: "HBL current account", code: "", kind: "account" })).id;
    const post = (date: string, branchId: string | null, lines: [string, "debit" | "credit", string][]) =>
      withTenant(userIds.accountant, tenant, (tx) =>
        postBacked(
          tx,
          as.accountant,
          { date, branchId },
          lines.map(([code, side, amount]) => ({ accountId: code === "HBL" ? bank : account(code), [side]: new Decimal(amount) })),
        ),
      );
    // The owner puts 500,000 in; the City branch sells for cash and pays its rent.
    await post("2026-07-05", mainBranch, [["1111", "debit", "500000"], ["3100", "credit", "500000"]]);
    await post("2026-08-10", cityBranch, [["1111", "debit", "200000"], ["4100", "credit", "200000"]]);
    await post("2026-09-01", cityBranch, [["5230", "debit", "30000"], ["1111", "credit", "30000"]]);
    // 100,000 banked; repairs of 50,000 paid from the bank less 5,000 tax withheld; a bank loan; computers bought.
    await post("2026-09-10", mainBranch, [["HBL", "debit", "100000"], ["1111", "credit", "100000"]]);
    await post("2026-10-01", mainBranch, [["5270", "debit", "50000"], ["HBL", "credit", "45000"], ["2210", "credit", "5000"]]);
    await post("2026-10-15", mainBranch, [["HBL", "debit", "300000"], ["2510", "credit", "300000"]]);
    await post("2026-11-01", mainBranch, [["1520", "debit", "80000"], ["HBL", "credit", "80000"]]);
    // No money moves: the cost of what was sold.
    await post("2026-12-31", null, [["5100", "debit", "120000"], ["1230", "credit", "120000"]]);
  }, 120_000);

  afterAll(async () => {
    await deleteTenants(admin, [tenant]);
    await admin.end();
    await closeDb();
  });

  it("acceptance: the net cash flow is what the cash and bank accounts moved", async () => {
    const flow = await getCashFlow(as.auditor, HALF);
    expect([
      cell(flow, "Received from customers"),
      cell(flow, "Other receipts and payments"),
      cell(flow, "Net cash from operating activities"),
      cell(flow, "Fixed assets bought and sold"),
      cell(flow, "Loans taken and repaid"),
      cell(flow, "Owners' capital and drawings"),
      cell(flow, "Net change in cash and bank"),
    ]).toEqual(["200000.00", "-75000.00", "125000.00", "-80000.00", "300000.00", "500000.00", "845000.00"]);
    // The trial balance's cash and bank accounts: from nothing to 570,000 in hand and 275,000 in the bank.
    const trial = await getTrialBalance(as.auditor, HALF);
    const closing = (code: string) => {
      const row = trial.rows.find((r) => r.cells[0] === code);
      return row ? new Decimal((row.cells[6] as Decimal | null) ?? 0).minus((row.cells[7] as Decimal | null) ?? 0) : new Decimal(0);
    };
    const bankCode = chart.length > 0 ? (await listAccounts(as.owner)).find((a) => a.id === bank)!.code : "";
    expect(closing("1111").plus(closing(bankCode)).toFixed(2)).toBe("845000.00");
    expect([cell(flow, "Cash and bank at the start"), cell(flow, "Cash and bank at the end")]).toEqual(["0.00", "845000.00"]);
    expect(flow.notes[0]).toMatch(/^The net change, 8,45,000.00, is what the cash and bank accounts moved/);
  });

  it("for one branch, and for a member who works in it, is that branch's money", async () => {
    const city = await getCashFlow(as.owner, { ...HALF, branchId: cityBranch });
    expect([cell(city, "Received from customers"), cell(city, "Other receipts and payments"), cell(city, "Net change in cash and bank")]).toEqual(["200000.00", "-30000.00", "170000.00"]);
    const theirs = await getCashFlow(cityAccountant, { ...HALF, branchId: cityBranch });
    expect(cell(theirs, "Net change in cash and bank")).toBe("170000.00");
    // A later period starts where this one ended.
    const later = await getCashFlow(as.owner, { ...HALF, from: "2027-01-01", to: "2027-01-31" });
    expect([cell(later, "Cash and bank at the start"), cell(later, "Net change in cash and bank")]).toEqual(["845000.00", "0.00"]);
  });

  it("gives the owner's figures as the reports show them, for the company and for a branch", async () => {
    const money = (value: Decimal) => value.toFixed(2);
    const all = await getOwnerFigures(as.owner, HALF);
    // Cash and bank as the cash flow ends; sales 200,000; profit nil: 200,000 less rent 30,000, repairs 50,000 and cost of sales 120,000.
    expect([all.cash, all.cashChange, all.sales, all.profit, all.receivables, all.payables].map(money)).toEqual(["845000.00", "845000.00", "200000.00", "0.00", "0.00", "0.00"]);
    const city = await getOwnerFigures(as.owner, { ...HALF, branchId: cityBranch });
    expect([city.cash, city.sales, city.profit].map(money)).toEqual(["170000.00", "200000.00", "170000.00"]);
    await expect(getOwnerFigures(as.salesperson, HALF)).rejects.toThrow("Only an owner, an accountant or an auditor can see the ledger reports.");
  });

  it("is read by the owner, an accountant and the auditor only", async () => {
    await expect(getCashFlow(as.salesperson, HALF)).rejects.toThrow("Only an owner, an accountant or an auditor can see the ledger reports.");
  });
});

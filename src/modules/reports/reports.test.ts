import { randomUUID } from "node:crypto";
import Decimal from "decimal.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, withTenant } from "@/db";
import { seedAccounts } from "@/modules/ledger/commands";
import { listAccounts } from "@/modules/ledger/queries";
import type { AccountNode } from "@/modules/ledger/rules";
import { openFiscalYear } from "@/modules/numbering/commands";
import type { TenantContext } from "@/modules/tenant/rules";
import { adminSql, deleteTenants, hasAdminDb, type AdminSql } from "../../../tests/support/admin-db";
import { postBacked, reverseBacked } from "../../../tests/support/journal";
import { getBalanceSheet, getGeneralLedger, getProfitAndLoss, getRetainedEarnings, getRetainedEarningsStatement, getTrialBalance, getYearStart, listLedgerAccounts } from "./queries";
import type { ReportFilter, ReportTable } from "./rules";

// The ledger reports against a real database, through the app's own path (app_runtime,
// withTenant, row-level security). Skipped when the database URLs are absent.

const hasDb = hasAdminDb() && Boolean(process.env.DATABASE_URL);
const PREFIX = "zz-report-test";
const tenantA = randomUUID();
const tenantB = randomUUID();
const roles = ["owner", "accountant", "auditor", "salesperson"] as const;
const userIds = Object.fromEntries(roles.map((role) => [role, randomUUID()])) as Record<(typeof roles)[number], string>;
const scopedAccountant = randomUUID();
const ownerB = randomUUID();
const mainBranch = randomUUID();
const cityBranch = randomUUID();
const ctx = (userId: string, tenantId: string, role: TenantContext["role"], branchIds: string[] | null = null): TenantContext => ({ userId, email: `${role}-${userId.slice(0, 4)}@report.test`, tenantId, tenantName: "x", role, branchIds });
const as = Object.fromEntries(roles.map((role) => [role, ctx(userIds[role], tenantA, role)])) as Record<(typeof roles)[number], TenantContext>;
const scoped = ctx(scopedAccountant, tenantA, "accountant", [cityBranch]);
const otherOwner = ctx(ownerB, tenantB, "owner");
const d = (value: string) => new Decimal(value);

let admin: AdminSql;
let chart: AccountNode[];
const account = (code: string) => chart.find((a) => a.code === code)!.id;
const filter = (from: string, to: string, more: Partial<ReportFilter> = {}): ReportFilter => ({ from, to, branchId: null, accountId: null, ...more });
/** A table's rows as text, amounts to whole rupees, for comparing. */
const lines = (table: ReportTable) => table.rows.map((row) => row.cells.map((cell) => (cell === null ? "" : typeof cell === "string" ? cell : cell.toFixed(0))).join("|"));
const row = (table: ReportTable, first: string) => lines(table).find((line) => line.startsWith(`${first}|`));

describe.skipIf(!hasDb)("the ledger reports", () => {
  beforeAll(async () => {
    admin = adminSql();
    const stale = await admin<{ id: string }[]>`select id from public.tenants where name like ${PREFIX + "%"}`;
    await deleteTenants(admin, stale.map((r) => r.id));
    await admin`insert into public.tenants (id, name, created_by) values (${tenantA}, ${PREFIX + " A"}, ${userIds.owner}), (${tenantB}, ${PREFIX + " B"}, ${ownerB})`;
    await admin`insert into public.branches (id, tenant_id, name, created_by) values (${mainBranch}, ${tenantA}, 'Main', ${userIds.owner}), (${cityBranch}, ${tenantA}, 'City', ${userIds.owner})`;
    await admin`insert into public.memberships ${admin([
      ...roles.map((role) => ({ tenant_id: tenantA, user_id: userIds[role], email: as[role].email, role, branch_ids: null, created_by: userIds.owner })),
      { tenant_id: tenantA, user_id: scopedAccountant, email: scoped.email, role: "accountant", branch_ids: [cityBranch], created_by: userIds.owner },
      { tenant_id: tenantB, user_id: ownerB, email: otherOwner.email, role: "owner", branch_ids: null, created_by: ownerB },
    ])}`;
    await seedAccounts(as.owner, "trading");
    await seedAccounts(otherOwner, "trading");
    // Two fiscal years: July 2026 to June 2027, and July 2027 to June 2028.
    await openFiscalYear(as.owner, { month: "7", year: "2026" });
    await openFiscalYear(as.owner, {});
    chart = await listAccounts(as.owner);

    const post = (date: string, debit: string, credit: string, amount: string, more: { branchId?: string; number?: string; memo?: string } = {}) =>
      withTenant(userIds.accountant, tenantA, (tx) =>
        postBacked(tx, as.accountant, { date, branchId: more.branchId, documentNumber: more.number, memo: more.memo }, [
          { accountId: account(debit), debit: d(amount) },
          { accountId: account(credit), credit: d(amount) },
        ]),
      );
    // The first year: capital put in, sales and rent at the City branch, and the cost of what was sold.
    await post("2026-07-05", "1111", "3100", "500000", { memo: "Owner's money put in" });
    await post("2026-08-10", "1111", "4100", "200000", { branchId: cityBranch });
    await post("2026-09-01", "5230", "1111", "30000", { branchId: cityBranch });
    await post("2027-06-30", "5100", "1230", "120000");
    // The second year: sales and rent at the Main branch, other income, and a rent entry made twice and reversed.
    await post("2027-07-15", "1111", "4100", "80000.25", { branchId: mainBranch });
    await post("2027-07-20", "5230", "1111", "10000", { branchId: mainBranch, number: "JV-2728-00001", memo: "July rent" });
    const twice = await post("2027-07-20", "5230", "1111", "10000", { branchId: mainBranch, number: "JV-2728-00002", memo: "July rent" });
    await withTenant(userIds.accountant, tenantA, (tx) => reverseBacked(tx, as.accountant, twice, { date: "2027-07-25", memo: "Entered twice" }));
    await post("2027-08-01", "1111", "4200", "1500");
  });

  afterAll(async () => {
    await deleteTenants(admin, [tenantA, tenantB]);
    await admin.end();
    await closeDb();
  });

  it("gives a trial balance whose totals are equal", async () => {
    const july = await getTrialBalance(as.auditor, filter("2027-07-01", "2027-07-31"));
    expect(lines(july)).toEqual([
      // Cash opened at 670,000 and took 90,000.25 in and 20,000 out.
      "1111|Cash in hand|670000||90000|20000|740000|",
      "1230|Other receivables||120000||||120000",
      "3100|Owner's capital||500000||||500000",
      "4100|Sales||200000||80000||280000",
      "5100|Cost of goods sold|120000||||120000|",
      "5230|Rent|30000||20000|10000|40000|",
      "|Total|820000|820000|110000|110000|900000|900000",
    ]);
    const totals = july.rows.at(-1)!.cells as (Decimal | string)[];
    // To the paisa, not just to the rupee.
    expect([totals[4], totals[5], totals[6], totals[7]].map((cell) => (cell as Decimal).toFixed(2))).toEqual(["110000.25", "110000.25", "900000.25", "900000.25"]);
    expect(july.notes).toEqual([]);
    // From the very beginning nothing is opening and everything is movement.
    const all = await getTrialBalance(as.owner, filter("2026-07-01", "2028-06-30"));
    expect(row(all, "")).toBe("|Total|0|0|961500|961500|901500|901500");
  });

  it("gives a balance sheet that balances, with each year's profit under equity", async () => {
    const sheet = await getBalanceSheet(as.auditor, filter("2027-07-01", "2027-07-31"));
    expect(sheet.period).toBe("As at the end of 31-07-2027");
    expect(lines(sheet)).toEqual([
      "Assets|",
      "1100 Current assets|620000",
      "1110 Cash accounts|740000",
      "1111 Cash in hand|740000",
      "1230 Other receivables|-120000",
      "Total assets|620000",
      "Liabilities|",
      "Total liabilities|0",
      "Equity|",
      "3100 Owner's capital|500000",
      // The first year earned 200,000 less 30,000 less 120,000; this year 80,000.25 less 10,000.
      "Profit of earlier years, not yet moved to retained earnings|50000",
      "Profit for this fiscal year so far|70000",
      "Total equity|620000",
      "Total liabilities and equity|620000",
    ]);
    expect(sheet.notes).toEqual([]);
    // On the last day of the first year, that year's profit is still "this year's".
    const yearEnd = await getBalanceSheet(as.owner, filter("2026-07-01", "2027-06-30"));
    expect(row(yearEnd, "Profit for this fiscal year so far")).toBe("Profit for this fiscal year so far|50000");
    expect(lines(yearEnd).some((line) => line.startsWith("Profit of earlier years"))).toBe(false);
    expect(row(yearEnd, "Total assets")).toBe("Total assets|550000");
    expect(row(yearEnd, "Total liabilities and equity")).toBe("Total liabilities and equity|550000");
  });

  it("gives a profit and loss whose net equals the change in what the owners have earned", async () => {
    const july = await getProfitAndLoss(as.auditor, filter("2027-07-01", "2027-07-31"));
    expect(lines(july)).toEqual(["Income|", "4100 Sales|80000", "Total income|80000", "Expenses|", "5200 Operating expenses|10000", "5230 Rent|10000", "Total expenses|10000", "Net profit|70000"]);
    const net = july.rows.at(-1)!.cells[1] as Decimal;
    const [before, after] = [await getRetainedEarnings(as.owner, "2027-06-30"), await getRetainedEarnings(as.owner, "2027-07-31")];
    expect([before.toFixed(2), after.toFixed(2), net.toFixed(2)]).toEqual(["50000.00", "120000.25", "70000.25"]);
    expect(after.minus(before).eq(net)).toBe(true);
    // And over any other period: the whole first year, and a period that straddles the two years.
    for (const [from, to] of [["2026-07-01", "2027-06-30"], ["2027-06-15", "2027-08-15"], ["2026-07-01", "2028-06-30"]]) {
      const report = await getProfitAndLoss(as.owner, filter(from, to));
      const dayBefore = new Date(Date.parse(`${from}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
      const change = (await getRetainedEarnings(as.owner, to)).minus(await getRetainedEarnings(as.owner, dayBefore));
      expect((report.rows.at(-1)!.cells[1] as Decimal).toFixed(2), `${from} to ${to}`).toBe(change.toFixed(2));
    }
    const firstYear = await getProfitAndLoss(as.owner, filter("2026-07-01", "2027-06-30"));
    expect(firstYear.notes[0]).toContain("Gross profit, counting only the Sales account and the Cost of goods sold account: 2,00,000.00 less 1,20,000.00 is 80,000.00.");
  });

  it("still accounts for the change when something is posted straight to retained earnings", async () => {
    // Earlier profit brought from old books, credited to retained earnings in August 2027.
    await withTenant(userIds.accountant, tenantA, (tx) =>
      postBacked(tx, as.accountant, { date: "2027-08-20", memo: "Profit of earlier years, from the old books" }, [
        { accountId: account("1230"), debit: d("300000") },
        { accountId: account("3300"), credit: d("300000") },
      ]),
    );
    const august = await getRetainedEarningsStatement(as.auditor, { from: "2027-08-01", to: "2027-08-31" });
    // August earned 1,500 of other income; 300,000 came in directly.
    expect([august.opening, august.netProfit, august.direct, august.closing].map((v) => v.toFixed(2))).toEqual(["120000.25", "1500.00", "300000.00", "421500.25"]);
    expect(august.opening.plus(august.netProfit).plus(august.direct).eq(august.closing)).toBe(true);
    const report = await getProfitAndLoss(as.owner, filter("2027-08-01", "2027-08-31"));
    expect((report.rows.at(-1)!.cells[1] as Decimal).eq(august.closing.minus(august.opening).minus(august.direct))).toBe(true);
    // The balance sheet shows the account itself and still balances.
    const sheet = await getBalanceSheet(as.owner, filter("2027-08-01", "2027-08-31"));
    expect(row(sheet, "3300 Retained earnings")).toBe("3300 Retained earnings|300000");
    expect(row(sheet, "Total assets")).toBe(row(sheet, "Total liabilities and equity")?.replace("Total liabilities and equity", "Total assets"));
    expect(sheet.notes).toEqual([]);
    await expect(getRetainedEarningsStatement(as.salesperson, { from: "2027-08-01", to: "2027-08-31" })).rejects.toThrow("Only an owner, an accountant or an auditor");
  });

  it("shows one account's entries in order with a running balance", async () => {
    const ledger = await getGeneralLedger(as.auditor, filter("2027-07-01", "2027-07-31", { accountId: account("5230") }));
    expect(ledger?.title).toBe("General ledger: 5230 Rent");
    expect(lines(ledger!)).toEqual([
      "||Opening balance|||30,000.00 Dr",
      "20-07-2027|JV-2728-00001|July rent|10000||40,000.00 Dr",
      "20-07-2027|JV-2728-00002|July rent|10000||50,000.00 Dr",
      "25-07-2027|Reversal of JV-2728-00002|Entered twice||10000|40,000.00 Dr",
      "||Closing balance|20000|10000|40,000.00 Dr",
    ]);
    // A page that cannot hold every entry says so, and still opens at the right balance.
    const short = await getGeneralLedger(as.owner, filter("2027-07-01", "2027-07-31", { accountId: account("5230") }), 2);
    expect(lines(short!).at(-1)).toBe("||Total of the entries shown|20000|0|50,000.00 Dr");
    expect(short!.notes[0]).toContain("more entries in the period than one page shows");
    // No account, a heading, or another company's account: nothing.
    expect(await getGeneralLedger(as.owner, filter("2027-07-01", "2027-07-31"))).toBeNull();
    expect(await getGeneralLedger(as.owner, filter("2027-07-01", "2027-07-31", { accountId: account("5200") }))).toBeNull();
    expect(await getGeneralLedger(otherOwner, filter("2027-07-01", "2027-07-31", { accountId: account("5230") }))).toBeNull();
    const choices = await listLedgerAccounts(as.auditor);
    expect(choices.slice(0, 3).map((choice) => choice.label)).toEqual(["1111 Cash in hand", "1130 Cheques in hand", "1200 Trade receivables"]);
    expect(choices.some((choice) => choice.label === "5200 Operating expenses")).toBe(false);
  });

  it("keeps each branch's books apart, and each still balances", async () => {
    const city = filter("2026-07-01", "2028-06-30", { branchId: cityBranch });
    expect(lines(await getTrialBalance(as.owner, city))).toEqual(["1111|Cash in hand|||200000|30000|170000|", "4100|Sales||||200000||200000", "5230|Rent|||30000||30000|", "|Total|0|0|230000|230000|200000|200000"]);
    const sheet = await getBalanceSheet(as.owner, filter("2026-07-01", "2027-07-31", { branchId: mainBranch }));
    expect(row(sheet, "Total assets")).toBe("Total assets|70000");
    expect(row(sheet, "Total liabilities and equity")).toBe("Total liabilities and equity|70000");
    expect(sheet.notes).toEqual([]);
    // A member limited to the City branch gets the City branch's books whatever they ask for.
    expect(lines(await getTrialBalance(scoped, filter("2026-07-01", "2028-06-30")))).toEqual(lines(await getTrialBalance(as.owner, city)));
    expect(lines(await getTrialBalance(scoped, filter("2026-07-01", "2028-06-30", { branchId: mainBranch })))).toEqual(["|Total|0|0|0|0|0|0"]);
    expect((await getProfitAndLoss(scoped, filter("2026-07-01", "2028-06-30"))).rows.at(-1)!.cells[1]).toEqual(d("170000"));
  });

  it("is for those who keep or check the books, and for their own company only", async () => {
    const whole = filter("2026-07-01", "2028-06-30");
    for (const report of [getTrialBalance, getBalanceSheet, getProfitAndLoss, getGeneralLedger]) {
      await expect(report(as.salesperson, whole), report.name).rejects.toThrow("Only an owner, an accountant or an auditor can see the ledger reports.");
    }
    await expect(getYearStart(as.salesperson, "2027-07-31")).rejects.toThrow("Only an owner, an accountant or an auditor");
    // The other company has the same chart and no entries: every report is empty and balanced.
    expect(lines(await getTrialBalance(otherOwner, whole))).toEqual(["|Total|0|0|0|0|0|0"]);
    expect(row(await getBalanceSheet(otherOwner, whole), "Total assets")).toBe("Total assets|0");
    expect((await getRetainedEarnings(otherOwner, "2028-06-30")).isZero()).toBe(true);
  });

  it("finds the fiscal year a date falls in", async () => {
    expect(await getYearStart(as.owner, "2026-07-01")).toBe("2026-07-01");
    expect(await getYearStart(as.owner, "2027-06-30")).toBe("2026-07-01");
    expect(await getYearStart(as.owner, "2027-07-31")).toBe("2027-07-01");
    // A date after the last year that was opened still counts from July.
    expect(await getYearStart(as.owner, "2029-02-10")).toBe("2028-07-01");
    // A date before the first year, or a company with no fiscal year, counts from the date itself.
    expect(await getYearStart(as.owner, "2026-03-01")).toBe("2026-03-01");
    expect(await getYearStart(otherOwner, "2027-07-31")).toBe("2027-07-31");
  });
});

import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, withTenant } from "@/db";
import { approveCommission } from "@/modules/commission-ledger/commands";
import { getCommissionStatement } from "@/modules/commission-statements/queries";
import { savePlan } from "@/modules/commissions/commands";
import { setBaseCurrency } from "@/modules/currencies/commands";
import { addUnit, createItem } from "@/modules/items/commands";
import { seedAccounts } from "@/modules/ledger/commands";
import { openFiscalYear } from "@/modules/numbering/commands";
import { createParty } from "@/modules/parties/commands";
import { importAttendance, saveEmployee, setPay } from "@/modules/payroll/commands";
import { postReceipt, saveReceiptDraft } from "@/modules/receipts/commands";
import { postInvoice, saveInvoiceDraft, saveSalesDraft, startInvoice, submitSalesDocument } from "@/modules/sales/commands";
import { getSalesDocument } from "@/modules/sales/queries";
import type { TenantContext } from "@/modules/tenant/rules";
import { adminSql, deleteTenants, hasAdminDb, type AdminSql } from "../../../tests/support/admin-db";
import { seedStock } from "../../../tests/support/stock";
import { approveRun, cancelRun, payRun, reviewRun, workOutRun } from "./commands";
import { getRun, listRuns } from "./queries";

// Step 41 against a real database, through the app's own path (app_runtime, withTenant,
// row-level security): a month is worked out, reviewed, approved into the books with its
// commission settled and never expensed again, and paid; approving after a commission changed is
// refused (the acceptance); and who may do what. Skipped when the database URLs are absent.

const hasDb = hasAdminDb() && Boolean(process.env.DATABASE_URL);
const PREFIX = "zz-payroll-runs-test";
const tenant = randomUUID();
const roles = ["owner", "payroll_administrator", "accountant", "auditor"] as const;
const userIds = Object.fromEntries(roles.map((role) => [role, randomUUID()])) as Record<(typeof roles)[number], string>;
const ali = randomUUID();
const outsider = randomUUID();
const cityAccountant = randomUUID();
const branch = randomUUID();
const cityBranch = randomUUID();
const warehouse = randomUUID();
const ctx = (userId: string, role: TenantContext["role"], branchIds: string[] | null = null): TenantContext => ({ userId, email: `${role}-${userId.slice(0, 4)}@runs.test`, tenantId: tenant, tenantName: "x", role, branchIds });
const as = Object.fromEntries(roles.map((role) => [role, ctx(userIds[role], role)])) as Record<(typeof roles)[number], TenantContext>;
const salesperson = ctx(ali, "salesperson");
const scoped = ctx(cityAccountant, "accountant", [cityBranch]);
const OCT = "2026-10-01";
const NOV = "2026-11-01";

let admin: AdminSql;
let cash: string;
let lamp: string;
let retailer: string;
let october: string;
let november: string;
let invoiceA: string;

async function sell(date: string, quantity: string): Promise<string> {
  const order = await saveSalesDraft(as.owner, null, {
    kind: "order",
    date,
    customerId: retailer,
    warehouseId: warehouse,
    lines: [{ itemId: lamp, quantity, unitId: "", unitPrice: "", discountPercent: "", description: "" }],
    shares: [{ userId: ali, percent: "100" }],
  });
  await submitSalesDocument(as.owner, order.id, undefined, { reason: "Test order" }).catch(async () => submitSalesDocument(as.owner, order.id));
  const { id } = await startInvoice(as.owner, order.id);
  const draft = (await getSalesDocument(as.owner, id))!;
  await saveInvoiceDraft(as.owner, id, { date, lines: draft.lines.map((l) => ({ sourceLineId: l.sourceLineId, quantity: l.quantity.toFixed() })) });
  await postInvoice(as.owner, id);
  return id;
}
async function cashIn(date: string, invoiceId: string, amount: string): Promise<void> {
  const draft = await saveReceiptDraft(as.accountant, null, { date, customerId: retailer, method: "cash", accountId: cash, amount, allocations: [{ kind: "invoice", id: invoiceId, amount }] });
  await postReceipt(as.accountant, draft.id);
}
async function approveAlisCommission(): Promise<void> {
  const ids = (await admin<{ id: string }[]>`select id from public.commission_accruals where tenant_id = ${tenant} and user_id = ${ali} and released > paid and approved_at is null`).map((r) => r.id);
  await approveCommission(as.owner, ids);
}
async function codeOf(who: TenantContext, statement: ReturnType<typeof sql>): Promise<string | undefined> {
  try {
    await withTenant(who.userId, who.tenantId, (tx) => tx.execute(statement));
    return undefined;
  } catch (error) {
    const e = error as { code?: string; cause?: { code?: string } };
    return e.cause?.code ?? e.code ?? "unknown";
  }
}
async function messageOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return "went through";
  } catch (error) {
    return (error as Error).message;
  }
}
/** A journal's lines by the account's code: debit less credit. */
async function journalLines(journalId: string): Promise<Record<string, string>> {
  const rows = await admin<{ code: string; net: string }[]>`
    select a.code, (l.debit - l.credit)::numeric(20,2)::text as net from public.journal_lines l join public.accounts a on a.id = l.account_id
    where l.journal_id = ${journalId} order by l.line_no`;
  return Object.fromEntries(rows.map((r) => [r.code, r.net]));
}
async function balance(code: string): Promise<string> {
  const [row] = await admin<{ net: string }[]>`
    select coalesce(sum(l.debit - l.credit), 0)::numeric(20,2)::text as net from public.journal_lines l join public.accounts a on a.id = l.account_id
    where a.tenant_id = ${tenant} and a.code = ${code}`;
  return row.net;
}
const money = (value: { toFixed(scale: number): string }) => value.toFixed(2);

describe.skipIf(!hasDb)("payroll runs", () => {
  beforeAll(async () => {
    admin = adminSql();
    const stale = await admin<{ id: string }[]>`select id from public.tenants where name like ${PREFIX + "%"}`;
    await deleteTenants(admin, stale.map((r) => r.id));
    await admin`insert into public.tenants (id, name, created_by) values (${tenant}, ${PREFIX}, ${userIds.owner})`;
    await admin`insert into public.branches (id, tenant_id, name, created_by) values (${branch}, ${tenant}, 'Main', ${userIds.owner}), (${cityBranch}, ${tenant}, 'City', ${userIds.owner})`;
    await admin`insert into public.warehouses (id, tenant_id, branch_id, name, created_by) values (${warehouse}, ${tenant}, ${branch}, 'Main store', ${userIds.owner})`;
    await admin`insert into public.memberships ${admin([
      ...roles.map((role) => ({ tenant_id: tenant, user_id: userIds[role], email: as[role].email, role, branch_ids: null, created_by: userIds.owner })),
      { tenant_id: tenant, user_id: ali, email: "ali@runs.test", role: "salesperson", branch_ids: null, created_by: userIds.owner },
      { tenant_id: tenant, user_id: outsider, email: "zara@runs.test", role: "salesperson", branch_ids: null, created_by: userIds.owner },
      { tenant_id: tenant, user_id: cityAccountant, email: scoped.email, role: "accountant", branch_ids: [cityBranch], created_by: userIds.owner },
    ])}`;
    await admin`insert into public.company_setup (tenant_id, sales_tax_registered, accounts_template, completed_by) values (${tenant}, false, 'trading', ${userIds.owner})`;
    await setBaseCurrency(as.owner, { code: "PKR", name: "Pakistani Rupee" });
    await seedAccounts(as.owner, "trading");
    await openFiscalYear(as.owner, { month: "7", year: "2026" });
    cash = (await admin<{ id: string }[]>`select id from public.accounts where tenant_id = ${tenant} and code = '1111'`)[0].id;
    lamp = (await createItem(as.owner, { code: "LT-1", name: "Lamp", unit: (await addUnit(as.owner, { code: "pc", name: "Piece" })).id, defaultPrice: "100" })).id;
    retailer = (await createParty(as.owner, "customer", { name: "Corner Shop", code: "C-001" })).id;
    await seedStock(admin, { tenantId: tenant, warehouseId: warehouse, userId: userIds.owner, itemId: lamp, quantity: "100000", value: "5000000" });
    await savePlan(as.owner, null, { name: "Standard plan", kind: "flat", rate: "2", from: "2026-09-01", to: "" });

    // Ali sells and is a monthly employee; Bilal works by the day from 10 October.
    const employee = (over: Record<string, unknown>) => ({ province: "punjab", payBasis: "monthly", joinedOn: "2026-07-01", ...over });
    const aliEmployee = await saveEmployee(as.owner, null, employee({ code: "E-001", name: "Ali Raza", eobi: "on", socialSecurity: "on", userId: ali }));
    await setPay(as.owner, aliEmployee.id, { component: "basic", amount: "150000", effectiveFrom: "2026-07-01" });
    await setPay(as.owner, aliEmployee.id, { component: "medical", amount: "15000", effectiveFrom: "2026-07-01" });
    const bilal = await saveEmployee(as.owner, null, employee({ code: "E-002", name: "Bilal Ahmed", payBasis: "daily", province: "sindh", joinedOn: "2026-10-10" }));
    await setPay(as.owner, bilal.id, { component: "daily_wage", amount: "2000", effectiveFrom: "2026-10-10" });
    const imported = await importAttendance(as.payroll_administrator, OCT, { name: "october.csv", text: "Code,Days worked,Unpaid days\nE-001,0,0\nE-002,15,0\n" });
    expect(imported).toEqual({ imported: 2 });

    // October: 100 lamps at 100 earn Ali 200; half is paid, releasing 100, which the owner approves.
    invoiceA = await sell("2026-10-01", "100");
    await cashIn("2026-10-02", invoiceA, "5000");
    await approveAlisCommission();
  }, 240_000);

  afterAll(async () => {
    await deleteTenants(admin, [tenant]);
    await admin.end();
    await closeDb();
  }, 120_000);

  it("works October out: a payslip each, from pay, days, the statutory rates and the commission approved", async () => {
    const outcome = await workOutRun(as.payroll_administrator, OCT);
    expect("id" in outcome).toBe(true);
    october = (outcome as { id: string }).id;
    const run = (await getRun(as.payroll_administrator, october))!;
    expect(run.status).toBe("draft");
    const slips = Object.fromEntries(run.payslips.map((s) => [s.code, s]));
    // Ali: 165,000 paid, the medical allowance within 10% of basic and so exempt; 100 commission.
    // Employed since July and nothing run here before: July to September are taken as 150,000 a
    // month taxed 6,000. A year of 450,000 + 150,100 + 8 x 150,000 = 1,800,100 is taxed 6,000 +
    // 11% of 600,100 = 72,011; less 18,000, over nine months, 6,001.22.
    // EOBI 1% and 5% of 40,700; social security 6% of Punjab's 40,000.
    const a = slips["E-001"];
    expect([a.earnings, a.commission, a.taxable, a.assumedTaxable, a.assumedTax, a.annualTaxable, a.annualTax, a.tax, a.eobiEmployee, a.net, a.employerEobi, a.employerSocialSecurity].map(money)).toEqual([
      "165000.00",
      "100.00",
      "150100.00",
      "450000.00",
      "18000.00",
      "1800100.00",
      "72011.00",
      "6001.22",
      "407.00",
      "158691.78",
      "2035.00",
      "2400.00",
    ]);
    expect([a.monthsLeft, a.assumedMonths]).toEqual([9, 3]);
    // Bilal: 22 days employed, 15 worked at 2,000.
    const b = slips["E-002"];
    expect([b.daysEmployed, b.daysWorked.toFixed(), money(b.earnings), money(b.tax), money(b.net)]).toEqual([22, "15", "30000.00", "0.00", "30000.00"]);
    expect([run.earnings, run.commission, run.tax, run.net].map(money)).toEqual(["195000.00", "100.00", "6001.22", "188691.78"]);
    // The payroll administrator, who reads no commission, cannot ask for anyone else's.
    expect(await codeOf(as.payroll_administrator, sql`select app.payroll_commission_basis(${outsider}::uuid)`)).toBe("42501");
    expect(await codeOf(as.accountant, sql`select app.payroll_commission_basis(${ali}::uuid)`)).toBe("42501");
  });

  it("keeps a draft the app's to write and nothing after it", async () => {
    expect(await messageOf(approveRun(as.accountant, october))).toMatch(/not at that stage/);
    await reviewRun(as.payroll_administrator, october);
    // Worked out again, it is a draft again, and is reviewed again.
    await workOutRun(as.owner, OCT);
    expect((await getRun(as.owner, october))!.status).toBe("draft");
    await reviewRun(as.owner, october);
    expect((await getRun(as.owner, october))!.status).toBe("reviewed");
    // The app cannot approve it by hand, nor remove it.
    expect(await codeOf(as.owner, sql`update public.payroll_runs set status = 'approved' where id = ${october}`)).toBe("SE351");
    expect(await codeOf(as.owner, sql`delete from public.payroll_runs where id = ${october}`)).toBe("42501");
    const [slip] = await admin<{ id: string }[]>`select id from public.payslips where run_id = ${october} limit 1`;
    expect(await codeOf(as.owner, sql`delete from public.payslip_lines where payslip_id = ${slip.id}`)).toBe("SE351");
  });

  it("approves October into the books once, and settles its commission without expensing it again", async () => {
    const commissionExpenseBefore = await balance("5220");
    expect(await messageOf(approveRun(as.payroll_administrator, october))).toMatch(/owner or an accountant/);
    expect(await messageOf(approveRun(scoped, october))).toMatch(/whole company/);
    const { number } = await approveRun(as.accountant, october);
    expect(number).toMatch(/^PR-2627-\d{5}$/);
    const run = (await getRun(as.auditor, october))!;
    expect([run.status, run.journalDate]).toEqual(["approved", "2026-10-31"]);
    // Pay 195,000 is expensed; the employer's EOBI and social security, 4,435, too; the 100
    // commission comes out of Commission payable; 188,691.78 is owed to the people, 6,001.22 in
    // tax, and 407 + 4,435 in EOBI and social security.
    expect(await journalLines(run.journalId!)).toEqual({ "5210": "195000.00", "5215": "4435.00", "2320": "100.00", "2300": "-188691.78", "2210": "-6001.22", "2310": "-4842.00" });
    expect(await balance("5220")).toBe(commissionExpenseBefore);
    expect(await balance("2320")).toBe("-100.00");
    const [accrual] = await admin<{ paid: string; approved: boolean }[]>`select paid::numeric(20,2)::text as paid, approved_at is not null as approved from public.commission_accruals where tenant_id = ${tenant} and user_id = ${ali}`;
    expect(accrual).toEqual({ paid: "100.00", approved: false });
    const moves = await admin<{ type: string; amount: string; source_type: string; movement_date: string }[]>`
      select m.type, m.amount::numeric(20,2)::text as amount, m.source_type, m.movement_date::text from public.commission_movements m where m.tenant_id = ${tenant} and m.source_id = ${october}`;
    expect(moves).toEqual([{ type: "paid", amount: "100.00", source_type: "payroll_run", movement_date: "2026-10-31" }]);
    // Ali's commission statement shows the payment with the run's number.
    const statement = (await getCommissionStatement(as.owner, ali, { from: OCT, to: "2026-10-31" }))!;
    expect(statement.statement.lines.at(-1)).toMatchObject({ what: "Commission paid", number });
    // An approved run stands: it is not worked out again, nor cancelled.
    expect(await messageOf(workOutRun(as.owner, OCT))).toMatch(/has been approved/);
    expect(await messageOf(cancelRun(as.owner, october, "Wrong month"))).toMatch(/not at that stage/);
    const [audit] = await admin<{ n: number }[]>`select count(*)::int as n from public.audit_log where tenant_id = ${tenant} and entity_id = ${october} and action = 'payroll_run.approve'`;
    expect(audit.n).toBe(1);
  });

  it("pays October from cash with a number of its own", async () => {
    expect(await messageOf(payRun(as.accountant, october, { date: "2026-10-30", accountId: cash }))).toMatch(/cannot be used/);
    await payRun(as.accountant, october, { date: "2026-11-01", accountId: cash });
    const run = (await getRun(as.owner, october))!;
    expect([run.status, run.paidOn]).toEqual(["paid", "2026-11-01"]);
    expect(run.paymentNumber).toMatch(/^SP-2627-\d{5}$/);
    expect(await journalLines(run.paymentJournalId!)).toEqual({ "2300": "188691.78", "1111": "-188691.78" });
    expect(await balance("2300")).toBe("0.00");
  });

  it("acceptance: approving a run after a commission changed is refused", async () => {
    // The rest of invoice A is paid in November: 100 more released, not yet approved.
    await cashIn("2026-11-02", invoiceA, "5000");
    const outcome = await workOutRun(as.payroll_administrator, NOV);
    november = (outcome as { id: string }).id;
    const before = (await getRun(as.owner, november))!.payslips.find((s) => s.code === "E-001")!;
    // October's approved payslip is the tax year so far, with July to September taken as before.
    expect([money(before.taxableBefore), money(before.taxBefore), before.assumedMonths, money(before.commission)]).toEqual(["150100.00", "6001.22", 3, "0.00"]);
    await reviewRun(as.payroll_administrator, november);
    // The 100 released in November is approved after the run was worked out.
    await approveAlisCommission();
    expect(await messageOf(approveRun(as.owner, november))).toMatch(/commission has changed/);
    expect((await getRun(as.owner, november))!.status).toBe("reviewed");
    // Worked out again, it carries the commission, and is approved.
    await workOutRun(as.payroll_administrator, NOV);
    await reviewRun(as.payroll_administrator, november);
    const after = (await getRun(as.owner, november))!.payslips.find((s) => s.code === "E-001")!;
    expect(money(after.commission)).toBe("100.00");
    await approveRun(as.owner, november);
    expect(await balance("2320")).toBe("0.00");
  });

  it("cancels a run before approval, saying why, and the month is worked out anew", async () => {
    // September: nobody's attendance, Ali alone (Bilal joined in October).
    const { id } = (await workOutRun(as.owner, "2026-09-01")) as { id: string };
    expect(await messageOf(cancelRun(as.accountant, id, "Not needed"))).toMatch(/owner or the payroll administrator/);
    expect(await messageOf(cancelRun(as.owner, id, ""))).toMatch(/Say why/);
    await cancelRun(as.payroll_administrator, id, "Paid outside the system");
    const again = (await workOutRun(as.owner, "2026-09-01")) as { id: string };
    expect(again.id).not.toBe(id);
    const runs = await listRuns(as.auditor);
    expect(runs.filter((r) => r.month === "2026-09-01").map((r) => r.status).sort()).toEqual(["cancelled", "draft"]);
  });

  it("is read by payroll's readers only, and worked out by its keepers", async () => {
    await expect(listRuns(salesperson)).rejects.toThrow(/does not include payroll/);
    expect(await messageOf(workOutRun(as.accountant, "2026-08-01"))).toMatch(/owner or the payroll administrator/);
    expect(await messageOf(workOutRun(as.owner, "2099-01-01"))).toMatch(/not begun/);
    // Straight at the database: an accountant writes no run, a salesperson sees none.
    expect(
      await codeOf(
        as.accountant,
        sql`insert into public.payroll_runs (tenant_id, month, status, created_by, updated_by) values (${tenant}, '2026-08-01', 'draft', ${userIds.accountant}, ${userIds.accountant})`,
      ),
    ).toBe("42501");
    const [seen] = await withTenant(ali, tenant, (tx) => tx.execute<{ n: number }>(sql`select count(*)::int as n from public.payroll_runs`));
    expect(seen.n).toBe(0);
  });
});

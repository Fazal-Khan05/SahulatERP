import { randomUUID } from "node:crypto";
import Decimal from "decimal.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb } from "@/db";
import { seedAccounts } from "@/modules/ledger/commands";
import { openFiscalYear } from "@/modules/numbering/commands";
import { saveEmployee, setPay } from "@/modules/payroll/commands";
import { approveRun, reviewRun, workOutRun } from "@/modules/payroll-runs/commands";
import { getRun } from "@/modules/payroll-runs/queries";
import type { TenantContext } from "@/modules/tenant/rules";
import { adminSql, deleteTenants, hasAdminDb, type AdminSql } from "../../../tests/support/admin-db";
import { issueLoan, repayLoan, saveBankAccount } from "./commands";
import { getAnnualStatement, getBankFile, listLoans } from "./queries";
import { checkBankFile } from "./rules";

// Step 42 against a real database, through the app's own path: loans to staff paid out of cash,
// their instalments taken from pay when a run is approved (and credited back to the loans, not
// taken off the salaries' cost), all that is owed taken from a leaver's last pay and the rest
// repaid in cash (final settlement), the salary bank file validating, and the year's statement.
// Skipped when the database URLs are absent.

const hasDb = hasAdminDb() && Boolean(process.env.DATABASE_URL);
const PREFIX = "zz-staff-loans-test";
const tenant = randomUUID();
const roles = ["owner", "payroll_administrator", "accountant", "auditor"] as const;
const userIds = Object.fromEntries(roles.map((role) => [role, randomUUID()])) as Record<(typeof roles)[number], string>;
const ctx = (userId: string, role: TenantContext["role"]): TenantContext => ({ userId, email: `${role}-${userId.slice(0, 4)}@loans.test`, tenantId: tenant, tenantName: "x", role, branchIds: null });
const as = Object.fromEntries(roles.map((role) => [role, ctx(userIds[role], role)])) as Record<(typeof roles)[number], TenantContext>;

let admin: AdminSql;
let cash: string;
let ali: string;
let sara: string;
const money = (value: Decimal) => value.toFixed(2);
async function messageOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return "went through";
  } catch (error) {
    return (error as Error).message;
  }
}
async function journalLines(journalId: string): Promise<Record<string, string>> {
  const rows = await admin<{ code: string; net: string }[]>`
    select a.code, sum(l.debit - l.credit)::numeric(20,2)::text as net from public.journal_lines l join public.accounts a on a.id = l.account_id
    where l.journal_id = ${journalId} group by a.code order by a.code`;
  return Object.fromEntries(rows.map((r) => [r.code, r.net]));
}
async function approveMonth(month: string): Promise<string> {
  const { id } = (await workOutRun(as.payroll_administrator, month)) as { id: string };
  await reviewRun(as.payroll_administrator, id);
  await approveRun(as.accountant, id);
  return id;
}

describe.skipIf(!hasDb)("loans to staff, the bank file and the year's statement", () => {
  beforeAll(async () => {
    admin = adminSql();
    const stale = await admin<{ id: string }[]>`select id from public.tenants where name like ${PREFIX + "%"}`;
    await deleteTenants(admin, stale.map((r) => r.id));
    await admin`insert into public.tenants (id, name, created_by) values (${tenant}, ${PREFIX}, ${userIds.owner})`;
    await admin`insert into public.memberships ${admin(roles.map((role) => ({ tenant_id: tenant, user_id: userIds[role], email: as[role].email, role, branch_ids: null, created_by: userIds.owner })))}`;
    await seedAccounts(as.owner, "trading");
    await openFiscalYear(as.owner, { month: "7", year: "2026" });
    cash = (await admin<{ id: string }[]>`select id from public.accounts where tenant_id = ${tenant} and code = '1111'`)[0].id;
    const employee = (over: Record<string, unknown>) => ({ province: "punjab", payBasis: "monthly", joinedOn: "2026-07-01", ...over });
    ali = (await saveEmployee(as.owner, null, employee({ code: "E-001", name: "Ali Raza" }))).id;
    sara = (await saveEmployee(as.owner, null, employee({ code: "E-002", name: "Sara Khan", leftOn: "2026-10-20" }))).id;
    await setPay(as.owner, ali, { component: "basic", amount: "100000", effectiveFrom: "2026-07-01" });
    await setPay(as.owner, sara, { component: "basic", amount: "60000", effectiveFrom: "2026-07-01" });
  }, 120_000);

  afterAll(async () => {
    await deleteTenants(admin, [tenant]);
    await admin.end();
    await closeDb();
  });

  it("pays a loan out of cash into Loans and advances to staff", async () => {
    expect(await messageOf(issueLoan(as.payroll_administrator, { employeeId: ali, date: "2026-08-05", amount: "30000", instalment: "10000", accountId: cash }))).toBe(
      "A loan to staff is paid by the owner or an accountant.",
    );
    const { number } = await issueLoan(as.accountant, { employeeId: ali, date: "2026-08-05", amount: "30000", instalment: "10000", accountId: cash, note: "Wedding" });
    expect(number).toMatch(/^SL-2627-\d{5}$/);
    await issueLoan(as.owner, { employeeId: sara, date: "2026-09-01", amount: "50000", instalment: "5000", accountId: cash });
    const [journal] = await admin<{ id: string }[]>`select id from public.journals where tenant_id = ${tenant} and document_number = ${number}`;
    expect(await journalLines(journal.id)).toEqual({ "1111": "-30000.00", "1240": "30000.00" });
    expect(await messageOf(issueLoan(as.owner, { employeeId: sara, date: "2026-11-01", amount: "1000", instalment: "100", accountId: cash }))).toBe("A loan is made to someone employed on that day.");
  });

  it("takes each month's instalment from pay, and credits it back to the loan, not off the salaries' cost", async () => {
    const september = await approveMonth("2026-09-01");
    const run = (await getRun(as.owner, september))!;
    const slip = (code: string) => run.payslips.find((p) => p.code === code)!;
    expect(slip("E-001").lines.filter((l) => l.code === "loan").map((l) => [l.label, money(l.amount)])).toEqual([[expect.stringMatching(/^Loan SL-2627-\d{5}$/), "10000.00"]]);
    expect([money(run.loanRecovery), money(run.deductions)]).toEqual(["15000.00", "15000.00"]);
    // Salaries and wages carry the whole pay: 100,000 and 60,000.
    const lines = await journalLines(run.journalId!);
    expect([lines["5210"], lines["1240"], lines["2300"]]).toEqual(["160000.00", "-15000.00", money(run.net.negated())]);
    const loans = await listLoans(as.auditor);
    expect(loans.map((l) => [l.code, money(l.recovered), money(l.owed)]).sort()).toEqual([
      ["E-001", "10000.00", "20000.00"],
      ["E-002", "5000.00", "45000.00"],
    ]);
  });

  it("final settlement: a leaver's last pay takes all that is owed, as far as it goes, and the rest is repaid in cash", async () => {
    const october = await approveMonth("2026-10-01");
    const run = (await getRun(as.owner, october))!;
    const saraSlip = run.payslips.find((p) => p.code === "E-002")!;
    // 20 of October's 31 days: 38,709.68. Everything left after her tax goes to the loan; she takes home nothing.
    expect(money(saraSlip.earnings)).toBe("38709.68");
    const taken = saraSlip.lines.find((l) => l.code === "loan")!.amount;
    expect(money(taken)).toBe(money(saraSlip.earnings.minus(saraSlip.tax)));
    expect(money(saraSlip.net)).toBe("0.00");
    const loan = (await listLoans(as.owner, sara))[0];
    expect(money(loan.owed)).toBe(money(new Decimal(45000).minus(taken)));
    // The rest is repaid in cash; no more than is owed.
    expect(await messageOf(repayLoan(as.accountant, loan.id, { date: "2026-11-01", amount: loan.owed.plus(1).toFixed(2), accountId: cash }))).toBe(
      "Repay no more than is owed on the loan, and give a loan an instalment no more than itself.",
    );
    const { number } = await repayLoan(as.accountant, loan.id, { date: "2026-11-01", amount: loan.owed.toFixed(2), accountId: cash });
    expect(number).toMatch(/^LR-2627-\d{5}$/);
    const settled = (await listLoans(as.owner, sara))[0];
    expect([money(settled.owed), settled.movements.map((m) => m.kind)]).toEqual(["0.00", ["from_pay", "from_pay", "repaid"]]);
    const [balance] = await admin<{ net: string }[]>`
      select sum(l.debit - l.credit)::numeric(20,2)::text as net from public.journal_lines l join public.accounts a on a.id = l.account_id where a.tenant_id = ${tenant} and a.code = '1240'`;
    // Ali still owes 10,000 (30,000 less September's and October's instalments); Sara nothing.
    expect(balance.net).toBe("10000.00");
  });

  it("refuses an instalment more than is owed by the time the run is approved", async () => {
    const { id } = (await workOutRun(as.payroll_administrator, "2026-11-01")) as { id: string };
    await reviewRun(as.payroll_administrator, id);
    const loan = (await listLoans(as.owner, ali))[0];
    await repayLoan(as.owner, loan.id, { date: "2026-11-02", amount: "5000", accountId: cash });
    expect(await messageOf(approveRun(as.accountant, id))).toMatch(/out of date/);
    await workOutRun(as.payroll_administrator, "2026-11-01");
    const slip = (await getRun(as.owner, id))!.payslips.find((p) => p.code === "E-001")!;
    expect(money(slip.lines.find((l) => l.code === "loan")!.amount)).toBe("5000.00");
  });

  it("acceptance: the salary bank file validates, once everyone paid has an IBAN", async () => {
    const [september] = await admin<{ id: string }[]>`select id from public.payroll_runs where tenant_id = ${tenant} and month = '2026-09-01'`;
    expect(await getBankFile(as.accountant, september.id)).toEqual({ missing: [{ code: "E-001", name: "Ali Raza" }, { code: "E-002", name: "Sara Khan" }] });
    expect(await messageOf(saveBankAccount(as.payroll_administrator, ali, { bankName: "Standard Chartered", accountTitle: "Ali Raza", iban: "PK36SCBL0000001123456703" }))).toMatch(/Enter the IBAN/);
    await saveBankAccount(as.payroll_administrator, ali, { bankName: "Standard Chartered", accountTitle: "Ali Raza", iban: "pk36 scbl 0000 0011 2345 6702" });
    await saveBankAccount(as.owner, sara, { bankName: "HBL", accountTitle: "Sara Khan", iban: "PK72HABB0012345678901234" });
    const file = (await getBankFile(as.accountant, september.id)) as { fileName: string; csv: string };
    expect(file.fileName).toMatch(/^salaries-PR-2627-\d{5}\.csv$/);
    expect(checkBankFile(file.csv)).toEqual([]);
    const run = (await getRun(as.owner, september.id))!;
    expect(file.csv.split("\r\n").slice(1, 3)).toEqual(
      run.payslips.map((p, index) => `${index + 1},${p.code === "E-001" ? "PK36SCBL0000001123456702,ALI RAZA" : "PK72HABB0012345678901234,SARA KHAN"},${money(p.net)},SALARY SEP 2026 ${p.code}`),
    );
    // The audit log keeps the IBAN's last four only.
    const [logged] = await admin<{ after: { iban: string } }[]>`select after from public.audit_log where tenant_id = ${tenant} and action = 'employee.bank_account' and entity_id = ${ali}`;
    expect(logged.after.iban).toBe("…6702");
  });

  it("gives the year's salary statement from the approved payslips", async () => {
    const { rows, csv } = await getAnnualStatement(as.auditor, 2026);
    expect(rows.map((r) => [r.code, r.months])).toEqual([
      ["E-001", 2],
      ["E-002", 2],
    ]);
    expect(csv.split("\r\n")[1]).toBe("Code,Name,CNIC,Months paid,Pay and commission,Taxable salary,Income tax deducted");
  });
});

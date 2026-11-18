import "server-only";
import Decimal from "decimal.js";
import { sql } from "drizzle-orm";
import { isUuid, withTenant } from "@/db";
import { UserError } from "@/lib/errors";
import { requirePayroll } from "@/modules/payroll/queries";
import type { TenantContext } from "@/modules/tenant/rules";
import { annualStatementCsv, bankFile, checkBankFile, type AnnualRow } from "./rules";

// What Step 42's screens read: bank details, loans, the run's bank file and the year's statement.
// Payroll's readers read them; the policies decide which people.

const exact = (value: string | null) => new Decimal(value ?? "0");

export type BankAccountRow = { bankName: string; accountTitle: string; iban: string };

export async function getBankAccount(ctx: TenantContext, employeeId: string): Promise<BankAccountRow | null> {
  requirePayroll(ctx);
  if (!isUuid(employeeId)) return null;
  const [row] = await withTenant(ctx.userId, ctx.tenantId, (tx) =>
    tx.execute<{ bank_name: string; account_title: string; iban: string }>(sql`
      select bank_name, account_title, iban from public.employee_bank_accounts where tenant_id = ${ctx.tenantId} and employee_id = ${employeeId}`),
  );
  return row ? { bankName: row.bank_name, accountTitle: row.account_title, iban: row.iban } : null;
}

export type LoanRow = {
  id: string;
  number: string;
  employeeId: string;
  code: string;
  name: string;
  leftOn: string | null;
  issuedOn: string;
  amount: Decimal;
  instalment: Decimal;
  recovered: Decimal;
  owed: Decimal;
  movements: { date: string; kind: "from_pay" | "repaid"; amount: Decimal; reference: string | null }[];
};

/** The company's loans to staff, those still owed on first; one person's when asked. */
export async function listLoans(ctx: TenantContext, employeeId?: string): Promise<LoanRow[]> {
  requirePayroll(ctx);
  if (employeeId !== undefined && !isUuid(employeeId)) return [];
  return withTenant(ctx.userId, ctx.tenantId, async (tx) => {
    const loans = await tx.execute<{ id: string; number: string; employee_id: string; code: string; name: string; left_on: string | null; issued_on: string; amount: string; instalment: string; recovered: string }>(sql`
      select s.id, s.number, s.employee_id, e.code, e.name, e.left_on::text, s.issued_on::text, s.amount::text, s.instalment::text, s.recovered::text
      from public.staff_loans s join public.employees e on e.tenant_id = s.tenant_id and e.id = s.employee_id
      where s.tenant_id = ${ctx.tenantId} and (${employeeId ?? null}::uuid is null or s.employee_id = ${employeeId ?? null}::uuid)
      order by s.recovered >= s.amount, s.issued_on desc, s.number desc
      limit 500`);
    const movements =
      loans.length === 0
        ? []
        : await tx.execute<{ loan_id: string; movement_date: string; kind: "from_pay" | "repaid"; amount: string; reference: string | null }>(sql`
            select m.loan_id, m.movement_date::text, m.kind, m.amount::text, coalesce(m.number, r.number) as reference
            from public.staff_loan_movements m left join public.payroll_runs r on r.tenant_id = m.tenant_id and r.id = m.run_id
            where m.tenant_id = ${ctx.tenantId} and m.loan_id = any(${`{${loans.map((l) => l.id).join(",")}}`}::uuid[])
            order by m.movement_date, m.created_at`);
    return loans.map((l) => ({
      id: l.id,
      number: l.number,
      employeeId: l.employee_id,
      code: l.code,
      name: l.name,
      leftOn: l.left_on,
      issuedOn: l.issued_on,
      amount: exact(l.amount),
      instalment: exact(l.instalment),
      recovered: exact(l.recovered),
      owed: exact(l.amount).minus(exact(l.recovered)),
      movements: movements.filter((m) => m.loan_id === l.id).map((m) => ({ date: m.movement_date, kind: m.kind, amount: exact(m.amount), reference: m.reference })),
    }));
  });
}

type Person = { id: string; code: string; name: string };
/** Bank details changed after the run was approved: who changed them, and when. */
export type ChangedSince = Person & { by: string | null; at: string };

export type BankFileOutcome =
  | { fileName: string; csv: string; changed: ChangedSince[] }
  | { missing: Person[] }
  | { problems: string[] }
  | null;

/**
 * The bank file for an approved or paid run: one line for each person with something to take
 * home, to the IBAN on record. Null when the run is not this company's or not approved; the people
 * with no bank account on record instead, when any has none; what a bank would refuse instead,
 * when the file fails its own checks (an IBAN on two people's pages, a name with no letters a bank
 * takes). With the file come the people whose bank details were changed after the run was
 * approved, for whoever uploads it to see.
 */
export async function getBankFile(ctx: TenantContext, runId: string): Promise<BankFileOutcome> {
  requirePayroll(ctx);
  if (!isUuid(runId)) return null;
  return withTenant(ctx.userId, ctx.tenantId, async (tx) => {
    const [run] = await tx.execute<{ month: string; number: string | null; status: string; approved_at: string | null }>(sql`
      select month::text, number, status, approved_at::text from public.payroll_runs where tenant_id = ${ctx.tenantId} and id = ${runId}`);
    if (!run || (run.status !== "approved" && run.status !== "paid")) return null;
    const rows = await tx.execute<{ id: string; code: string; name: string; net: string; iban: string | null; title: string | null; changed_at: string | null; changed_by: string | null }>(sql`
      select e.id, e.code, e.name, p.net::text, b.iban, b.account_title as title,
        case when b.updated_at > r.approved_at then to_char(b.updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') end as changed_at,
        -- Who, where this member may read the company's members (the owner, an auditor); else unsaid.
        case when b.updated_at > r.approved_at then m.email end as changed_by
      from public.payslips p
      join public.payroll_runs r on r.tenant_id = p.tenant_id and r.id = p.run_id
      join public.employees e on e.tenant_id = p.tenant_id and e.id = p.employee_id
      left join public.employee_bank_accounts b on b.tenant_id = p.tenant_id and b.employee_id = p.employee_id
      left join public.memberships m on m.tenant_id = b.tenant_id and m.user_id = b.updated_by
      where p.tenant_id = ${ctx.tenantId} and p.run_id = ${runId} and p.net > 0
      order by lower(e.code)`);
    const person = (r: (typeof rows)[number]): Person => ({ id: r.id, code: r.code, name: r.name });
    const missing = rows.filter((r) => r.iban === null).map(person);
    if (missing.length > 0) return { missing };
    // Three letters, whatever the server's language data says (some write "Sept").
    const month = `${["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"][Number(run.month.slice(5, 7)) - 1]} ${run.month.slice(0, 4)}`;
    const csv = bankFile(rows.map((r) => ({ iban: r.iban!, name: r.title ?? r.name, amount: exact(r.net), reference: `SALARY ${month} ${r.code}` })));
    // Checked before it is given: each problem named by the person on that line.
    const problems = checkBankFile(csv).map((problem) => {
      const line = /^Line (\d+): (.*)$/.exec(problem);
      const row = line ? rows[Number(line[1]) - 2] : undefined;
      return row && line ? `${row.code} ${row.name}: ${line[2]}` : problem;
    });
    if (problems.length > 0) return { problems };
    const changed = rows.filter((r) => r.changed_at !== null).map((r) => ({ ...person(r), by: r.changed_by, at: r.changed_at! }));
    return { fileName: `salaries-${run.number ?? run.month.slice(0, 7)}.csv`, csv, changed };
  });
}

/** The year's salary statement (s.149): each person's approved payslips from July to June. */
export async function getAnnualStatement(ctx: TenantContext, julyOf: number): Promise<{ rows: AnnualRow[]; csv: string }> {
  requirePayroll(ctx);
  if (!Number.isInteger(julyOf) || julyOf < 2000 || julyOf > 2100) throw new UserError("Choose a tax year.");
  const rows = await withTenant(ctx.userId, ctx.tenantId, (tx) =>
    tx.execute<{ code: string; name: string; cnic: string | null; months: number; pay: string; taxable: string; tax: string }>(sql`
      select e.code, e.name, e.cnic, count(*)::int as months, sum(p.earnings + p.commission)::text as pay, sum(p.taxable)::text as taxable, sum(p.tax)::text as tax
      from public.payslips p
      join public.payroll_runs r on r.tenant_id = p.tenant_id and r.id = p.run_id
      join public.employees e on e.tenant_id = p.tenant_id and e.id = p.employee_id
      where p.tenant_id = ${ctx.tenantId} and r.status in ('approved', 'paid')
        and r.month >= make_date(${julyOf}, 7, 1) and r.month < make_date(${julyOf + 1}, 7, 1)
      group by e.id, e.code, e.name, e.cnic
      order by lower(e.code)`),
  );
  const annual = rows.map((r) => ({ code: r.code, name: r.name, cnic: r.cnic, months: r.months, pay: exact(r.pay), taxable: exact(r.taxable), tax: exact(r.tax) }));
  return { rows: annual, csv: annualStatementCsv(annual, julyOf) };
}

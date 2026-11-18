import "server-only";
import { sql } from "drizzle-orm";
import { audit, isUuid, withTenant } from "@/db";
import { UserError, pgCode } from "@/lib/errors";
import { todayIso } from "@/lib/format";
import { AMOUNT_SCALE } from "@/lib/money";
import { periodRefusal } from "@/modules/numbering/rules";
import { can, type TenantContext } from "@/modules/tenant/rules";
import { readBankAccount, readLoan, readRepayment, type RawBankAccount, type RawLoan } from "./rules";

// Step 42's commands: a person's bank account (kept by those who keep payroll), and loans to staff
// and their repayment in cash (the owner's or an accountant's, as money out and in; the
// database's own acts, drizzle/0034_payroll_extras.sql).

function refusal(error: unknown, date: string): UserError | null {
  const code = pgCode(error);
  const closed = periodRefusal(code, date);
  if (closed) return new UserError(closed);
  if (code === "SE370") return new UserError("Bank details stay with their person.");
  if (code === "SE371") return new UserError("That day cannot be used: not before the loan was made, and not a day still to come.");
  if (code === "SE372") return new UserError("Repay no more than is owed on the loan, and give a loan an instalment no more than itself.");
  if (code === "SE373") return new UserError("A loan is made to someone employed on that day.");
  if (code === "SE374") return new UserError("Choose a cash or bank account that is in use.");
  if (code === "SE375") return new UserError("That loan is not in this company.");
  if (code === "23503") return new UserError("That person is not on the payroll.");
  if (code === "23505") return new UserError("Someone else saved these details at the same moment. Reload the page and look again.");
  if (code === "42501") return new UserError("Your role does not permit this action.");
  return null;
}

/** Saves the bank account a person's salary is paid into: a Pakistani IBAN whose check digits are right. */
export async function saveBankAccount(ctx: TenantContext, employeeId: unknown, raw: RawBankAccount): Promise<void> {
  if (!can(ctx.role, "payroll.manage")) throw new UserError("Only the owner or the payroll administrator keeps bank details.");
  if (!isUuid(employeeId)) throw new UserError("That person is not on the payroll.");
  const read = readBankAccount(raw);
  if (!read.ok) throw new UserError(read.reason);
  const { bankName, accountTitle, iban } = read.account;
  await withTenant(ctx.userId, ctx.tenantId, async (tx) => {
    try {
      const [before] = await tx.execute<{ bank_name: string; account_title: string; iban: string }>(sql`
        select bank_name, account_title, iban from public.employee_bank_accounts where tenant_id = ${ctx.tenantId} and employee_id = ${employeeId} for update`);
      if (before) {
        await tx.execute(sql`update public.employee_bank_accounts set bank_name = ${bankName}, account_title = ${accountTitle}, iban = ${iban}, updated_by = ${ctx.userId}, updated_at = now()
          where tenant_id = ${ctx.tenantId} and employee_id = ${employeeId}`);
      } else {
        await tx.execute(sql`insert into public.employee_bank_accounts (tenant_id, employee_id, bank_name, account_title, iban, created_by, updated_by)
          values (${ctx.tenantId}, ${employeeId}, ${bankName}, ${accountTitle}, ${iban}, ${ctx.userId}, ${ctx.userId})`);
      }
      // The IBAN's last four only: a bank account is not written out whole in the log.
      const hint = (value: string) => `…${value.slice(-4)}`;
      await audit(tx, ctx, {
        action: "employee.bank_account",
        entity: "employee",
        entityId: employeeId,
        before: before ? { bank: before.bank_name, title: before.account_title, iban: hint(before.iban) } : null,
        after: { bank: bankName, title: accountTitle, iban: hint(iban) },
      });
    } catch (error) {
      throw refusal(error, todayIso(new Date())) ?? error;
    }
  });
}

/** Pays a loan or an advance to someone on the payroll out of a cash or bank account. Returns its number. */
export async function issueLoan(ctx: TenantContext, raw: RawLoan): Promise<{ number: string }> {
  if (!can(ctx.role, "staff_loan.manage")) throw new UserError("A loan to staff is paid by the owner or an accountant.");
  const read = readLoan(raw, todayIso(new Date()));
  if (!read.ok) throw new UserError(read.reason);
  const { employeeId, date, amount, instalment, accountId, note } = read.loan;
  if (!isUuid(employeeId) || !isUuid(accountId)) throw new UserError("Choose the person and the account.");
  return withTenant(ctx.userId, ctx.tenantId, async (tx) => {
    try {
      const [row] = await tx.execute<{ number: string }>(sql`
        select app.issue_staff_loan(${employeeId}::uuid, ${date}::date, ${amount.toFixed(AMOUNT_SCALE)}::numeric, ${instalment.toFixed(AMOUNT_SCALE)}::numeric, ${accountId}::uuid, ${note}) as number`);
      return { number: row.number };
    } catch (error) {
      throw refusal(error, date) ?? error;
    }
  });
}

/** Records what is still owed on a loan repaid in cash. Returns the repayment's number. */
export async function repayLoan(ctx: TenantContext, loanId: unknown, raw: { date?: unknown; amount?: unknown; accountId?: unknown }): Promise<{ number: string }> {
  if (!can(ctx.role, "staff_loan.manage")) throw new UserError("A loan is repaid to the owner or an accountant.");
  if (!isUuid(loanId)) throw new UserError("That loan is not in this company.");
  const read = readRepayment(raw, todayIso(new Date()));
  if (!read.ok) throw new UserError(read.reason);
  if (!isUuid(read.accountId)) throw new UserError("Choose the cash or bank account it was paid into.");
  return withTenant(ctx.userId, ctx.tenantId, async (tx) => {
    try {
      const [row] = await tx.execute<{ number: string }>(sql`
        select app.repay_staff_loan(${loanId}::uuid, ${read.date}::date, ${read.amount.toFixed(AMOUNT_SCALE)}::numeric, ${read.accountId}::uuid) as number`);
      return { number: row.number };
    } catch (error) {
      throw refusal(error, read.date) ?? error;
    }
  });
}

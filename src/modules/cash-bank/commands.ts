import "server-only";
import { and, eq, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { audit, isUuid, withTenant, type Tx } from "@/db";
import { UserError, pgCode } from "@/lib/errors";
import { todayIso } from "@/lib/format";
import { formatAmount } from "@/lib/money";
import Decimal from "decimal.js";
import { addAccount, setAccountArchived } from "@/modules/ledger/commands";
import { accounts } from "@/modules/ledger/schema";
import { periodRefusal } from "@/modules/numbering/rules";
import { can, type TenantContext } from "@/modules/tenant/rules";
import { readBankDetails, readCancel, readExpense, readNewAccount, readTransfer, type Expense, type RawCancel, type RawExpense, type RawNewAccount, type RawTransfer } from "./rules";

// The commands behind the cash and bank screens (Step 34). A bank account's details are written
// by the app under row-level security. Transfers and expenses are not: each command only asks the
// database's own function, which writes the document and its journal in one act, or refuses
// (drizzle/0038_cash_bank.sql).

export function requireManager(ctx: TenantContext): void {
  if (!can(ctx.role, "cash_bank.manage")) throw new UserError("Only the owner or an accountant moves or spends the company's money.");
}

/** What the database's refusals mean, in words; null for one that is not known. */
export function refusal(error: unknown, date: string | null): unknown {
  if (error instanceof UserError) return error;
  const code = pgCode(error);
  const closed = date ? periodRefusal(code, date) : null;
  if (closed) return new UserError(closed);
  if (code === "SE331") return new UserError("Choose two different cash or bank accounts of the company that are in use.");
  if (code === "SE332") return new UserError("That will not do: enter an amount in rupees and paisa above nothing, and say why when cancelling.");
  if (code === "SE342") return new UserError("This form was already sent with other figures, and recorded then. Reload the page to enter another.");
  if (code === "SE341") return new UserError("An account it would post to is archived. Restore the account first, under Settings, Chart of accounts.");
  if (code === "SE333") return new UserError("That date will not do: it has not come yet, or it is before the document's own date.");
  if (code === "SE334") return new UserError("That is not in this company.");
  if (code === "SE335") return new UserError("It has already been cancelled.");
  if (code === "SE336") return new UserError("Choose one of your branches.");
  if (code === "SE337") return new UserError("Choose the supplier or name who was paid, not both; a supplier chosen must be one of the company's, in use.");
  if (code === "SE338") return new UserError("Tax is withheld only from a supplier on the list, and only by a company that withholds (Purchases, settings).");
  if (code === "SE339") return new UserError("A line, or the tax withheld, will not do: check the accounts, the amounts and the tax lines chosen.");
  if (code === "SE230") return new UserError("That withholding line is not in force on that date. Check the tax rates.");
  if (code === "SE340") return new UserError("A cash or bank account is archived only when it holds nothing.");
  if (code === "SE380") return new UserError("Tax withheld on this expense has been paid to the government under a challan, so the expense stands. Put a mistake right with the supplier and a new entry.");
  if (code === "42501") return new UserError("Your role cannot do that.");
  return null;
}
const rethrow = (error: unknown, date: string | null) => {
  const known = refusal(error, date);
  throw known ?? error;
};

/** Adds a cash account (petty cash is one) or a bank account, under its heading of the chart, with a bank account's details. */
export async function addCashBankAccount(ctx: TenantContext, raw: RawNewAccount): Promise<{ id: string }> {
  requireManager(ctx);
  const read = readNewAccount(raw);
  if (!read.ok) throw new UserError(read.reason);
  const wanted = read.account;
  // The heading it goes under: the chart's locked Cash accounts or Bank accounts.
  const heading = await withTenant(ctx.userId, ctx.tenantId, async (tx) => {
    const [row] = await tx
      .select({ id: accounts.id })
      .from(accounts)
      .where(and(eq(accounts.tenantId, ctx.tenantId), eq(accounts.controlType, wanted.kind), eq(accounts.isGroup, true), eq(accounts.isControl, true)));
    return row?.id ?? null;
  });
  if (!heading) throw new UserError("The chart of accounts has no heading for cash or bank accounts. Set the company up first.");
  const added = await addAccount(ctx, { parentId: heading, name: wanted.name, code: "", kind: "account" });
  if (wanted.kind === "bank" && (wanted.bankName !== null || wanted.accountNumber !== null)) await saveBankDetails(ctx, added.id, wanted);
  return { id: added.id };
}

/** Writes a bank account's bank and number, or changes them. */
export async function saveBankDetails(ctx: TenantContext, accountId: unknown, raw: { bankName?: unknown; accountNumber?: unknown }): Promise<void> {
  requireManager(ctx);
  if (!isUuid(accountId)) throw new UserError("That account is not in this company.");
  const read = readBankDetails(raw);
  if (!read.ok) throw new UserError(read.reason);
  try {
    await withTenant(ctx.userId, ctx.tenantId, async (tx) => {
      const [before] = await tx.execute<{ bank_name: string | null; account_number: string | null }>(sql`
        select bank_name, account_number from public.cash_bank_accounts where tenant_id = ${ctx.tenantId} and account_id = ${accountId}`);
      await tx.execute(sql`
        insert into public.cash_bank_accounts (tenant_id, account_id, bank_name, account_number, created_by, updated_by)
        values (${ctx.tenantId}, ${accountId}, ${read.bankName}, ${read.accountNumber}, ${ctx.userId}, ${ctx.userId})
        on conflict (tenant_id, account_id) do update set bank_name = excluded.bank_name, account_number = excluded.account_number, updated_at = now(), updated_by = excluded.updated_by`);
      await audit(tx, ctx, {
        action: "bank_account.details",
        entity: "account",
        entityId: accountId,
        before: before ? { bank: before.bank_name, number: before.account_number } : null,
        after: { bank: read.bankName, number: read.accountNumber },
      });
    });
  } catch (error) {
    if (pgCode(error) === "SE330") throw new UserError("Bank details belong to a bank account of the company.");
    throw error;
  }
}

/** Archives a cash or bank account, only when everything ever posted to it adds up to nil. */
export async function archiveCashBankAccount(ctx: TenantContext, accountId: unknown, loadedAt?: unknown): Promise<void> {
  requireManager(ctx);
  // What an account holds is the whole company's: only someone who works in every branch sees it whole.
  if (ctx.branchIds !== null) throw new UserError("A cash or bank account is archived by someone who works in every branch.");
  if (!isUuid(accountId)) throw new UserError("That account is not in this company.");
  const balance = await withTenant(ctx.userId, ctx.tenantId, async (tx) => {
    const [row] = await tx.execute<{ balance: string | null; kind: string | null }>(sql`
      select (select coalesce(sum(l.debit - l.credit), 0) from public.journal_lines l where l.tenant_id = a.tenant_id and l.account_id = a.id)::text as balance, a.control_type as kind
      from public.accounts a where a.tenant_id = ${ctx.tenantId} and a.id = ${accountId} and not a.is_group`);
    if (!row || (row.kind !== "cash" && row.kind !== "bank")) throw new UserError("That is not one of the company's cash or bank accounts.");
    return new Decimal(row.balance ?? "0");
  });
  if (!balance.isZero()) throw new UserError(`This account holds ${formatAmount(balance)}. Move it out first: an account is archived only when it holds nothing.`);
  try {
    await setAccountArchived(ctx, accountId, true, loadedAt);
  } catch (error) {
    rethrow(error, null);
  }
}

/** Moves money from one cash or bank account to another. Returns its number. */
export async function recordTransfer(ctx: TenantContext, raw: RawTransfer & { clientKey?: unknown }): Promise<{ number: string }> {
  requireManager(ctx);
  const read = readTransfer(raw, todayIso(new Date()));
  if (!read.ok) throw new UserError(read.reason);
  const t = read.transfer;
  // Sent twice from the same form, it is recorded once.
  const key = isUuid(raw.clientKey) ? raw.clientKey : randomUUID();
  try {
    return await withTenant(ctx.userId, ctx.tenantId, async (tx) => {
      const [row] = await tx.execute<{ number: string }>(sql`
        select app.record_cash_transfer(${key}::uuid, ${t.fromId}::uuid, ${t.toId}::uuid, ${t.date}::date, ${t.amount.toFixed(2)}::numeric, ${t.reference}, ${t.memo}) as number`);
      return { number: row.number };
    });
  } catch (error) {
    throw refusal(error, t.date) ?? error;
  }
}

export async function cancelTransfer(ctx: TenantContext, id: unknown, raw: RawCancel): Promise<void> {
  requireManager(ctx);
  if (!isUuid(id)) throw new UserError("That is not in this company.");
  const read = readCancel(raw, todayIso(new Date()));
  if (!read.ok) throw new UserError(read.reason);
  try {
    await withTenant(ctx.userId, ctx.tenantId, (tx) => tx.execute(sql`select app.cancel_cash_transfer(${id}::uuid, ${read.date}::date, ${read.reason})`));
  } catch (error) {
    throw refusal(error, read.date) ?? error;
  }
}

/**
 * Records one expense inside the caller's transaction, by asking the database's own function: the
 * only way an expense, its journal and its number are written. Sent again with the same key it is
 * recorded once. The caller has checked the role and reads the refusal (refusal, above).
 */
export async function recordExpenseIn(tx: Tx, e: Expense, key: string): Promise<{ id: string; number: string }> {
  const lines = JSON.stringify(e.lines.map((line) => ({ account: line.accountId, description: line.description, amount: line.amount.toFixed(2) })));
  const [row] = await tx.execute<{ number: string }>(sql`
    select app.record_expense(${key}::uuid, ${e.date}::date, ${e.accountId}::uuid, ${e.supplierId}::uuid, ${e.payee}, ${e.branchId}::uuid, ${e.reference}, ${e.memo},
      ${lines}::jsonb, ${e.incomeTaxCode}, ${e.provincialTaxCode}) as number`);
  return { id: key, number: row.number };
}

/** Records money spent out of a cash or bank account, with any tax withheld. Returns its id and number. */
export async function recordExpense(ctx: TenantContext, raw: RawExpense & { clientKey?: unknown }): Promise<{ id: string; number: string }> {
  requireManager(ctx);
  const read = readExpense(raw, todayIso(new Date()));
  if (!read.ok) throw new UserError(read.reason);
  const e = read.expense;
  // Sent twice from the same form, it is recorded once: the key is the expense's own id.
  const key = isUuid(raw.clientKey) ? raw.clientKey : randomUUID();
  try {
    return await withTenant(ctx.userId, ctx.tenantId, (tx) => recordExpenseIn(tx, e, key));
  } catch (error) {
    // A row id or account id the form could not have sent.
    if (pgCode(error) === "22P02") throw new UserError("Choose the accounts again: one of them is not in this company.");
    throw refusal(error, e.date) ?? error;
  }
}

export async function cancelExpense(ctx: TenantContext, id: unknown, raw: RawCancel): Promise<void> {
  requireManager(ctx);
  if (!isUuid(id)) throw new UserError("That is not in this company.");
  const read = readCancel(raw, todayIso(new Date()));
  if (!read.ok) throw new UserError(read.reason);
  try {
    await withTenant(ctx.userId, ctx.tenantId, (tx) => tx.execute(sql`select app.cancel_expense(${id}::uuid, ${read.date}::date, ${read.reason})`));
  } catch (error) {
    throw refusal(error, read.date) ?? error;
  }
}

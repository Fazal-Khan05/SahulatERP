import "server-only";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { isUuid, withTenant } from "@/db";
import { UserError, pgCode } from "@/lib/errors";
import { todayIso } from "@/lib/format";
import { refusal as cashBankRefusal, requireManager } from "@/modules/cash-bank/commands";
import { readCancel, type RawCancel } from "@/modules/cash-bank/rules";
import type { TenantContext } from "@/modules/tenant/rules";
import { readMoneyInOut, type RawMoneyInOut } from "./rules";

// Money in and money out (batch A). Nothing here writes a row: each command asks the database's
// own function, which writes the entry, its journal and its audit rows in one act, or refuses
// (drizzle/0049_money_in_out.sql). The role is the cash and bank keeper's (owner, accountant).

const WHOLE_COMPANY = "Money in and out of the company's accounts is recorded by someone who works in every branch.";

/** What the database's refusals mean, in words. */
function refusal(error: unknown, date: string | null): unknown {
  if (error instanceof UserError) return error;
  const code = pgCode(error);
  if (code === "SE381") return new UserError("Choose what the money is from the list: an account in use that is not kept by another form (not receivables, payables, stock, tax or an expense).");
  if (code === "SE382") return new UserError("Say who the money came from or went to.");
  if (code === "SE331") return new UserError("Choose one of the company's cash or bank accounts that is in use.");
  if (code === "SE342") return new UserError("This form was already sent with other figures, and recorded then. Reload the page to enter another.");
  // A row id or account id the form could not have sent.
  if (code === "22P02") return new UserError("Choose the accounts again: one of them is not in this company.");
  return cashBankRefusal(error, date);
}

function requireWholeCompany(ctx: TenantContext): void {
  requireManager(ctx);
  if (ctx.branchIds !== null) throw new UserError(WHOLE_COMPANY);
}

/** Records money in or money out. Sent twice from the same form, it is recorded once. Returns its id and number. */
export async function recordMoneyInOut(ctx: TenantContext, raw: RawMoneyInOut & { clientKey?: unknown }): Promise<{ id: string; number: string }> {
  requireWholeCompany(ctx);
  const read = readMoneyInOut(raw, todayIso(new Date()));
  if (!read.ok) throw new UserError(read.reason);
  const e = read.entry;
  const key = isUuid(raw.clientKey) ? raw.clientKey : randomUUID();
  try {
    return await withTenant(ctx.userId, ctx.tenantId, async (tx) => {
      const [row] = await tx.execute<{ number: string }>(sql`
        select app.record_money_in_out(${key}::uuid, ${e.direction}, ${e.date}::date, ${e.moneyAccountId}::uuid, ${e.otherAccountId}::uuid, ${e.amount.toFixed(2)}::numeric,
          ${e.party}, ${e.reference}, ${e.memo}) as number`);
      return { id: key, number: row.number };
    });
  } catch (error) {
    throw refusal(error, e.date) ?? error;
  }
}

/** Takes back an entry made by mistake with a reversal on the day given, with the reason. */
export async function cancelMoneyInOut(ctx: TenantContext, id: unknown, raw: RawCancel): Promise<void> {
  requireWholeCompany(ctx);
  if (!isUuid(id)) throw new UserError("That is not in this company.");
  const read = readCancel(raw, todayIso(new Date()));
  if (!read.ok) throw new UserError(read.reason);
  try {
    await withTenant(ctx.userId, ctx.tenantId, (tx) => tx.execute(sql`select app.cancel_money_in_out(${id}::uuid, ${read.date}::date, ${read.reason})`));
  } catch (error) {
    throw refusal(error, read.date) ?? error;
  }
}

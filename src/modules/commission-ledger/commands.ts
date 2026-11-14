import "server-only";
import Decimal from "decimal.js";
import { sql } from "drizzle-orm";
import { isUuid, withTenant } from "@/db";
import { UserError, pgCode } from "@/lib/errors";
import { todayIso } from "@/lib/format";
import { cleanText } from "@/lib/text";
import { isIsoDate } from "@/modules/currencies/rules";
import { periodRefusal } from "@/modules/numbering/rules";
import { can, type TenantContext } from "@/modules/tenant/rules";

// Approving and paying commission. Both are acts of the database's own functions
// (app.approve_commission, app.pay_commission): the app's role cannot write a commission row.

/** What the database refused, in words for the person, or null for anything unexpected. */
function refusal(error: unknown, date: string): UserError | null {
  const code = pgCode(error);
  const closed = periodRefusal(code, date);
  if (closed) return new UserError(closed);
  if (code === "SE015") return new UserError("That date is before the day the books were opened.");
  if (code === "SE064") return new UserError("The chart of accounts is missing an account that commission posts to. Set the company up first.");
  if (code === "SE310") return new UserError("Commission not found.");
  if (code === "SE311") return new UserError("There is no released unpaid commission to approve.");
  if (code === "SE313") return new UserError("That date has not come yet. Nothing is recorded before it happens.");
  if (code === "SE314") return new UserError("Choose a cash or bank account that is in use. An archived account cannot be used: restore it first under Chart of accounts.");
  if (code === "SE317") return new UserError("Commission is paid by someone who works across the whole company, not in some branches only.");
  if (code === "42501") return new UserError("Your role does not permit this action.");
  if (code === "SE312" || code === "SE315" || code === "SE316" || code === "SE074") return new UserError("That could not be done as it stands. Reload the page and try again.");
  return null;
}

/**
 * Approves, for payment, what has been released and not yet paid of the commissions named.
 * Each must have something released and unpaid. The approval is for the figure as it stands:
 * a later receipt, bounce or return clears it. Returns how many were approved.
 */
export async function approveCommission(ctx: TenantContext, ids: unknown): Promise<{ approved: number }> {
  if (!can(ctx.role, "commission.approve")) throw new UserError("Your role does not permit this action.");
  const list = Array.isArray(ids) ? ids : [];
  if (list.length === 0) throw new UserError("Choose the commission to approve.");
  if (list.length > 1000) throw new UserError("Approve at most 1,000 at a time.");
  if (!list.every(isUuid)) throw new UserError("Commission not found.");
  return withTenant(ctx.userId, ctx.tenantId, async (tx) => {
    try {
      const [row] = await tx.execute<{ approved: number }>(sql`select app.approve_commission(array(select x::uuid from jsonb_array_elements_text(${JSON.stringify(list)}::jsonb) as x)) as approved`);
      return { approved: row.approved };
    } catch (error) {
      throw refusal(error, todayIso(new Date())) ?? error;
    }
  });
}

/**
 * Pays one person everything of theirs that is approved, on a day, from a cash or bank
 * account. What they owe back (commission paid on a sale that was undone afterwards) comes off
 * first, as far as this payment goes; the rest is carried to the next.
 */
export async function payCommission(
  ctx: TenantContext,
  userId: unknown,
  raw: { date?: unknown; accountId?: unknown; note?: unknown },
): Promise<{ id: string; number: string; gross: Decimal; recovered: Decimal; amount: Decimal }> {
  if (!can(ctx.role, "commission.pay")) throw new UserError("Your role does not permit this action.");
  if (!isUuid(userId)) throw new UserError("Choose who is paid.");
  if (!isIsoDate(raw.date)) throw new UserError("Enter the date of the payment.");
  const date = raw.date;
  if (date > todayIso(new Date())) throw new UserError("That date has not come yet. Nothing is recorded before it happens.");
  if (!isUuid(raw.accountId)) throw new UserError("Choose the cash or bank account the money leaves.");
  const note = cleanText(raw.note);
  if (note.length > 300) throw new UserError("Note: use at most 300 characters.");
  return withTenant(ctx.userId, ctx.tenantId, async (tx) => {
    try {
      const [row] = await tx.execute<{ id: string; number: string; gross: string; recovered: string; amount: string }>(
        sql`select id, number, gross::text, recovered::text, amount::text from app.pay_commission(${userId}::uuid, ${date}::date, ${raw.accountId as string}::uuid, ${note === "" ? null : note})`,
      );
      return { id: row.id, number: row.number, gross: new Decimal(row.gross), recovered: new Decimal(row.recovered), amount: new Decimal(row.amount) };
    } catch (error) {
      if (pgCode(error) === "SE311") throw new UserError("There is no approved commission to pay this person. Approve it first.");
      throw refusal(error, date) ?? error;
    }
  });
}

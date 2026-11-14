import "server-only";
import { sql } from "drizzle-orm";
import { audit, isUuid, withTenant } from "@/db";
import { UserError } from "@/lib/errors";
import { can, type TenantContext } from "@/modules/tenant/rules";
import { readFollowUp, readPromise } from "./rules";
import { customerFollowUps, paymentPromises } from "./schema";

// Recovery commands (Step 33). Each writes one log row and its audit row in one transaction.
// The database checks again who may write, as whom and when (drizzle/0023_recovery.sql).

function requireRecoveryWriter(ctx: TenantContext): void {
  if (!can(ctx.role, "recovery.manage")) throw new UserError("Your role cannot record follow-ups or promises.");
}

/** Records what was said to a customer about what they owe, and when to follow up next. */
export async function addFollowUp(ctx: TenantContext, customerId: unknown, raw: { note?: unknown; nextOn?: unknown }, today: string): Promise<{ id: string }> {
  requireRecoveryWriter(ctx);
  if (!isUuid(customerId)) throw new UserError("That customer was not found.");
  const read = readFollowUp(raw, today);
  if (!read.ok) throw new UserError(read.reason);
  return withTenant(ctx.userId, ctx.tenantId, async (tx) => {
    const [row] = await tx.insert(customerFollowUps).values({ tenantId: ctx.tenantId, customerId, note: read.draft.note, nextOn: read.draft.nextOn, createdBy: ctx.userId }).returning({ id: customerFollowUps.id });
    await audit(tx, ctx, { action: "customer.follow_up", entity: "customer", entityId: customerId, after: { followUpId: row.id, nextOn: read.draft.nextOn } });
    return { id: row.id };
  });
}

/** Records a customer's promise to pay an amount by a day. It is made today, by the database's clock. */
export async function addPromise(ctx: TenantContext, customerId: unknown, raw: { amount?: unknown; promisedOn?: unknown; note?: unknown }, today: string): Promise<{ id: string }> {
  requireRecoveryWriter(ctx);
  if (!isUuid(customerId)) throw new UserError("That customer was not found.");
  const read = readPromise(raw, today);
  if (!read.ok) throw new UserError(read.reason);
  return withTenant(ctx.userId, ctx.tenantId, async (tx) => {
    const [row] = await tx
      .insert(paymentPromises)
      .values({ tenantId: ctx.tenantId, customerId, amount: read.draft.amount.toFixed(2), madeOn: sql`(statement_timestamp() at time zone 'Asia/Karachi')::date`, promisedOn: read.draft.promisedOn, note: read.draft.note, createdBy: ctx.userId })
      .returning({ id: paymentPromises.id });
    await audit(tx, ctx, { action: "customer.promise", entity: "customer", entityId: customerId, after: { promiseId: row.id, amount: read.draft.amount.toFixed(2), promisedOn: read.draft.promisedOn } });
    return { id: row.id };
  });
}

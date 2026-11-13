import "server-only";
import { eq, type SQL, and } from "drizzle-orm";
import { isUuid, withTenant, type Tx } from "@/db";
import { UserError } from "@/lib/errors";
import { can, type TenantContext } from "@/modules/tenant/rules";
import { chartOrder, type Account, type AccountNode, type AccountType } from "./rules";
import { accounts } from "./schema";

export function requireAccountAccess(ctx: TenantContext): void {
  if (!can(ctx.role, "account.read")) throw new UserError("Only an owner, an accountant or an auditor can see the chart of accounts.");
}

/** Accounts of the company, inside a transaction the caller already holds. */
export async function selectAccounts(tx: Tx, tenantId: string, where?: SQL): Promise<Account[]> {
  const rows = await tx
    .select({
      id: accounts.id,
      parentId: accounts.parentId,
      code: accounts.code,
      name: accounts.name,
      type: accounts.type,
      isGroup: accounts.isGroup,
      isControl: accounts.isControl,
      controlType: accounts.controlType,
      archivedAt: accounts.archivedAt,
      updatedAt: accounts.updatedAt,
    })
    .from(accounts)
    .where(and(eq(accounts.tenantId, tenantId), where));
  return rows.map((row) => ({ ...row, type: row.type as AccountType }));
}

/** The whole chart in reading order, archived accounts included. */
export async function listAccounts(ctx: TenantContext): Promise<AccountNode[]> {
  requireAccountAccess(ctx);
  return chartOrder(await withTenant(ctx.userId, ctx.tenantId, (tx) => selectAccounts(tx, ctx.tenantId)));
}

/** One account, or null when it is not this company's. */
export async function getAccount(ctx: TenantContext, id: string): Promise<Account | null> {
  requireAccountAccess(ctx);
  if (!isUuid(id)) return null;
  const [found] = await withTenant(ctx.userId, ctx.tenantId, (tx) => selectAccounts(tx, ctx.tenantId, eq(accounts.id, id)));
  return found ?? null;
}

/** Whether the company has a chart of accounts yet. Asked by the setup wizard, for the owner. */
export async function hasAccounts(ctx: TenantContext): Promise<boolean> {
  requireAccountAccess(ctx);
  const rows = await withTenant(ctx.userId, ctx.tenantId, (tx) => tx.select({ id: accounts.id }).from(accounts).where(eq(accounts.tenantId, ctx.tenantId)).limit(1));
  return rows.length > 0;
}

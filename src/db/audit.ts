import "server-only";
import { auditLog } from "@/modules/tenant/schema";
import type { MemberRole } from "@/modules/tenant/rules";
import type { Tx } from "./with-tenant";

export type Actor = { userId: string; tenantId: string; role: MemberRole };

export type AuditEntry = {
  /** `<entity>.<verb>`, for example `branch.create`. */
  action: string;
  entity: string;
  entityId?: string | null;
  /** The row before and after the command, or null. Never passwords, tokens or keys. */
  before?: unknown;
  after?: unknown;
};

/**
 * Every command calls this inside its own transaction, so the change and its audit row commit or
 * roll back together. The database refuses a row whose actor, role or tenant is not the caller's.
 */
export async function audit(tx: Tx, actor: Actor, entry: AuditEntry): Promise<void> {
  await tx.insert(auditLog).values({
    tenantId: actor.tenantId,
    actorUserId: actor.userId,
    actorRole: actor.role,
    action: entry.action,
    entity: entry.entity,
    entityId: entry.entityId ?? null,
    before: entry.before ?? null,
    after: entry.after ?? null,
  });
}

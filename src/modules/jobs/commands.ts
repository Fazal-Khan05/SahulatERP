import "server-only";
import { randomUUID } from "node:crypto";
import { audit, withTenant, type Tx } from "@/db";
import { UserError } from "@/lib/errors";
import type { TenantContext } from "@/modules/tenant/rules";
import { isJobKind, type JobKind } from "./rules";
import { jobs } from "./schema";

/**
 * Queues a job inside a transaction the caller already has, so the work and the thing that asked
 * for it are stored together or not at all. The worker picks the job up after the commit.
 */
export async function enqueueJobIn(
  tx: Tx,
  ctx: TenantContext,
  kind: JobKind,
  payload: Record<string, unknown> = {},
): Promise<string> {
  if (!isJobKind(kind)) throw new UserError("That kind of background work does not exist.");
  // The id is made here, not read back: most roles may queue work but not read the jobs table.
  const id = randomUUID();
  await tx.insert(jobs).values({ id, tenantId: ctx.tenantId, kind, payload, createdBy: ctx.userId });
  await audit(tx, ctx, { action: "job.enqueue", entity: "job", entityId: id, after: { kind } });
  return id;
}

/** Queues a job on its own. */
export async function enqueueJob(
  ctx: TenantContext,
  kind: JobKind,
  payload: Record<string, unknown> = {},
): Promise<string> {
  return withTenant(ctx.userId, ctx.tenantId, (tx) => enqueueJobIn(tx, ctx, kind, payload));
}

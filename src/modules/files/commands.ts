import "server-only";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { audit, withTenant } from "@/db";
import { UserError } from "@/lib/errors";
import type { ObjectStore } from "@/lib/storage";
import { can, firstIssue, type TenantContext } from "@/modules/tenant/rules";
import { checkFile, fileNameSchema, storageKey } from "./rules";
import { files } from "./schema";

/**
 * Stores a file. The object store is an outside system, so the intent is recorded first (a
 * "pending" row), the bytes are sent, and the outcome is recorded after (the row becomes
 * "stored", with its audit row). If the send fails the row stays pending and nothing claims the
 * file exists.
 */
export async function uploadFile(
  ctx: TenantContext,
  store: ObjectStore,
  input: { name: unknown; bytes: Uint8Array },
): Promise<{ id: string }> {
  if (!can(ctx.role, "file.upload")) throw new UserError("Only an owner can add files.");
  const name = fileNameSchema.safeParse(input.name);
  if (!name.success) throw new UserError(firstIssue(name.error));
  const checked = checkFile(input.bytes);
  if (!checked.ok) throw new UserError(checked.reason);

  const id = randomUUID();
  const key = storageKey(ctx.tenantId, id);
  const row = {
    id,
    tenantId: ctx.tenantId,
    storageKey: key,
    name: name.data,
    contentType: checked.contentType,
    sizeBytes: input.bytes.length,
    createdBy: ctx.userId,
  };

  await withTenant(ctx.userId, ctx.tenantId, (tx) => tx.insert(files).values(row));
  await store.put(key, input.bytes, checked.contentType);
  await withTenant(ctx.userId, ctx.tenantId, async (tx) => {
    const marked = await tx
      .update(files)
      .set({ status: "stored", storedAt: sql`now()` })
      .where(and(eq(files.tenantId, ctx.tenantId), eq(files.id, id)))
      .returning({ id: files.id });
    // Nothing marked means this person stopped being an owner between the two steps.
    if (marked.length === 0) throw new UserError("The file could not be added. Try again.");
    await audit(tx, ctx, {
      action: "file.upload",
      entity: "file",
      entityId: id,
      after: { name: row.name, contentType: row.contentType, sizeBytes: row.sizeBytes },
    });
  });
  return { id };
}

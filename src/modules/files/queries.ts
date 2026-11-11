import "server-only";
import { and, desc, eq } from "drizzle-orm";
import { isUuid, withTenant } from "@/db";
import { UserError } from "@/lib/errors";
import { memberships } from "@/modules/tenant/schema";
import { can, type TenantContext } from "@/modules/tenant/rules";
import { files } from "./schema";

const NO_ACCESS = "Only an owner or an auditor can see the files.";

/** The company's stored files, newest first. Uploads that never finished are left out. */
export async function listFiles(ctx: TenantContext) {
  if (!can(ctx.role, "file.read")) throw new UserError(NO_ACCESS);
  return withTenant(ctx.userId, ctx.tenantId, (tx) =>
    tx
      .select({
        id: files.id,
        name: files.name,
        contentType: files.contentType,
        sizeBytes: files.sizeBytes,
        storedAt: files.storedAt,
        addedBy: memberships.email,
      })
      .from(files)
      .leftJoin(memberships, and(eq(memberships.tenantId, files.tenantId), eq(memberships.userId, files.createdBy)))
      .where(and(eq(files.tenantId, ctx.tenantId), eq(files.status, "stored")))
      .orderBy(desc(files.storedAt)),
  );
}

/** One stored file of this company, or null. An id from another company is simply not found. */
export async function getFile(ctx: TenantContext, id: string) {
  if (!can(ctx.role, "file.read")) throw new UserError(NO_ACCESS);
  if (!isUuid(id)) return null;
  const [row] = await withTenant(ctx.userId, ctx.tenantId, (tx) =>
    tx
      .select({ id: files.id, name: files.name, storageKey: files.storageKey })
      .from(files)
      .where(and(eq(files.tenantId, ctx.tenantId), eq(files.id, id), eq(files.status, "stored"))),
  );
  return row ?? null;
}

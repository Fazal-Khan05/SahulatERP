import "server-only";
import { and, eq } from "drizzle-orm";
import { audit, isUuid, withTenant } from "@/db";
import { UserError, pgCode } from "@/lib/errors";
import { cleanText } from "@/lib/text";
import { branches } from "@/modules/tenant/schema";
import { can, type TenantContext } from "@/modules/tenant/rules";
import { warehouses } from "./schema";

/** Adds a warehouse to one of the company's branches. */
export async function createWarehouse(ctx: TenantContext, raw: { name?: unknown; branchId?: unknown }): Promise<{ id: string }> {
  if (!can(ctx.role, "warehouse.create")) throw new UserError("Only an owner can add a warehouse.");
  const name = cleanText(raw.name);
  if (name === "" || name.length > 80) throw new UserError("Enter the warehouse name, in up to 80 characters.");
  const branchId = raw.branchId;
  if (!isUuid(branchId)) throw new UserError("Choose the branch the warehouse belongs to.");
  try {
    return await withTenant(ctx.userId, ctx.tenantId, async (tx) => {
      const [branch] = await tx.select({ name: branches.name }).from(branches).where(and(eq(branches.tenantId, ctx.tenantId), eq(branches.id, branchId)));
      if (!branch) throw new UserError("Choose the branch the warehouse belongs to.");
      const [row] = await tx.insert(warehouses).values({ tenantId: ctx.tenantId, branchId, name, createdBy: ctx.userId }).returning({ id: warehouses.id });
      await audit(tx, ctx, { action: "warehouse.create", entity: "warehouse", entityId: row.id, after: { name, branch: branch.name } });
      return row;
    });
  } catch (error) {
    if (pgCode(error) === "23505") throw new UserError("A warehouse with this name already exists.");
    throw error;
  }
}

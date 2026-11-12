import "server-only";
import { and, asc, eq, sql } from "drizzle-orm";
import { withTenant } from "@/db";
import { branches } from "@/modules/tenant/schema";
import type { TenantContext } from "@/modules/tenant/rules";
import { warehouses } from "./schema";

/** The warehouses of the branches this member works in, by name. */
export async function listWarehouses(ctx: TenantContext): Promise<{ id: string; name: string; branchId: string; branch: string }[]> {
  return withTenant(ctx.userId, ctx.tenantId, (tx) =>
    tx
      .select({ id: warehouses.id, name: warehouses.name, branchId: warehouses.branchId, branch: branches.name })
      .from(warehouses)
      .innerJoin(branches, and(eq(branches.tenantId, warehouses.tenantId), eq(branches.id, warehouses.branchId)))
      .where(eq(warehouses.tenantId, ctx.tenantId))
      .orderBy(asc(sql`lower(${warehouses.name})`)),
  );
}

import postgres from "postgres";

// Test support only. Connects as postgres through MIGRATION_DATABASE_URL, which bypasses
// row-level security, to seed and remove synthetic rows. Never import this from src/ application
// code (eslint.config.mjs enforces it); the app reaches the database only through withTenant().

export type AdminSql = ReturnType<typeof postgres>;

export function hasAdminDb(): boolean {
  return Boolean(process.env.MIGRATION_DATABASE_URL);
}

export function adminSql(): AdminSql {
  const url = process.env.MIGRATION_DATABASE_URL;
  if (!url) throw new Error("MIGRATION_DATABASE_URL is not set; see .env.example");
  return postgres(url, { max: 1, onnotice: () => {} });
}

/** Removes the given tenants and everything in them. Only ever called with ids a test created. */
export async function deleteTenants(sql: AdminSql, tenantIds: string[]): Promise<void> {
  if (tenantIds.length === 0) return;
  await sql.begin(async (tx) => {
    await tx`delete from public.audit_log where tenant_id = any(${tenantIds})`;
    await tx`delete from public.exchange_rates where tenant_id = any(${tenantIds})`;
    await tx`delete from public.currencies where tenant_id = any(${tenantIds})`;
    await tx`delete from public.jobs where tenant_id = any(${tenantIds})`;
    await tx`delete from public.files where tenant_id = any(${tenantIds})`;
    await tx`delete from public.modules_enabled where tenant_id = any(${tenantIds})`;
    await tx`delete from public.settings where tenant_id = any(${tenantIds})`;
    await tx`delete from public.invitations where tenant_id = any(${tenantIds})`;
    await tx`delete from public.branches where tenant_id = any(${tenantIds})`;
    await tx`delete from public.memberships where tenant_id = any(${tenantIds})`;
    await tx`delete from public.tenants where id = any(${tenantIds})`;
  });
}

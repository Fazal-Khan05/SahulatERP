import { loadEnvConfig } from '@next/env';
import postgres from 'postgres';
import { blankWorkspace } from '../src/modules/erp/seed';

loadEnvConfig(process.cwd());

/**
 * Creates (or resets) a disposable QA company for browser tests of onboarding and module toggles,
 * owned by the bootstrap owner. It never touches the demo or partner tenants.
 *   npm run qa:tenant
 */
export const QA_TENANT = '33333333-3333-4333-8333-333333333333';

export async function resetQaTenant() {
  const url = process.env.MIGRATION_DATABASE_URL || process.env.DATABASE_URL;
  const ownerId = process.env.BOOTSTRAP_OWNER_ID;
  if (!url || !ownerId) throw new Error('DATABASE_URL and BOOTSTRAP_OWNER_ID are required.');
  const workspace = { ...blankWorkspace(false), tenantId: QA_TENANT, company: { ...blankWorkspace(false).company, name: 'QA Company', logo: 'Q' }, settings: { ...blankWorkspace(false).settings, numbering: 'QA' } };
  const sql = postgres(url, { ssl: 'require', prepare: false, max: 1, connect_timeout: 20 });
  try {
    await sql.begin(async tx => {
      await tx`select set_config('app.demo_reset', 'on', true)`;
      await tx`delete from public.tenants where id = ${QA_TENANT}`;
      await tx`insert into public.tenants (id, name, is_demo) values (${QA_TENANT}, 'QA Company', true)`;
      await tx`insert into public.memberships (tenant_id, user_id, role, branch_ids) values (${QA_TENANT}, ${ownerId}, 'Owner', '{}')`;
      await tx`insert into public.workspace_snapshots (tenant_id, revision, schema_version, data) values (${QA_TENANT}, 0, 1, ${tx.json(workspace)})`;
      await tx`select private.sync_projection(${QA_TENANT}, data, true) from public.workspace_snapshots where tenant_id = ${QA_TENANT}`;
    });
    console.log(JSON.stringify({ created: true, tenantId: QA_TENANT }));
  } finally { await sql.end({ timeout: 3 }); }
}

if (process.argv[1]?.endsWith('create-qa-tenant.ts')) resetQaTenant().catch(error => { console.error(JSON.stringify({ created: false, message: error.message })); process.exitCode = 1; });

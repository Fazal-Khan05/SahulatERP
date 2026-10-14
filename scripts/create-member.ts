import { loadEnvConfig } from '@next/env';
import postgres from 'postgres';
import { createClient } from '@supabase/supabase-js';
import { blankWorkspace } from '../src/modules/erp/seed';
import { DEMO_TENANT } from '../src/modules/erp/types';

loadEnvConfig(process.cwd());

/**
 * Creates (or updates) a sign-in account, gives it a brand-new empty company (so the onboarding
 * wizard runs) and, optionally, Owner access to the demo company.
 *   MEMBER_EMAIL=... MEMBER_PASSWORD=... MEMBER_NAME="..." [MEMBER_DEMO=1] npm run member:create
 */
async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY, db = process.env.MIGRATION_DATABASE_URL || process.env.DATABASE_URL;
  const email = process.env.MEMBER_EMAIL, password = process.env.MEMBER_PASSWORD, name = process.env.MEMBER_NAME || 'Owner';
  if (!url || !key || !db || !email || !password) throw new Error('MEMBER_EMAIL, MEMBER_PASSWORD and Supabase configuration are required.');
  const admin = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: list, error: listError } = await admin.auth.admin.listUsers({ perPage: 1000 });
  if (listError) throw listError;
  const existing = list.users.find(u => u.email?.toLowerCase() === email.toLowerCase());
  const result = existing
    ? await admin.auth.admin.updateUserById(existing.id, { password, email_confirm: true, user_metadata: { display_name: name } })
    : await admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { display_name: name } });
  if (result.error) throw result.error;
  const userId = result.data.user.id;
  const tenantId = crypto.randomUUID();
  const workspace = { ...blankWorkspace(false), tenantId, company: { ...blankWorkspace(false).company, name: 'My Company', logo: 'M' }, settings: { ...blankWorkspace(false).settings, numbering: 'MC' } };
  const sql = postgres(db, { ssl: 'require', prepare: false, max: 1, connect_timeout: 20 });
  try {
    await sql.begin(async tx => {
      const [has] = await tx`select exists(select 1 from public.memberships m join public.tenants t on t.id = m.tenant_id where m.user_id = ${userId} and not t.is_demo) as present`;
      if (!has.present) {
        await tx`insert into public.tenants (id, name, is_demo) values (${tenantId}, 'My Company', false)`;
        await tx`insert into public.memberships (tenant_id, user_id, role, branch_ids) values (${tenantId}, ${userId}, 'Owner', '{}')`;
        await tx`insert into public.workspace_snapshots (tenant_id, revision, schema_version, data) values (${tenantId}, 0, 1, ${tx.json(workspace)})`;
        await tx`select private.sync_projection(${tenantId}, data, true) from public.workspace_snapshots where tenant_id = ${tenantId}`;
      }
      if (process.env.MEMBER_DEMO === '1') await tx`insert into public.memberships (tenant_id, user_id, role, branch_ids) values (${DEMO_TENANT}, ${userId}, 'Owner', '{}') on conflict (tenant_id, user_id) do update set role = 'Owner', active = true`;
    });
    console.log(JSON.stringify({ ok: true, created: !existing, email, companyCreated: true, demoAccess: process.env.MEMBER_DEMO === '1' }));
  } finally { await sql.end({ timeout: 3 }); }
}

main().catch(error => { console.error(JSON.stringify({ ok: false, message: error instanceof Error ? error.message : String(error) })); process.exitCode = 1; });

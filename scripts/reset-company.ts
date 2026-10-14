import { loadEnvConfig } from '@next/env';
import postgres from 'postgres';
import { createClient } from '@supabase/supabase-js';
import { blankWorkspace } from '../src/modules/erp/seed';

loadEnvConfig(process.cwd());

/**
 * Resets a member's own (non-demo) company back to a brand-new empty workspace so the
 * onboarding wizard runs again. The sign-in account and the company id are kept; every
 * record, setting and module choice in that company is replaced.
 *   MEMBER_EMAIL=... npm run company:reset
 */
async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY, db = process.env.MIGRATION_DATABASE_URL || process.env.DATABASE_URL;
  const email = process.env.MEMBER_EMAIL;
  if (!url || !key || !db || !email) throw new Error('MEMBER_EMAIL and Supabase configuration are required.');
  const admin = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: list, error: listError } = await admin.auth.admin.listUsers({ perPage: 1000 });
  if (listError) throw listError;
  const user = list.users.find(u => u.email?.toLowerCase() === email.toLowerCase());
  if (!user) throw new Error(`No account for ${email}.`);
  const sql = postgres(db, { ssl: 'require', prepare: false, max: 1, connect_timeout: 20 });
  try {
    const tenants = await sql`select t.id, t.name from public.memberships m join public.tenants t on t.id = m.tenant_id where m.user_id = ${user.id} and m.role = 'Owner' and not t.is_demo order by m.created_at`;
    if (tenants.length !== 1) throw new Error(`Expected exactly one own company for ${email}, found ${tenants.length}.`);
    const tenantId = tenants[0].id as string;
    const base = blankWorkspace(false);
    const workspace = { ...base, tenantId, company: { ...base.company, name: 'My Company', logo: 'M' }, settings: { ...base.settings, numbering: 'MC' } };
    await sql.begin(async tx => {
      await tx`update public.tenants set name = 'My Company' where id = ${tenantId}`;
      await tx`update public.workspace_snapshots set data = ${tx.json(workspace)}, revision = 0, schema_version = 1 where tenant_id = ${tenantId}`;
      await tx`select private.sync_projection(${tenantId}, data, true) from public.workspace_snapshots where tenant_id = ${tenantId}`;
    });
    // Branding files from the previous setup are no longer referenced; remove them so the bucket stays tidy.
    const { data: files } = await admin.storage.from('branding').list(tenantId);
    if (files?.length) await admin.storage.from('branding').remove(files.map(f => `${tenantId}/${f.name}`));
    console.log(JSON.stringify({ ok: true, email, tenantId, previousName: tenants[0].name, brandingFilesRemoved: files?.length ?? 0 }));
  } finally { await sql.end({ timeout: 3 }); }
}

main().catch(error => { console.error(JSON.stringify({ ok: false, message: error instanceof Error ? error.message : String(error) })); process.exitCode = 1; });

import { loadEnvConfig } from '@next/env';
import postgres from 'postgres';
import { createClient } from '@supabase/supabase-js';
import { buildDemoWorkspace } from '../src/modules/erp/demo';
import { blankWorkspace } from '../src/modules/erp/seed';
import type { Workspace } from '../src/modules/erp/types';

loadEnvConfig(process.cwd());

// The snapshot is the source; private.sync_projection (migration 202610120001) fills the relational tables
// exactly as every runtime commit does.
async function insertProjection(tx: postgres.TransactionSql, workspace: Workspace) {
  await tx`insert into public.workspace_snapshots (tenant_id,revision,schema_version,data) values (${workspace.tenantId},${workspace.revision},${workspace.schemaVersion},${tx.json(workspace)})`;
  await tx`select private.sync_projection(${workspace.tenantId}, data, true) from public.workspace_snapshots where tenant_id=${workspace.tenantId}`;
}

async function main() {
  const url = process.env.MIGRATION_DATABASE_URL || process.env.DATABASE_URL;
  let ownerId = process.env.BOOTSTRAP_OWNER_ID;
  if (!ownerId && process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY && process.env.BOOTSTRAP_OWNER_EMAIL) {
    const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
    const { data, error } = await admin.auth.admin.listUsers({ perPage: 1000 });
    if (error) throw error;
    ownerId = data.users.find(user => user.email?.toLowerCase() === process.env.BOOTSTRAP_OWNER_EMAIL?.toLowerCase())?.id;
  }
  if (!url || !ownerId) throw new Error('Database URL and a bootstrapped owner account are required.');
  const demo = buildDemoWorkspace();
  const partner = blankWorkspace(false);
  const sql = postgres(url, { ssl: 'require', prepare: false, max: 1, connect_timeout: 20 });
  try {
    await sql.begin(async tx => {
      await tx`select set_config('app.demo_reset', 'on', true)`;
      await tx`delete from public.tenants where id=${demo.tenantId}`;
      await tx`insert into public.tenants (id,name,is_demo) values (${demo.tenantId},${demo.company.name},true)`;
      await tx`insert into public.memberships (tenant_id,user_id,role,branch_ids) values (${demo.tenantId},${ownerId},'Owner','{}')`;
      await insertProjection(tx, demo);

      await tx`insert into public.tenants (id,name,is_demo) values (${partner.tenantId},${partner.company.name},false) on conflict (id) do nothing`;
      await tx`insert into public.memberships (tenant_id,user_id,role,branch_ids) values (${partner.tenantId},${ownerId},'Owner','{}') on conflict (tenant_id,user_id) do update set role='Owner', active=true`;
      const [partnerExists] = await tx`select exists(select 1 from public.workspace_snapshots where tenant_id=${partner.tenantId}) as present`;
      if (!partnerExists.present) await insertProjection(tx, partner);
    });
    console.log(JSON.stringify({ seeded: true, demoRevision: demo.revision, documents: demo.documents.length, journals: demo.journals.length, partnerPreserved: true }));
  } finally { await sql.end({ timeout: 3 }); }
}

main().catch(error => {
  console.error(JSON.stringify({ seeded: false, code: error.code || 'SEED_FAILED', message: error.message }));
  process.exitCode = 1;
});

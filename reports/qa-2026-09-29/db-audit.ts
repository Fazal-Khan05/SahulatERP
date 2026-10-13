import { loadEnvConfig } from '@next/env';
import postgres from 'postgres';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

loadEnvConfig(process.cwd());
const url = process.env.MIGRATION_DATABASE_URL || process.env.DATABASE_URL;
if (!url) throw new Error('Database connection is not configured.');
const sql = postgres(url, { ssl: 'require', prepare: false, max: 1, connect_timeout: 15 });

async function main() {
try {
  const tenants = await sql`
    select t.name, t.is_demo, s.revision,
      jsonb_array_length(s.data->'documents') as snapshot_documents,
      (select count(*)::int from public.documents d where d.tenant_id=t.id) as table_documents,
      jsonb_array_length(s.data->'journals') as snapshot_journals,
      (select count(*)::int from public.journals j where j.tenant_id=t.id) as table_journals,
      jsonb_array_length(s.data->'stockMoves') as snapshot_stock_moves,
      (select count(*)::int from public.stock_movements m where m.tenant_id=t.id) as table_stock_moves,
      jsonb_array_length(s.data->'audit') as snapshot_audit,
      (select count(*)::int from public.audit_events a where a.tenant_id=t.id) as table_audit
    from public.tenants t join public.workspace_snapshots s on s.tenant_id=t.id
    order by t.is_demo desc`;
  const policies = await sql`select tablename, policyname, cmd from pg_policies where schemaname='public' order by tablename, policyname`;
  const rls = await sql`select relname, relrowsecurity, relforcerowsecurity from pg_class where relnamespace='public'::regnamespace and relkind='r' order by relname`;
  const out = { tenants, policyCount: policies.length, policyCommands: [...new Set(policies.map(row => row.cmd))], tablesWithoutForcedRls: rls.filter(row => !row.relrowsecurity || !row.relforcerowsecurity).map(row => row.relname) };
  writeFileSync(join(process.cwd(), 'reports', 'qa-2026-09-29', 'evidence', 'database-observations.json'), JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2));
} finally {
  await sql.end({ timeout: 3 });
}
}
main().catch(error => {
  console.error(JSON.stringify({ code: error?.code || 'QA_QUERY_FAILED', message: String(error?.message || 'Query failed').replace(/postgres(?:ql)?:\/\/[^\s]+/g, '[REDACTED]') }));
  process.exitCode = 1;
});

import { loadEnvConfig } from '@next/env';
import postgres from 'postgres';
import { buildDemoWorkspace } from '../src/modules/erp/demo';
import { DEMO_TENANT } from '../src/modules/erp/types';

loadEnvConfig(process.cwd());

/**
 * Restores the demo company (Sahulat Trading Co.) to its full synthetic data set, the same as
 * Settings → Access → Reset demo, without needing a browser session. Touches only the demo tenant.
 *   npm run demo:reset
 */
async function main() {
  const url = process.env.MIGRATION_DATABASE_URL || process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required.');
  const sql = postgres(url, { ssl: 'require', prepare: false, max: 1, connect_timeout: 20 });
  try {
    const [tenant] = await sql`select id, is_demo from public.tenants where id = ${DEMO_TENANT}`;
    if (!tenant?.is_demo) throw new Error('The demo tenant is missing or is not flagged as a demo company.');
    const [snapshot] = await sql`select revision from public.workspace_snapshots where tenant_id = ${DEMO_TENANT}`;
    const revision = Number(snapshot?.revision ?? 0);
    // Revision keeps increasing so a client holding the pre-reset revision cannot overwrite the reset.
    const workspace = { ...buildDemoWorkspace(), revision: revision + 1 };
    const [result] = await sql`select public.commit_workspace(${DEMO_TENANT}::uuid, ${revision}, ${sql.json(workspace as never)}, true) as revision`;
    if (result.revision === null) throw new Error('Another change was saved first; run it again.');
    console.log(JSON.stringify({ ok: true, tenantId: DEMO_TENANT, revision: result.revision, documents: workspace.documents.length, products: workspace.items.length, parties: workspace.parties.length }));
  } finally { await sql.end({ timeout: 3 }); }
}

main().catch(error => { console.error(JSON.stringify({ ok: false, message: error instanceof Error ? error.message : String(error) })); process.exitCode = 1; });

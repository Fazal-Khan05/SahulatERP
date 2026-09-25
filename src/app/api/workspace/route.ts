import { ZodError } from 'zod';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { createServerSupabase } from '@/lib/supabase/server';
import { execute } from '@/modules/erp/engine';
import { decodeWorkspace } from '@/modules/erp/codec';
import type { Actor, Role, Workspace } from '@/modules/erp/types';

export const dynamic = 'force-dynamic';

async function context(request: Request) {
  const userClient = await createServerSupabase();
  const { data: { user } } = await userClient.auth.getUser();
  if (!user) throw new Error('AUTH_REQUIRED');
  const tenantId = request.headers.get('x-tenant-id') || new URL(request.url).searchParams.get('tenant');
  if (!tenantId) throw new Error('TENANT_REQUIRED');
  const { data: membership } = await userClient.from('memberships').select('tenant_id,role,branch_ids').eq('tenant_id', tenantId).eq('active', true).single();
  if (!membership) throw new Error('ACCESS_DENIED');
  const actor: Actor = { id: user.id, name: user.user_metadata.display_name || user.email || 'User', role: membership.role as Role, branchIds: membership.branch_ids || [] };
  return { tenantId, actor };
}

function errorResponse(error: unknown) {
  if (error instanceof ZodError) return Response.json({ success: false, message: 'Check the highlighted information.', validationErrors: error.flatten() }, { status: 400 });
  const message = error instanceof Error ? error.message : 'Unexpected request failure.';
  const status = message === 'AUTH_REQUIRED' ? 401 : ['ACCESS_DENIED','TENANT_REQUIRED'].includes(message) ? 403 : 400;
  return Response.json({ success: false, message }, { status });
}

export async function GET(request: Request) {
  try {
    const { tenantId, actor } = await context(request);
    const { data, error } = await createAdminSupabase().from('workspace_snapshots').select('data').eq('tenant_id', tenantId).single();
    if (error) throw error;
    return Response.json({ success: true, workspace: decodeWorkspace(data.data), actor });
  } catch (error) { return errorResponse(error); }
}

export async function POST(request: Request) {
  try {
    const { tenantId, actor } = await context(request);
    const admin = createAdminSupabase();
    const { data: snapshot, error: readError } = await admin.from('workspace_snapshots').select('data,revision').eq('tenant_id', tenantId).single();
    if (readError || !snapshot) throw readError || new Error('Workspace not found.');
    const result = execute(decodeWorkspace(snapshot.data), await request.json(), actor);
    const { data: updated, error: writeError } = await admin.from('workspace_snapshots').update({ data: result.workspace, revision: result.workspace.revision, updated_at: new Date().toISOString() }).eq('tenant_id', tenantId).eq('revision', snapshot.revision).select('revision').maybeSingle();
    if (writeError) throw writeError;
    if (!updated) return Response.json({ success: false, message: 'Another change was saved first. Refresh and try again.' }, { status: 409 });
    return Response.json({ success: true, recordId: result.recordId, message: result.message, warnings: [], workspace: result.workspace });
  } catch (error) { return errorResponse(error); }
}

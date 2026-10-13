import { ZodError } from 'zod';
import { commitWorkspace, readWorkspace, requireMember } from '@/lib/workspace-store';
import { scopeWorkspace } from '@/modules/erp/access';
import { execute } from '@/modules/erp/engine';

export const dynamic = 'force-dynamic';

function tenantOf(request: Request) {
  return request.headers.get('x-tenant-id') || new URL(request.url).searchParams.get('tenant');
}

function errorResponse(error: unknown) {
  if (error instanceof ZodError) return Response.json({ success: false, message: 'Check the highlighted information.', validationErrors: error.flatten() }, { status: 400 });
  const message = error instanceof Error ? error.message : 'Unexpected request failure.';
  if (message.startsWith('INTEGRITY:')) {
    console.error('Workspace commit rejected by database', message);
    return Response.json({ success: false, message: 'The database rejected this change because it would break a financial integrity rule. Nothing was saved.' }, { status: 500 });
  }
  const status = message === 'AUTH_REQUIRED' ? 401 : ['ACCESS_DENIED','TENANT_REQUIRED'].includes(message) ? 403 : 400;
  return Response.json({ success: false, message }, { status });
}

export async function GET(request: Request) {
  try {
    const tenantId = tenantOf(request);
    const { actor } = await requireMember(tenantId);
    const { workspace } = await readWorkspace(tenantId!);
    return Response.json({ success: true, workspace: scopeWorkspace(workspace, actor), actor });
  } catch (error) { return errorResponse(error); }
}

export async function POST(request: Request) {
  try {
    const tenantId = tenantOf(request);
    const { actor } = await requireMember(tenantId);
    const { workspace, revision } = await readWorkspace(tenantId!);
    const result = execute(workspace, await request.json(), actor);
    if (result.workspace === workspace) return Response.json({ success: true, recordId: result.recordId, message: result.message, warnings: [], workspace: scopeWorkspace(workspace, actor) });
    if (!await commitWorkspace(tenantId!, revision, result.workspace)) return Response.json({ success: false, message: 'Another change was saved first. Refresh and try again.' }, { status: 409 });
    return Response.json({ success: true, recordId: result.recordId, message: result.message, warnings: [], workspace: scopeWorkspace(result.workspace, actor) });
  } catch (error) { return errorResponse(error); }
}

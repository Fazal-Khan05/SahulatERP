import { ZodError } from 'zod';
import { verifyPassword } from '@/lib/password';
import { commitWorkspace, readWorkspace, requireMember } from '@/lib/workspace-store';
import { scopeWorkspace } from '@/modules/erp/access';
import { execute } from '@/modules/erp/engine';
import { isToggleModule, withRequirements } from '@/modules/erp/modules';

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
  const status = message === 'AUTH_REQUIRED' ? 401 : ['ACCESS_DENIED','TENANT_REQUIRED'].includes(message) ? 403 : message === 'PASSWORD_REQUIRED' ? 401 : 400;
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
    const { actor, user } = await requireMember(tenantId);
    const { workspace, revision } = await readWorkspace(tenantId!);
    const text = await request.text();
    if (!text) {
      console.error('Empty workspace command body', { method: request.method, length: request.headers.get('content-length'), type: request.headers.get('content-type') });
      return Response.json({ success: false, message: 'The request reached the server without its data. Please try again.' }, { status: 400 });
    }
    const body = JSON.parse(text) as { type?: string; payload?: Record<string, unknown>; confirmPassword?: string };
    const { confirmPassword, ...command } = body;

    // Hiding a module needs the member's own password; turning one on does not.
    if (command.type === 'set_modules') {
      const requested = Array.isArray(command.payload?.enabled) ? (command.payload!.enabled as unknown[]).filter((m): m is string => typeof m === 'string').filter(isToggleModule) : [];
      const removing = workspace.modules.some(m => !withRequirements(requested).includes(m));
      if (removing) {
        const check = await verifyPassword(user.id, user.email ?? '', confirmPassword ?? '');
        if (!check.ok) return Response.json({ success: false, message: check.message, passwordRequired: true }, { status: 401 });
      }
    }

    const result = execute(workspace, command, actor);
    if (result.workspace === workspace) return Response.json({ success: true, recordId: result.recordId, message: result.message, warnings: [], workspace: scopeWorkspace(workspace, actor) });
    if (!await commitWorkspace(tenantId!, revision, result.workspace)) return Response.json({ success: false, message: 'Another change was saved first. Refresh and try again.' }, { status: 409 });
    return Response.json({ success: true, recordId: result.recordId, message: result.message, warnings: [], workspace: scopeWorkspace(result.workspace, actor) });
  } catch (error) { return errorResponse(error); }
}

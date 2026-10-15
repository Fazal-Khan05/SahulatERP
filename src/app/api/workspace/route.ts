import { verifyPassword } from '@/lib/password';
import { commitWorkspace, readWorkspace, requireMember } from '@/lib/workspace-store';
import { scopeWorkspace } from '@/modules/erp/access';
import { execute } from '@/modules/erp/engine';
import { isToggleModule, withRequirements } from '@/modules/erp/modules';
import { failureResponse, isRefusal, refusalResponse } from '../errors';

export const dynamic = 'force-dynamic';

function tenantOf(request: Request) {
  return request.headers.get('x-tenant-id') || new URL(request.url).searchParams.get('tenant');
}

const badRequest = (message: string, status = 400) => Response.json({ success: false, message }, { status });

export async function GET(request: Request) {
  try {
    const tenantId = tenantOf(request);
    const { actor } = await requireMember(tenantId);
    const { workspace } = await readWorkspace(tenantId!);
    return Response.json({ success: true, workspace: scopeWorkspace(workspace, actor), actor });
  } catch (error) { return failureResponse(error, 'Workspace read'); }
}

export async function POST(request: Request) {
  try {
    // Commands are JSON only, so a plain form or text post from another site is never parsed as one.
    const mediaType = (request.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
    if (mediaType !== 'application/json') return badRequest('Send the command as JSON (Content-Type: application/json).', 415);
    // Read the whole command before the session and workspace lookups: once it is in hand, a browser that
    // closes mid-request no longer drops it, and the server completes the change on its own.
    const text = await request.text().catch(() => '');
    const tenantId = tenantOf(request);
    const { actor, user } = await requireMember(tenantId);
    if (!text) {
      console.error('Empty workspace command body', { method: request.method, length: request.headers.get('content-length'), type: request.headers.get('content-type') });
      return badRequest('The request reached the server without its data. Please try again.');
    }
    let body: unknown;
    try { body = JSON.parse(text); } catch { return badRequest('The request is not valid JSON.'); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return badRequest('The request must be a JSON object.');
    const { confirmPassword, ...command } = body as { type?: string; payload?: Record<string, unknown>; confirmPassword?: string };
    const { workspace, revision } = await readWorkspace(tenantId!);

    // Hiding a module needs the member's own password; turning one on does not.
    if (command.type === 'set_modules') {
      const requested = Array.isArray(command.payload?.enabled) ? (command.payload!.enabled as unknown[]).filter((m): m is string => typeof m === 'string').filter(isToggleModule) : [];
      const removing = workspace.modules.some(m => !withRequirements(requested).includes(m));
      if (removing) {
        const check = await verifyPassword(user.id, user.email ?? '', confirmPassword ?? '');
        if (!check.ok) return Response.json({ success: false, message: check.message, passwordRequired: true }, { status: 401 });
      }
    }

    let result: ReturnType<typeof execute>;
    try { result = execute(workspace, command, actor); }
    catch (error) { if (isRefusal(error)) return refusalResponse(error); throw error; }
    if (result.workspace === workspace) return Response.json({ success: true, recordId: result.recordId, message: result.message, warnings: [], workspace: scopeWorkspace(workspace, actor) });
    if (!await commitWorkspace(tenantId!, revision, result.workspace)) return Response.json({ success: false, message: 'Another change was saved first. Refresh and try again.' }, { status: 409 });
    return Response.json({ success: true, recordId: result.recordId, message: result.message, warnings: [], workspace: scopeWorkspace(result.workspace, actor) });
  } catch (error) { return failureResponse(error, 'Workspace command'); }
}

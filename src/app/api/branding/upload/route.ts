import { brandingKinds, storeBrandingFile, type BrandingKind } from '@/lib/branding-store';
import { commitWorkspace, readWorkspace, requireMember } from '@/lib/workspace-store';
import { scopeWorkspace } from '@/modules/erp/access';
import { canRun, execute } from '@/modules/erp/engine';
import { failureResponse, isRefusal, refusalResponse } from '../../workspace/errors';

export const dynamic = 'force-dynamic';

const chooseImage = () => Response.json({ success: false, message: 'Choose a logo or letterhead image.' }, { status: 400 });


/** Multipart upload of a logo or letterhead; stores the file, then saves its path on the workspace branding. */
export async function POST(request: Request) {
  try {
    const tenantId = request.headers.get('x-tenant-id');
    const { actor } = await requireMember(tenantId);
    if (actor.role === 'Auditor') return Response.json({ success: false, message: 'Auditors cannot change branding.' }, { status: 403 });
    const { workspace, revision } = await readWorkspace(tenantId!);
    // The engine's own save_branding rule (D-08), checked before the file is stored so a refused member cannot replace it.
    if (!canRun(actor.role, 'save_branding', workspace)) return Response.json({ success: false, message: 'Your role does not permit this action.' }, { status: 403 });
    let form: FormData;
    try { form = await request.formData(); } catch { return chooseImage(); }
    const kind = String(form.get('kind') ?? '');
    const file = form.get('file');
    if (!brandingKinds.includes(kind as BrandingKind) || !(file instanceof File)) return chooseImage();
    const stored = await storeBrandingFile(tenantId!, kind as BrandingKind, file);
    if ('error' in stored) return Response.json({ success: false, message: stored.error }, { status: 400 });

    const payload = { ...workspace.branding, [kind === 'logo' ? 'logoPath' : 'letterheadPath']: stored.path };
    let result: ReturnType<typeof execute>;
    try { result = execute(workspace, { type: 'save_branding', payload, idempotencyKey: `branding-${kind}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` }, actor); }
    catch (error) { if (isRefusal(error)) return refusalResponse(error); throw error; }
    if (!await commitWorkspace(tenantId!, revision, result.workspace)) return Response.json({ success: false, message: 'Another change was saved first. Refresh and try again.' }, { status: 409 });
    return Response.json({ success: true, message: `${kind === 'logo' ? 'Logo' : 'Letterhead'} uploaded.`, path: stored.path, workspace: scopeWorkspace(result.workspace, actor) });
  } catch (error) { return failureResponse(error, 'Branding upload'); }
}

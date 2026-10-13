import { brandingKinds, storeBrandingFile, type BrandingKind } from '@/lib/branding-store';
import { commitWorkspace, readWorkspace, requireMember } from '@/lib/workspace-store';
import { scopeWorkspace } from '@/modules/erp/access';
import { execute } from '@/modules/erp/engine';

export const dynamic = 'force-dynamic';

/** Multipart upload of a logo or letterhead; stores the file, then saves its path on the workspace branding. */
export async function POST(request: Request) {
  try {
    const tenantId = request.headers.get('x-tenant-id');
    const { actor } = await requireMember(tenantId);
    if (actor.role === 'Auditor') return Response.json({ success: false, message: 'Auditors cannot change branding.' }, { status: 403 });
    const form = await request.formData();
    const kind = String(form.get('kind') ?? '');
    const file = form.get('file');
    if (!brandingKinds.includes(kind as BrandingKind) || !(file instanceof File)) return Response.json({ success: false, message: 'Choose a logo or letterhead image.' }, { status: 400 });
    const stored = await storeBrandingFile(tenantId!, kind as BrandingKind, file);
    if ('error' in stored) return Response.json({ success: false, message: stored.error }, { status: 400 });

    const { workspace, revision } = await readWorkspace(tenantId!);
    const payload = { ...workspace.branding, [kind === 'logo' ? 'logoPath' : 'letterheadPath']: stored.path };
    const result = execute(workspace, { type: 'save_branding', payload, idempotencyKey: `branding-${kind}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` }, actor);
    if (!await commitWorkspace(tenantId!, revision, result.workspace)) return Response.json({ success: false, message: 'Another change was saved first. Refresh and try again.' }, { status: 409 });
    return Response.json({ success: true, message: `${kind === 'logo' ? 'Logo' : 'Letterhead'} uploaded.`, path: stored.path, workspace: scopeWorkspace(result.workspace, actor) });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Upload failed.';
    const status = message === 'AUTH_REQUIRED' ? 401 : ['ACCESS_DENIED', 'TENANT_REQUIRED'].includes(message) ? 403 : 400;
    return Response.json({ success: false, message }, { status });
  }
}

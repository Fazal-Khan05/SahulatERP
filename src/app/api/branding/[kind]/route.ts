import { brandingKinds, signedBrandingUrl, type BrandingKind } from '@/lib/branding-store';
import { readWorkspace, requireMember } from '@/lib/workspace-store';

export const dynamic = 'force-dynamic';

/** Redirects a member to a short-lived signed URL for their company's logo or letterhead. */
export async function GET(request: Request, context: { params: Promise<{ kind: string }> }) {
  const { kind } = await context.params;
  const url = new URL(request.url);
  try {
    const tenantId = request.headers.get('x-tenant-id') || url.searchParams.get('tenant');
    await requireMember(tenantId);
    if (!brandingKinds.includes(kind as BrandingKind)) return new Response('Not found', { status: 404 });
    const { workspace } = await readWorkspace(tenantId!);
    const path = kind === 'logo' ? workspace.branding.logoPath : workspace.branding.letterheadPath;
    if (!path) return new Response('Not found', { status: 404 });
    const signed = await signedBrandingUrl(path);
    if (!signed) return new Response('Not found', { status: 404 });
    return Response.redirect(signed, 302);
  } catch {
    return new Response('Unauthorized', { status: 401 });
  }
}

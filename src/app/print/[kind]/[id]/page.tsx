import { notFound } from 'next/navigation';
import { DocumentPreview } from '@/components/document-preview';
import { PrintActions } from '@/components/print-actions';
import { signedBrandingUrl } from '@/lib/branding-store';
import { memberContext, readWorkspace } from '@/lib/workspace-store';
import { scopeWorkspace } from '@/modules/erp/access';
import { documentView, printableKinds, receiptView, type PrintableKind } from '@/modules/erp/documents';

export const dynamic = 'force-dynamic';

/** Printable document. A static route, so it takes precedence over the app's catch-all. */
export default async function Page({ params, searchParams }: { params: Promise<{ kind: string; id: string }>; searchParams: Promise<{ tenant?: string }> }) {
  const { kind, id } = await params;
  const { tenant } = await searchParams;
  if (!printableKinds.includes(kind as PrintableKind)) notFound();
  const context = await memberContext();
  if (!context) return <main className="print-message"><p>Sign in to print documents.</p><a href="/">Go to sign in</a></main>;
  const membership = context.memberships.find(item => item.tenantId === tenant) || context.memberships[0];
  if (!membership) notFound();
  const actor = context.actorFor(membership);
  const full = await readWorkspace(membership.tenantId).catch(() => null);
  if (!full) notFound();
  // Scoped first, so a member cannot print a document outside their role or branch.
  const workspace = scopeWorkspace(full.workspace, actor);
  const view = kind === 'receipt'
    ? (() => { const receipt = workspace.receipts.find(r => r.id === id); return receipt ? receiptView(workspace, receipt) : null; })()
    : (() => { const doc = workspace.documents.find(d => d.id === id && d.kind === kind); return doc ? documentView(workspace, doc) : null; })();
  if (!view) notFound();
  const [logoUrl, letterheadUrl] = await Promise.all([
    workspace.branding.logoPath ? signedBrandingUrl(workspace.branding.logoPath) : null,
    workspace.branding.letterheadPath ? signedBrandingUrl(workspace.branding.letterheadPath) : null,
  ]);
  return <main className="print-page">
    <PrintActions title={`${view.title} ${view.number}`}/>
    <DocumentPreview view={view} company={workspace.company} branding={workspace.branding} assets={{ logoUrl: logoUrl ?? undefined, letterheadUrl: letterheadUrl ?? undefined }}/>
  </main>;
}

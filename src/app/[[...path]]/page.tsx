import { LoginScreen } from '@/components/login-screen';
import { Workbench } from '@/components/workbench';
import { memberContext, readWorkspace } from '@/lib/workspace-store';
import { scopeWorkspace } from '@/modules/erp/access';

export const dynamic = 'force-dynamic';

export default async function Page({ searchParams }: { searchParams: Promise<{ tenant?: string }> }) {
  const context = await memberContext();
  if (!context) return <LoginScreen/>;
  const { supabase, memberships, actorFor } = context;
  const requestedTenant = (await searchParams).tenant;
  const membership = memberships.find(item => item.tenantId === requestedTenant) || memberships[0];
  if (!membership) return <main className="loading-screen"><h1>No workspace assigned</h1><p>Ask an owner to invite you to a company workspace.</p><form action="/auth/signout" method="post"><button>Sign out</button></form></main>;
  const actor = actorFor(membership);
  const [snapshot, { data: tenants }] = await Promise.all([
    readWorkspace(membership.tenantId).catch(() => null),
    supabase.from('tenants').select('id,name,is_demo').in('id', memberships.map(item => item.tenantId)),
  ]);
  if (!snapshot) return <main className="loading-screen"><h1>Workspace unavailable</h1><p>No company data found.</p></main>;
  const workspace = scopeWorkspace(snapshot.workspace, actor);
  return <Workbench initialWorkspace={workspace} actor={actor} memberships={memberships.map(item => {
    const tenant = tenants?.find(candidate => candidate.id === item.tenantId);
    return { tenantId: item.tenantId, role: item.role, branchIds: item.branchIds, name: tenant?.name || (item.tenantId === membership.tenantId ? workspace.company.name : 'Company workspace'), isDemo: tenant?.is_demo ?? false };
  })}/>;
}

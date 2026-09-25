import { LoginScreen } from '@/components/login-screen';
import { Workbench } from '@/components/workbench';
import { createServerSupabase } from '@/lib/supabase/server';
import { decodeWorkspace } from '@/modules/erp/codec';
import type { Role, Workspace } from '@/modules/erp/types';

export const dynamic = 'force-dynamic';

export default async function Page({ searchParams }: { searchParams: Promise<{ tenant?: string }> }) {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return <LoginScreen/>;
  const { data: memberships } = await supabase.from('memberships').select('tenant_id,role,branch_ids').eq('active', true);
  const requestedTenant = (await searchParams).tenant;
  const membership = memberships?.find(item => item.tenant_id === requestedTenant) || memberships?.[0];
  if (!membership) return <main className="loading-screen"><h1>No workspace assigned</h1><p>Ask an owner to invite you to a company workspace.</p><form action="/auth/signout" method="post"><button>Sign out</button></form></main>;
  const { data: snapshot, error } = await supabase.from('workspace_snapshots').select('data').eq('tenant_id', membership.tenant_id).single();
  if (error || !snapshot) return <main className="loading-screen"><h1>Workspace unavailable</h1><p>{error?.message ?? 'No company data found.'}</p></main>;
  return <Workbench initialWorkspace={decodeWorkspace(snapshot.data)} actor={{ id: user.id, name: user.user_metadata.display_name || user.email || 'User', role: membership.role as Role, branchIds: membership.branch_ids || [] }} memberships={(memberships || []).map(item => ({ tenantId: item.tenant_id, role: item.role as Role, branchIds: item.branch_ids || [] }))}/>;
}

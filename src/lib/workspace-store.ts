import 'server-only';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { createServerSupabase } from '@/lib/supabase/server';
import { decodeWorkspace } from '@/modules/erp/codec';
import type { Actor, Role, Workspace } from '@/modules/erp/types';

export type Membership = { tenantId: string; role: Role; branchIds: string[]; employeeId: string | null };

/** The signed-in user and their own memberships. Every query filters by user_id; RLS lets owners see colleagues' rows. */
export async function memberContext() {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;
  const { data, error } = await supabase.from('memberships').select('tenant_id,role,branch_ids,employee_id').eq('user_id', user.id).eq('active', true).order('created_at').order('tenant_id');
  if (error) throw error;
  const memberships: Membership[] = (data || []).map(row => ({ tenantId: row.tenant_id, role: row.role as Role, branchIds: row.branch_ids || [], employeeId: row.employee_id }));
  const actorFor = (membership: Membership): Actor => ({
    id: user.id, name: user.user_metadata.display_name || user.email || 'User', role: membership.role,
    branchIds: membership.branchIds, ...(membership.employeeId ? { employeeId: membership.employeeId } : {}),
  });
  return { supabase, user, memberships, actorFor };
}

export async function requireMember(tenantId: string | null) {
  const context = await memberContext();
  if (!context) throw new Error('AUTH_REQUIRED');
  if (!tenantId) throw new Error('TENANT_REQUIRED');
  const membership = context.memberships.find(item => item.tenantId === tenantId);
  if (!membership) throw new Error('ACCESS_DENIED');
  return { ...context, membership, actor: context.actorFor(membership) };
}

// The snapshot is read with server credentials only after membership is verified above, then scoped
// per role before it leaves the server. Members cannot select it directly (see RLS migration 202610120001).
export async function readWorkspace(tenantId: string): Promise<{ workspace: Workspace; revision: number }> {
  const { data, error } = await createAdminSupabase().from('workspace_snapshots').select('data,revision').eq('tenant_id', tenantId).single();
  if (error || !data) throw error || new Error('Workspace not found.');
  return { workspace: decodeWorkspace(data.data), revision: data.revision };
}

/**
 * Saves the snapshot and its relational projection in one database transaction. Database triggers
 * reject unbalanced or altered posted journals and duplicate sources, rolling the whole save back.
 * Returns false when another change was saved first.
 */
export async function commitWorkspace(tenantId: string, expectedRevision: number, workspace: Workspace, rebuild = false) {
  const { data, error } = await createAdminSupabase().rpc('commit_workspace', { p_tenant: tenantId, p_expected: expectedRevision, p_data: workspace, p_rebuild: rebuild });
  if (error) throw new Error(`INTEGRITY:${error.message}`);
  return data !== null;
}

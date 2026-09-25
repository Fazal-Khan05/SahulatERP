import { createAdminSupabase } from '@/lib/supabase/admin';
import { createServerSupabase } from '@/lib/supabase/server';
import { buildDemoWorkspace } from '@/modules/erp/demo';
import { DEMO_TENANT } from '@/modules/erp/types';

export async function POST() {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return Response.json({ success: false, message: 'Sign in first.' }, { status: 401 });
  const { data: membership } = await supabase.from('memberships').select('role').eq('tenant_id', DEMO_TENANT).eq('active', true).single();
  if (!membership || membership.role !== 'Owner') return Response.json({ success: false, message: 'Only the demo workspace owner can reset this company.' }, { status: 403 });
  const workspace = buildDemoWorkspace();
  const { error } = await createAdminSupabase().from('workspace_snapshots').update({ data: workspace, revision: workspace.revision, updated_at: new Date().toISOString() }).eq('tenant_id', DEMO_TENANT);
  if (error) return Response.json({ success: false, message: error.message }, { status: 500 });
  return Response.json({ success: true, message: 'Demo company restored to its original synthetic data.', workspace });
}

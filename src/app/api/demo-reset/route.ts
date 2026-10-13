import { commitWorkspace, readWorkspace, requireMember } from '@/lib/workspace-store';
import { scopeWorkspace } from '@/modules/erp/access';
import { buildDemoWorkspace } from '@/modules/erp/demo';
import { DEMO_TENANT } from '@/modules/erp/types';

export async function POST() {
  try {
    const { actor } = await requireMember(DEMO_TENANT);
    if (actor.role !== 'Owner') return Response.json({ success: false, message: 'Only the demo workspace owner can reset this company.' }, { status: 403 });
    const { revision } = await readWorkspace(DEMO_TENANT);
    // Revision keeps increasing so a client holding the pre-reset revision cannot overwrite the reset.
    const workspace = { ...buildDemoWorkspace(), revision: revision + 1 };
    // Rebuild replaces the snapshot and every relational projection row for the demo tenant in one transaction.
    await commitWorkspace(DEMO_TENANT, revision, workspace, true);
    return Response.json({ success: true, message: 'Demo company restored to its original synthetic data.', workspace: scopeWorkspace(workspace, actor) });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Reset failed.';
    const status = message === 'AUTH_REQUIRED' ? 401 : message === 'ACCESS_DENIED' ? 403 : 500;
    return Response.json({ success: false, message: status === 500 ? 'The demo could not be reset. Nothing was changed.' : 'Sign in as the demo owner first.' }, { status });
  }
}

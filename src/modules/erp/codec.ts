import type { Workspace } from './types';

export function decodeWorkspace(value: unknown): Workspace {
  const decoded = typeof value === 'string' ? JSON.parse(value) : value;
  if (!decoded || typeof decoded !== 'object' || !('tenantId' in decoded) || !('company' in decoded)) {
    throw new Error('The persisted workspace is invalid.');
  }
  // Snapshots saved before follow-ups were persisted have no followUps array.
  const workspace = decoded as Workspace;
  return { ...workspace, followUps: workspace.followUps ?? [] };
}

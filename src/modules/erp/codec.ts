import type { Workspace } from './types';

export function decodeWorkspace(value: unknown): Workspace {
  const decoded = typeof value === 'string' ? JSON.parse(value) : value;
  if (!decoded || typeof decoded !== 'object' || !('tenantId' in decoded) || !('company' in decoded)) {
    throw new Error('The persisted workspace is invalid.');
  }
  return decoded as Workspace;
}

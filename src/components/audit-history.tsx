'use client';
import { TableCard } from './table-card';
import type { Workspace } from '@/modules/erp/types';

/** Settings → Audit history: the latest 15 entries. Entries record the member's user id; the name shown is the display name saved with the entry (older entries hold only the name). */
export function AuditHistory({ workspace }: { workspace: Pick<Workspace, 'audit'> }) {
  return <TableCard title="Audit history" heads={['Time', 'Actor', 'Role', 'Action', 'Detail']}
    rows={workspace.audit.slice(-15).reverse().map(e => [new Date(e.date).toLocaleString('en-PK', { timeZone: 'Asia/Karachi' }), e.actorName || e.actor, e.role, e.action.replaceAll('_', ' '), e.detail])}/>;
}

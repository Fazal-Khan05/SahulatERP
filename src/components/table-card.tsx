'use client';
import type { ReactNode } from 'react';
import '../app/workspace-views.css';

export type CommandFn = (type: string, payload: Record<string, unknown>, options?: { confirmPassword?: string }) => Promise<{ ok: boolean; message: string; passwordRequired?: boolean; recordId?: string }>;

const tones: [string, string[]][] = [
  ['success', ['paid', 'cleared', 'accepted', 'approved', 'submitted', 'costed', 'reconciled', 'available']],
  ['danger', ['rejected', 'bounced']],
  ['warning', ['queued', 'received', 'pending', 'outcome_unknown', 'low stock', 'review']],
  ['draft', ['draft']],
];
/** Badge tone for a status word; anything unlisted is info. */
export const statusTone = (value: string) => tones.find(([, values]) => values.includes(value))?.[0] ?? 'info';

export function Status({ value }: { value: string }) { return <span className={`badge ${statusTone(value)}`}>{value.replaceAll('_', ' ')}</span>; }

type TableCardProps = { title: string; action?: ReactNode; heads: string[]; rows: ReactNode[][]; children?: ReactNode };

/** A titled card holding one scrollable table; `children` render under the table. */
export function TableCard({ title, action, heads, rows, children }: TableCardProps) {
  return <section className="card">
    <div className="card-heading"><div><h2>{title}</h2><p>{rows.length} records</p></div>{action}</div>
    <div className="table-scroll" tabIndex={0} role="region" aria-label={`${title} table`}><table>
      <thead><tr>{heads.map(head => <th key={head}>{head}</th>)}</tr></thead>
      <tbody>{rows.length ? rows.map((row, index) => <tr key={index}>{row.map((cell, column) => <td key={column}>{cell}</td>)}</tr>) : <tr><td colSpan={heads.length}><div className="empty-state">No records yet.</div></td></tr>}</tbody>
    </table></div>
    <p className="table-scroll-hint">Swipe sideways to see every column.</p>
    {children}
  </section>;
}

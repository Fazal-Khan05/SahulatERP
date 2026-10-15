'use client';
import type { ReactNode } from 'react';
import '../app/workspace-views.css';

export type CommandFn = (type: string, payload: Record<string, unknown>, options?: { confirmPassword?: string }) => Promise<{ ok: boolean; message: string; passwordRequired?: boolean; recordId?: string }>;

// Payroll's five statuses each get their own tone: draft violet, reviewed amber, approved info blue, paid green, cancelled grey.
const tones: [string, string[]][] = [
  ['success', ['paid', 'cleared', 'accepted', 'submitted', 'costed', 'reconciled', 'available']],
  ['danger', ['rejected', 'bounced']],
  ['warning', ['queued', 'received', 'pending', 'outcome_unknown', 'low stock', 'review', 'reviewed']],
  ['draft', ['draft']],
  // Neutral grey (the plain .badge): nothing is due yet (unreleased commission) or the record no longer counts (cancelled).
  ['neutral', ['cancelled', 'unreleased']],
];
/** Badge tone for a status word; anything unlisted (approved, deposited, in transit…) is info. */
export const statusTone = (value: string) => tones.find(([, values]) => values.includes(value))?.[0] ?? 'info';

export function Status({ value }: { value: string }) { return <span className={`badge ${statusTone(value)}`}>{value.replaceAll('_', ' ')}</span>; }

type TableCardProps = {
  title: string; action?: ReactNode; heads: string[]; rows: ReactNode[][]; children?: ReactNode;
  /** Indexes of the amount columns: right-aligned with tabular numerals, header included. */
  numeric?: number[];
  /** Filters between the heading and the table. */
  toolbar?: ReactNode;
  /** Replaces "N records" under the title, e.g. "3 of 12 receipts". */
  subtitle?: ReactNode;
  /** What the table says when it has no rows. */
  empty?: ReactNode;
};

/** A titled card holding one scrollable table; `children` render under the table. */
export function TableCard({ title, action, heads, rows, children, numeric = [], toolbar, subtitle, empty = 'No records yet.' }: TableCardProps) {
  const align = (column: number) => numeric.includes(column) ? 'num align-right' : undefined;
  return <section className="card">
    <div className="card-heading"><div><h2>{title}</h2><p>{subtitle ?? `${rows.length} records`}</p></div>{action}</div>
    {toolbar}
    <div className="table-scroll" tabIndex={0} role="region" aria-label={`${title} table`}><table>
      <thead><tr>{heads.map((head, column) => <th key={head} className={align(column)}>{head}</th>)}</tr></thead>
      <tbody>{rows.length ? rows.map((row, index) => <tr key={index}>{row.map((cell, column) => <td key={column} className={align(column)}>{cell}</td>)}</tr>) : <tr><td colSpan={heads.length}><div className="empty-state">{empty}</div></td></tr>}</tbody>
    </table></div>
    <p className="table-scroll-hint">Swipe sideways to see every column.</p>
    {children}
  </section>;
}

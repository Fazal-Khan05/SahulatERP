'use client';
import { useEffect, useRef, useState } from 'react';
import { Loader2, Plus, X } from 'lucide-react';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from './ui/dialog';
import { Status, TableCard, type CommandFn } from './table-card';
import { canRun } from '@/modules/erp/engine';
import { businessToday } from '@/modules/erp/dates';
import { formatMoney, money, sum } from '@/modules/erp/money';
import type { Actor, Payroll, Workspace } from '@/modules/erp/types';

const nextStatus: Partial<Record<Payroll['status'], Payroll['status']>> = { draft: 'reviewed', reviewed: 'approved', approved: 'paid' };
/** A run is dated today when it is for the current month, otherwise on the last day of its month. */
export function payrollDate(month: string, today = businessToday()) {
  if (month >= today.slice(0, 7)) return today;
  const [year, m] = month.split('-').map(Number);
  return new Date(Date.UTC(year, m, 0)).toISOString().slice(0, 10);
}

/** Payroll runs: create (for any month up to this one), move through review → approval → payment, cancel a draft or reviewed run, and open a run's per-employee lines. */
export function PayrollRuns({ workspace, actor, editable, busy, command }: { workspace: Workspace; actor: Actor; editable: boolean; busy: string; command: CommandFn }) {
  const today = businessToday();
  const [month, setMonth] = useState(today.slice(0, 7));
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState<Payroll | null>(null);
  const can = (action: string) => editable && canRun(actor.role, action);
  const runs = workspace.payrolls.slice().sort((a, b) => b.month.localeCompare(a.month));
  const selected = runs.find(run => run.id === selectedId) ?? null;
  const action = can('create_payroll') ? <div className="inventory-actions">
    <input className="payroll-month" type="month" aria-label="Payroll month" value={month} max={today.slice(0, 7)} required onChange={e => setMonth(e.target.value)}/>
    <Button disabled={!!busy || !month} onClick={() => command('create_payroll', { month, date: payrollDate(month, today) })}><Plus size={16}/>Create payroll</Button>
  </div> : undefined;
  const rows = runs.map(run => {
    const next = nextStatus[run.status];
    const cancellable = run.status === 'draft' || run.status === 'reviewed';
    const actions = run.status === 'cancelled' ? <span key="a">Cancelled</span>
      : !next ? <span key="a">Complete</span>
      : can('update_payroll') || (cancellable && can('cancel_payroll')) ? <div key="a" className="inventory-row-actions">
        {can('update_payroll') && <Button size="sm" disabled={!!busy} onClick={() => command('update_payroll', { id: run.id, status: next })}>{next}</Button>}
        {cancellable && can('cancel_payroll') && <Button size="sm" variant="outline" disabled={!!busy} onClick={() => setCancelling(run)}>Cancel run</Button>}
      </div>
      : <span key="a">Read only</span>;
    return [
      <button key="n" type="button" className="text-button run-number" aria-expanded={selectedId === run.id} aria-controls={selectedId === run.id ? 'payroll-run-lines' : undefined} onClick={() => setSelectedId(id => id === run.id ? null : run.id)}>{run.number}</button>,
      run.month, run.lines.length, formatMoney(money(sum(run.lines.map(l => l.recovery ?? '0')))), <Status key="s" value={run.status}/>, formatMoney(run.total), actions,
    ];
  });
  return <div className="stack">
    <TableCard title="Payroll runs" action={action} heads={['Run', 'Month', 'Employees', 'Commission recovered', 'Status', 'Net payroll', 'Next action']} rows={rows}/>
    {selected && <PayrollLines workspace={workspace} run={selected} onClose={() => setSelectedId(null)}/>}
    <Dialog open={!!cancelling} onOpenChange={open => { if (!open) setCancelling(null); }}><DialogContent className="confirm-dialog">
      <DialogTitle>Cancel {cancelling?.number}?</DialogTitle>
      <DialogDescription>The run stops counting and the commissions it holds are released. Create payroll for {cancelling?.month} again to recalculate it with the current commissions and attendance. This cannot be undone.</DialogDescription>
      <div className="form-actions"><Button variant="outline" onClick={() => setCancelling(null)}>Keep run</Button><Button variant="destructive" disabled={!!busy} onClick={async () => { const run = cancelling!; const result = await command('cancel_payroll', { id: run.id }); if (result.ok) setCancelling(null); }}>{busy === 'cancel_payroll' ? <Loader2 className="spin" size={16}/> : <X size={16}/>}Cancel run</Button></div>
    </DialogContent></Dialog>
  </div>;
}

/** One run's per-employee lines; the table scrolls sideways on a phone. */
function PayrollLines({ workspace, run, onClose }: { workspace: Workspace; run: Payroll; onClose: () => void }) {
  const heads = ['Employee', 'Basic', 'Allowance', 'Commission', 'Recovery', 'Employee EOBI', 'Income tax', 'Deductions', 'Net pay'];
  const amounts = (l: Payroll['lines'][number]) => [l.basic, l.allowance, l.commission, l.recovery ?? '0', l.employeeEobi, l.incomeTax, l.deduction, l.net];
  const totals = heads.slice(1).map((_, i) => money(sum(run.lines.map(l => amounts(l)[i]))));
  const employerEobi = money(sum(run.lines.map(l => l.employerEobi)));
  // Opening a run from the table brings its lines into view (they sit below the runs on a phone).
  const ref = useRef<HTMLElement>(null);
  useEffect(() => { ref.current?.scrollIntoView?.({ block: 'nearest' }); }, [run.id]);
  return <section ref={ref} className="card payroll-lines" id="payroll-run-lines" aria-label={`${run.number} lines`}>
    <div className="card-heading"><div><h2>{run.number} lines</h2><p>{run.month} · {run.lines.length} {run.lines.length === 1 ? 'employee' : 'employees'} · {run.status}</p></div><Button variant="outline" size="sm" onClick={onClose}><X size={14}/>Close</Button></div>
    <div className="table-scroll" tabIndex={0} role="region" aria-label={`${run.number} lines table`}><table>
      <thead><tr>{heads.map((h, i) => <th key={h} className={i ? 'num align-right' : undefined}>{h}</th>)}</tr></thead>
      <tbody>{run.lines.map(l => <tr key={l.employeeId}><td>{workspace.employees.find(e => e.id === l.employeeId)?.name ?? '—'}</td>{amounts(l).map((value, i) => <td key={heads[i + 1]} className="num align-right">{formatMoney(value)}</td>)}</tr>)}</tbody>
      <tfoot><tr><td>Total</td>{totals.map((value, i) => <td key={heads[i + 1]} className="num align-right">{formatMoney(value)}</td>)}</tr></tfoot>
    </table></div>
    <p className="table-scroll-hint">Swipe sideways to see every column.</p>
    <p className="card-body payroll-lines-note">Net pay = basic + allowance + commission − recovery − employee EOBI − income tax − deductions. Employer EOBI of {formatMoney(employerEobi)} is a company cost and is not deducted from pay.</p>
  </section>;
}

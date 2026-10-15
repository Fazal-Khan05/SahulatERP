'use client';
import { useState, type FormEvent } from 'react';
import { ArrowLeftRight, Banknote, Landmark, Loader2, Plus, Receipt, Wallet } from 'lucide-react';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from './ui/dialog';
import { businessToday } from '@/modules/erp/dates';
import { accountBalance } from '@/modules/erp/engine';
import { D, formatMoney, money, sum } from '@/modules/erp/money';
import { accountActivity } from '@/modules/erp/reports';
import type { Actor, BankAccount, Workspace } from '@/modules/erp/types';

type CommandResult = { ok: boolean; message: string };
type CommandFn = (type: string, payload: Record<string, unknown>) => Promise<CommandResult>;
type ModalKind = 'account' | 'transfer' | 'expense' | null;
/** Overdrawn balances (below zero) show in the danger colour; the minus sign stays as the non-colour cue. */
const balanceTone = (value: string) => D(value).lt(0) ? { color: 'var(--danger)' } : undefined;

/** Bank and cash accounts with balances and activity, transfers, petty expenses and the cheque register. */
export function CashBankView({ workspace, actor, editable, busy, command }: { workspace: Workspace; actor: Actor; editable: boolean; busy: string; command: CommandFn }) {
  const [modal, setModal] = useState<ModalKind>(null);
  const [editing, setEditing] = useState<BankAccount | null>(null);
  const [selected, setSelected] = useState<string>(workspace.bankAccounts[0]?.code ?? '1000');
  const [error, setError] = useState('');
  const accounts = workspace.bankAccounts.filter(a => !a.archived);
  const legacy = D(accountBalance(workspace, '1000'));
  const total = sum([legacy, ...accounts.map(a => accountBalance(workspace, a.code))]);
  const activity = accountActivity(workspace, selected);
  const selectedName = selected === '1000' ? 'Bank & cash (legacy)' : workspace.bankAccounts.find(a => a.code === selected)?.name ?? selected;
  const cheques = workspace.receipts.filter(r => r.method === 'cheque' && ['received', 'deposited'].includes(r.status)).sort((a, b) => a.dueDate.localeCompare(b.dueDate));
  const canManage = editable && actor.role !== 'Recovery Officer';

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError('');
    const f = new FormData(event.currentTarget); const v = (k: string) => String(f.get(k) ?? '').trim();
    let result: CommandResult;
    if (modal === 'account') result = await command('save_bank_account', { ...(editing ? { id: editing.id } : {}), name: v('name'), type: v('type'), details: v('details') });
    else if (modal === 'transfer') result = await command('bank_transfer', { fromId: v('fromId'), toId: v('toId'), amount: v('amount'), date: v('date'), memo: v('memo') });
    else result = await command('record_expense', { accountId: v('accountId'), amount: v('amount'), date: v('date'), memo: v('memo'), expenseAccount: v('expenseAccount') || '5300' });
    if (result.ok) { setModal(null); setEditing(null); } else setError(result.message);
  }
  const close = () => { setModal(null); setEditing(null); setError(''); };
  const today = businessToday();

  return <div className="stack">
    <div className="metric-grid">
      <section className="metric-card"><div className="metric-label">All cash & bank<span className="metric-icon"><Wallet size={18}/></span></div><strong style={balanceTone(money(total))}>{formatMoney(money(total))}</strong><small>Posted balances</small></section>
      {accounts.slice(0, 3).map(a => <section className="metric-card" key={a.id}><div className="metric-label">{a.name}<span className="metric-icon">{a.type === 'bank' ? <Landmark size={18}/> : <Banknote size={18}/>}</span></div><strong style={balanceTone(accountBalance(workspace, a.code))}>{formatMoney(accountBalance(workspace, a.code))}</strong><small>{a.type === 'bank' ? a.details || 'Bank account' : 'Cash'}</small></section>)}
    </div>
    <section className="card">
      <div className="card-heading"><div><h2>Accounts</h2><p>{accounts.length} active · select one to see its activity</p></div>
        {canManage && <div className="inventory-actions"><Button variant="outline" disabled={accounts.length < 2} onClick={() => setModal('transfer')}><ArrowLeftRight size={16}/>Transfer</Button><Button variant="outline" disabled={!accounts.length} onClick={() => setModal('expense')}><Receipt size={16}/>Record expense</Button><Button onClick={() => { setEditing(null); setModal('account'); }}><Plus size={16}/>New account</Button></div>}
      </div>
      <div className="table-scroll"><table><thead><tr><th>Account</th><th>Type</th><th>Details</th><th>Ledger code</th><th>Balance</th><th>Actions</th></tr></thead><tbody>
        {accounts.map(a => <tr key={a.id} className={selected === a.code ? 'row-selected' : undefined}>
          <td><button className="text-button" onClick={() => setSelected(a.code)}><strong>{a.name}</strong></button></td><td>{a.type}</td><td>{a.details || '—'}</td><td>{a.code}</td><td style={balanceTone(accountBalance(workspace, a.code))}>{formatMoney(accountBalance(workspace, a.code))}</td>
          <td><div className="inventory-row-actions"><Button size="sm" variant="outline" onClick={() => setSelected(a.code)}>Activity</Button>{canManage && <Button size="sm" variant="ghost" aria-label={`Edit ${a.name}`} onClick={() => { setEditing(a); setModal('account'); }}>Edit</Button>}</div></td>
        </tr>)}
        {!legacy.isZero() && <tr className={selected === '1000' ? 'row-selected' : undefined}><td><button className="text-button" onClick={() => setSelected('1000')}><strong>Bank & cash (legacy)</strong></button></td><td>—</td><td>Receipts recorded before accounts existed</td><td>1000</td><td style={balanceTone(money(legacy))}>{formatMoney(money(legacy))}</td><td><Button size="sm" variant="outline" onClick={() => setSelected('1000')}>Activity</Button></td></tr>}
        {!accounts.length && legacy.isZero() && <tr><td colSpan={6}><div className="empty-state">No accounts yet. Add your bank account and a cash-in-hand account.</div></td></tr>}
      </tbody></table></div>
    </section>
    <section className="card">
      <div className="card-heading"><div><h2>Activity · {selectedName}</h2><p>Balance <span style={balanceTone(activity.balance)}>{formatMoney(activity.balance)}</span> · latest {activity.rows.length} movements</p></div></div>
      <div className="table-scroll"><table><thead><tr><th>Date</th><th>Journal</th><th>Description</th><th>In</th><th>Out</th><th>Balance</th></tr></thead><tbody>
        {activity.rows.length ? activity.rows.map((r, i) => <tr key={`${r.journal}-${i}`}><td>{r.date}</td><td>{r.journal}</td><td>{r.memo}</td><td>{r.debit ? formatMoney(r.debit) : ''}</td><td>{r.credit ? formatMoney(r.credit) : ''}</td><td style={balanceTone(r.balance)}>{formatMoney(r.balance)}</td></tr>) : <tr><td colSpan={6}><div className="empty-state">No movements on this account yet.{canManage && accounts.length
          ? <div className="form-actions" style={{ justifyContent: 'center', marginTop: 14 }}>{accounts.length > 1 && <Button variant="outline" onClick={() => setModal('transfer')}><ArrowLeftRight size={16}/>Transfer</Button>}<Button variant="outline" onClick={() => setModal('expense')}><Receipt size={16}/>Record expense</Button></div>
          : ' Receipts, transfers and expenses posted to it appear here.'}</div></td></tr>}
      </tbody></table></div>
    </section>
    <section className="card">
      <div className="card-heading"><div><h2>Cheques in hand</h2><p>{cheques.length} awaiting deposit or clearance · deposit into an account, then mark cleared or bounced</p></div></div>
      <div className="table-scroll"><table><thead><tr><th>Cheque</th><th>Customer / supplier</th><th>Cheque date</th><th>Amount</th><th>Status</th><th>Account</th><th>Actions</th></tr></thead><tbody>
        {cheques.length ? cheques.map(r => <ChequeRow key={r.id} receipt={r} workspace={workspace} editable={editable} busy={busy} command={command}/>) : <tr><td colSpan={7}><div className="empty-state">No cheques waiting.</div></td></tr>}
      </tbody></table></div>
    </section>

    <Dialog open={modal !== null} onOpenChange={v => { if (!v) close(); }}><DialogContent className="record-dialog">
      <DialogTitle>{modal === 'account' ? (editing ? `Edit ${editing.name}` : 'New bank or cash account') : modal === 'transfer' ? 'Transfer between accounts' : 'Record an expense'}</DialogTitle>
      <DialogDescription>{modal === 'account' ? 'Each account gets its own ledger code under Bank & cash.' : modal === 'transfer' ? 'Moves money between two of your accounts; posts one balanced journal.' : 'Money paid out of an account for an operating cost.'}</DialogDescription>
      <form key={`${modal}-${editing?.id ?? 'new'}`} className="field-grid record-form" onSubmit={submit}>
        {modal === 'account' && <>
          <label className="full-width"><span className="record-label">Account name<span className="record-required">*</span></span><input name="name" defaultValue={editing?.name ?? ''} required minLength={2} maxLength={80} autoFocus/></label>
          <label>Type<select name="type" defaultValue={editing?.type ?? 'bank'}><option value="bank">Bank account</option><option value="cash">Cash</option></select></label>
          <label>Bank / branch / account no.<input name="details" defaultValue={editing?.details ?? ''} maxLength={200} placeholder="HBL · Saddar branch · 0012-3456789"/></label>
        </>}
        {modal === 'transfer' && <>
          <label>From<select name="fromId" defaultValue={accounts[0]?.id} aria-label="From account">{accounts.map(a => <option key={a.id} value={a.id}>{a.name} · {formatMoney(accountBalance(workspace, a.code))}</option>)}</select></label>
          <label>To<select name="toId" defaultValue={accounts[1]?.id} aria-label="To account">{accounts.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}</select></label>
          <label>Amount (PKR)<input name="amount" type="number" min="0.01" step="0.01" required aria-label="Transfer amount"/></label>
          <label>Date<input name="date" type="date" defaultValue={today} required/></label>
          <label className="full-width">Memo<input name="memo" maxLength={200} placeholder="Cash float, bank deposit…"/></label>
        </>}
        {modal === 'expense' && <>
          <label>Paid from<select name="accountId" defaultValue={accounts.find(a => a.type === 'cash')?.id ?? accounts[0]?.id} aria-label="Paid from account">{accounts.map(a => <option key={a.id} value={a.id}>{a.name} · {formatMoney(accountBalance(workspace, a.code))}</option>)}</select></label>
          <label>Expense type<select name="expenseAccount" defaultValue="5300"><option value="5300">Operating expense</option><option value="5200">Salary / wages</option></select></label>
          <label>Amount (PKR)<input name="amount" type="number" min="0.01" step="0.01" required aria-label="Expense amount"/></label>
          <label>Date<input name="date" type="date" defaultValue={today} required/></label>
          <label className="full-width"><span className="record-label">What for<span className="record-required">*</span></span><input name="memo" required minLength={2} maxLength={200} placeholder="Fuel, tea, courier, repairs…" aria-label="Expense memo"/></label>
        </>}
        {error && <p className="error-note full-width" role="alert">{error}</p>}
        <div className="form-actions full-width"><Button type="button" variant="outline" onClick={close}>Cancel</Button><Button type="submit" disabled={!!busy}>{busy ? <Loader2 className="spin" size={16}/> : null}{modal === 'account' ? (editing ? 'Save changes' : 'Add account') : modal === 'transfer' ? 'Transfer' : 'Record expense'}</Button></div>
      </form>
    </DialogContent></Dialog>
  </div>;
}

/** One cheque with its lifecycle buttons; used here and in Collections. */
export function ChequeRow({ receipt: r, workspace, editable, busy, command }: { receipt: Workspace['receipts'][number]; workspace: Workspace; editable: boolean; busy: string; command: CommandFn }) {
  const [accountId, setAccountId] = useState(r.accountId ?? workspace.bankAccounts.find(a => a.type === 'bank' && !a.archived)?.id ?? '');
  const party = workspace.parties.find(p => p.id === r.partyId);
  const accounts = workspace.bankAccounts.filter(a => !a.archived && a.type === 'bank');
  const today = businessToday();
  return <tr>
    <td><strong>{r.chequeNo}</strong><small>{r.number}</small></td><td>{party?.name ?? '—'}</td><td>{r.dueDate}</td><td>{formatMoney(r.amount)}</td><td><span className={`badge ${r.status === 'deposited' ? 'info' : 'warning'}`}>{r.status}</span></td>
    <td>{r.status === 'received' && editable ? <select aria-label={`Deposit account for ${r.chequeNo}`} value={accountId} onChange={e => setAccountId(e.target.value)}>{accounts.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}{!accounts.length && <option value="">Legacy bank & cash</option>}</select> : (workspace.bankAccounts.find(a => a.id === r.accountId)?.name ?? '—')}</td>
    <td><div className="inventory-row-actions">
      {editable && r.status === 'received' && <Button size="sm" disabled={!!busy} aria-label={`Deposit ${r.chequeNo}`} onClick={() => command('update_cheque', { id: r.id, status: 'deposited', date: today, accountId })}>Deposit</Button>}
      {editable && r.status === 'deposited' && <Button size="sm" disabled={!!busy} aria-label={`Clear ${r.chequeNo}`} onClick={() => command('update_cheque', { id: r.id, status: 'cleared', date: today })}>Cleared</Button>}
      {editable && <Button size="sm" variant="ghost" disabled={!!busy} aria-label={`Bounce ${r.chequeNo}`} onClick={() => { if (window.confirm(`Mark cheque ${r.chequeNo} as bounced?`)) command('update_cheque', { id: r.id, status: 'bounced', date: today }); }}>Bounced</Button>}
      {!editable && <span>Read only</span>}
    </div></td>
  </tr>;
}

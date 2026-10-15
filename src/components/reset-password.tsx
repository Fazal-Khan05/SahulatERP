'use client';
import { useEffect, useState, type FormEvent } from 'react';
import { CheckCircle2, Loader2, LockKeyhole, ShieldCheck } from 'lucide-react';
import { postAuth } from '@/lib/supabase/client';
import { Button } from './ui/button';

type State = 'checking' | 'ready' | 'expired' | 'saved';

// The reset session that last set a password here. A refresh, or the same emailed link again, then shows the
// finished state instead of a second form.
const CHANGED = 'sahulat-password-changed';
const changedLink = () => { try { return localStorage.getItem(CHANGED); } catch { return null; } };

export function ResetPassword() {
  const [state, setState] = useState<State>('checking');
  const [link, setLink] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  // The callback route exchanged the emailed code for a recovery session; without one the link is expired or used.
  // The session cookies are HttpOnly, so the server answers whether there is one.
  useEffect(() => {
    fetch('/auth/password', { cache: 'no-store' })
      .then(response => response.json() as Promise<{ ready?: boolean; link?: string }>)
      .then(({ ready, link = '' }) => { setLink(link); setState(!ready ? 'expired' : changedLink() === link ? 'saved' : 'ready'); }, () => setState('expired'));
  }, []);

  async function submit(event: FormEvent) {
    event.preventDefault(); setMessage('');
    if (password.length < 8) return setMessage('Use at least 8 characters.');
    if (password !== confirm) return setMessage('The two passwords do not match.');
    setBusy(true);
    const error = await postAuth('/auth/password', { password });
    setBusy(false);
    if (error) return setMessage(error);
    try { localStorage.setItem(CHANGED, link); } catch { /* storage blocked: a refresh shows the form again, nothing worse */ }
    setState('saved');
  }

  return <main className="login-shell reset-shell"><section className="login-panel">
    <div className="login-brand"><span className="brand-mark">S</span><span>Sahulat<strong>ERP</strong></span></div>
    <div className="login-copy"><h1>Set a new password</h1><p>Choose a password of at least 8 characters.</p></div>
    {state === 'checking' && <p className="form-note"><Loader2 className="spin" size={16}/> Checking your reset link…</p>}
    {state === 'expired' && <div className="login-form"><p className="error-note">This reset link has expired or was already used. Request a new one from the sign-in page.</p><a className="button button-primary" href="/">Back to sign in</a></div>}
    {state === 'saved' && <div className="login-form"><p className="form-note"><CheckCircle2 size={16}/> Your password was changed.</p><a className="button button-primary" href="/">Continue to SahulatERP</a></div>}
    {state === 'ready' && <form onSubmit={submit} className="login-form">
      <label>New password<div className="input-wrap"><LockKeyhole size={17}/><input value={password} onChange={event => setPassword(event.target.value)} type="password" autoComplete="new-password" required minLength={8}/></div></label>
      <label>Confirm new password<div className="input-wrap"><LockKeyhole size={17}/><input value={confirm} onChange={event => setConfirm(event.target.value)} type="password" autoComplete="new-password" required minLength={8}/></div></label>
      {message && <p className="error-note">{message}</p>}
      <Button type="submit" disabled={busy}>{busy ? <Loader2 className="spin" size={17}/> : <ShieldCheck size={17}/>}Save new password</Button>
    </form>}
  </section></main>;
}

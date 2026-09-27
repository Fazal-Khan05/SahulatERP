'use client';
import { useState, type FormEvent } from 'react';
import { Eye, EyeOff, Loader2, LockKeyhole, Mail, ShieldCheck } from 'lucide-react';
import { createBrowserSupabase } from '@/lib/supabase/client';
import { Button } from './ui/button';

export function LoginScreen() {
  const [email, setEmail] = useState('owner@sahulaterp.com');
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setMessage('');
    const { error } = await createBrowserSupabase().auth.signInWithPassword({ email, password });
    if (error) { setMessage(error.message); setBusy(false); return; }
    window.location.assign('/');
  }
  async function reset() {
    setBusy(true); setMessage('');
    const { error } = await createBrowserSupabase().auth.resetPasswordForEmail(email, { redirectTo: `${window.location.origin}/auth/callback?next=/account/reset` });
    setMessage(error ? error.message : 'Password reset instructions were sent if this address is registered.');
    setBusy(false);
  }
  return <main className="login-shell"><section className="login-panel">
    <div className="login-brand"><span className="brand-mark">S</span><span>Sahulat<strong>ERP</strong></span></div>
    <div className="login-copy"><span className="eyebrow">BUSINESS OPERATIONS, CONNECTED</span><h1>Welcome back</h1><p>Sign in to manage sales, stock, imports, collections, commissions and accounting.</p></div>
    <form onSubmit={submit} className="login-form">
      <label>Email address<div className="input-wrap"><Mail size={17}/><input value={email} onChange={event=>setEmail(event.target.value)} type="email" autoComplete="email" required/></div></label>
      <label>Password<div className="input-wrap"><LockKeyhole size={17}/><input value={password} onChange={event=>setPassword(event.target.value)} type={show?'text':'password'} autoComplete="current-password" required minLength={8}/><button type="button" aria-label={show?'Hide password':'Show password'} onClick={()=>setShow(value=>!value)}>{show?<EyeOff size={17}/>:<Eye size={17}/>}</button></div></label>
      {message&&<p className={message.startsWith('Password reset')?'form-note':'error-note'}>{message}</p>}
      <Button type="submit" disabled={busy}>{busy?<Loader2 className="spin" size={17}/>:<ShieldCheck size={17}/>}Sign in securely</Button>
      <button type="button" className="text-button" onClick={reset} disabled={busy}>Forgot your password?</button>
    </form>
    <div className="simulation-note"><ShieldCheck size={18}/><span><strong>Working prototype</strong> External payments and customs lookups are simulated.</span></div>
  </section><aside className="login-visual"><div><span className="login-kicker">SAHULAT TRADING CO.</span><h2>Your entire trading operation, one clear view.</h2><p>From imported stock to cleared collections and payroll, every number remains connected to its source.</p><div className="login-stat-grid"><span><strong>11</strong>Connected modules</span><span><strong>2</strong>Isolated workspaces</span><span><strong>100%</strong>Audited changes</span></div></div></aside></main>;
}

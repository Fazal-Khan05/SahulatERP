'use client';
import { useState, type FormEvent } from 'react';
import { Eye, EyeOff, Loader2, LockKeyhole, Mail, ShieldCheck } from 'lucide-react';
import { postAuth } from '@/lib/supabase/client';
import { Button } from './ui/button';

export function LoginScreen() {
  const [email, setEmail] = useState('owner@sahulaterp.com');
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setMessage('');
    // The server signs in and keeps the session in HttpOnly cookies.
    const error = await postAuth('/auth/signin', { email, password });
    if (error) { setMessage(error); setBusy(false); return; }
    // Stay on the requested workspace/page (e.g. /?tenant=…) rather than dropping it on sign-in.
    window.location.assign(`${window.location.pathname}${window.location.search}`);
  }
  async function reset() {
    setBusy(true); setMessage('');
    const error = await postAuth('/auth/forgot', { email });
    setMessage(error ?? 'Password reset instructions were sent if this address is registered.');
    setBusy(false);
  }
  return <main className="login-shell"><section className="login-panel">
    <div className="login-brand"><span className="brand-mark">S</span><span>Sahulat<strong>ERP</strong></span></div>
    <div className="login-copy"><h1>Welcome back</h1><p>Sign in to manage sales, stock, imports, collections, commissions and accounting.</p></div>
    <form onSubmit={submit} className="login-form">
      <label>Email address<div className="input-wrap"><Mail size={17}/><input value={email} onChange={event=>setEmail(event.target.value)} type="email" autoComplete="email" required/></div></label>
      <label>Password<div className="input-wrap"><LockKeyhole size={17}/><input value={password} onChange={event=>setPassword(event.target.value)} type={show?'text':'password'} autoComplete="current-password" required minLength={8}/><button type="button" aria-label={show?'Hide password':'Show password'} onClick={()=>setShow(value=>!value)}>{show?<EyeOff size={17}/>:<Eye size={17}/>}</button></div></label>
      {message&&<p className={message.startsWith('Password reset')?'form-note':'error-note'}>{message}</p>}
      <Button type="submit" disabled={busy}>{busy?<Loader2 className="spin" size={17}/>:<ShieldCheck size={17}/>}Sign in securely</Button>
      <button type="button" className="text-button" onClick={reset} disabled={busy}>Forgot your password?</button>
    </form>
  </section><aside className="login-visual"><div><h2>Your entire trading operation, one clear view.</h2><p>From imported stock to cleared collections and payroll, every number remains connected to its source.</p><ul className="login-points"><li>Sales, stock, purchases and cash in one place</li><li>Commission that follows the money actually collected</li><li>Every entry posted to proper books automatically</li></ul></div></aside></main>;
}

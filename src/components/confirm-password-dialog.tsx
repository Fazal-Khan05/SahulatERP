'use client';
import { useState, type FormEvent, type ReactNode } from 'react';
import { Loader2, LockKeyhole } from 'lucide-react';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from './ui/dialog';

/** Asks the member to re-enter their own password before a change that hides data or settings. */
export function ConfirmPasswordDialog({ open, title, description, confirmLabel, busy, error, onCancel, onConfirm }: {
  open: boolean;
  title: string;
  description: ReactNode;
  confirmLabel: string;
  busy: boolean;
  error: string;
  onCancel: () => void;
  onConfirm: (password: string) => void;
}) {
  const [password, setPassword] = useState('');
  function submit(event: FormEvent) { event.preventDefault(); onConfirm(password); }
  return <Dialog open={open} onOpenChange={value => { if (!value) { setPassword(''); onCancel(); } }}>
    <DialogContent className="confirm-dialog">
      <DialogTitle>{title}</DialogTitle>
      <DialogDescription>{description}</DialogDescription>
      <form onSubmit={submit} className="confirm-password-form">
        <label>Your password<div className="input-wrap"><LockKeyhole size={17}/><input type="password" autoComplete="current-password" value={password} onChange={event => setPassword(event.target.value)} required autoFocus/></div></label>
        {error && <p className="error-note" role="alert">{error}</p>}
        <div className="form-actions">
          <Button type="button" variant="outline" onClick={() => { setPassword(''); onCancel(); }}>Cancel</Button>
          <Button type="submit" variant="destructive" disabled={busy || !password}>{busy ? <Loader2 className="spin" size={16}/> : null}{confirmLabel}</Button>
        </div>
      </form>
    </DialogContent>
  </Dialog>;
}

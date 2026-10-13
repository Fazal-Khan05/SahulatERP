'use client';
import { useEffect } from 'react';
import { Printer } from 'lucide-react';

/** Toolbar for /print pages; hidden when printing. Sets the tab title so the saved PDF gets a sensible name. */
export function PrintActions({ title }: { title: string }) {
  useEffect(() => { document.title = title; }, [title]);
  return <div className="print-actions">
    <span>{title}</span>
    <button type="button" className="button button-primary" onClick={() => window.print()}><Printer size={16}/>Print / Save as PDF</button>
  </div>;
}

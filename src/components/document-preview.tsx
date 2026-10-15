import { formatMoney } from '@/modules/erp/money';
import type { DocumentView } from '@/modules/erp/documents';
import type { Branding, Workspace } from '@/modules/erp/types';

export type BrandingAssets = { logoUrl?: string; letterheadUrl?: string };

/**
 * The standard printable template. Pure render, no client hooks, so it serves the live
 * preview in the browser and the server-rendered /print pages alike.
 */
export function DocumentPreview({ view, company, branding, assets, compact = false }: {
  view: DocumentView;
  company: Workspace['company'];
  branding: Branding;
  assets: BrandingAssets;
  compact?: boolean;
}) {
  const hasLines = view.lines.some(l => l.quantity);
  const body = view.lines.slice(0, -1);
  const last = view.lines.at(-1);
  // Amounts print in the document's currency unless a line or total names its own (e.g. the PKR equivalent).
  const amount = (value: string, currency = view.currency) => value.startsWith('−') ? `− ${formatMoney(value.slice(1).trim(), currency)}` : formatMoney(value, currency);
  const row = (line: DocumentView['lines'][number], index: number) => <tr key={index}>
    <td><strong>{line.description}</strong>{line.detail && <small>{line.detail}</small>}</td>
    {hasLines && <><td className="num">{line.quantity} {line.unit}</td><td className="num">{line.rate && amount(line.rate, line.currency)}</td><td className="num">{line.discount && `${line.discount}%`}</td><td className="num">{line.taxRate && `${line.taxRate}%`}</td></>}
    <td className="num">{amount(line.amount, line.currency)}</td>
  </tr>;
  // Drafts and cancelled documents must never pass for real ones: a banner on top and a watermark on every printed page.
  const unofficial = view.status === 'draft' ? { word: 'Draft', note: 'Draft — not final until it is submitted' } : view.status === 'cancelled' ? { word: 'Cancelled', note: 'Cancelled — this document is void' } : null;
  return <article className={`doc ${compact ? 'doc-compact' : ''}`} style={{ ['--doc-accent' as string]: branding.accent }}>
    {unofficial && <p className={`doc-status-banner doc-status-${view.status}`}>{unofficial.note}</p>}
    <header className="doc-header">
      {assets.letterheadUrl
        ? <img className="doc-letterhead" src={assets.letterheadUrl} alt={`${company.name} letterhead`}/>
        : <div className="doc-identity">
            {assets.logoUrl ? <img className="doc-logo" src={assets.logoUrl} alt={`${company.name} logo`}/> : <span className="doc-logo-fallback" aria-hidden="true">{company.logo}</span>}
            <div>
              <strong className="doc-company">{company.name}</strong>
              {company.address && <span>{company.address}</span>}
              <span>{[company.phone, company.email].filter(Boolean).join(' · ')}</span>
              {company.taxId && <span>NTN / STRN: {company.taxId}</span>}
            </div>
          </div>}
      <div className="doc-title">
        {compact ? <p className="doc-title-text">{view.title}</p> : <h1>{view.title}</h1>}
        <table className="doc-title-meta"><tbody>
          <tr><th>Number</th><td>{view.number}</td></tr>
          <tr><th>Date</th><td>{view.date}</td></tr>
          {view.dueDate && <tr><th>Due</th><td>{view.dueDate}</td></tr>}
        </tbody></table>
      </div>
    </header>

    <section className="doc-parties">
      <div>
        <span className="doc-label">{view.partyLabel}</span>
        <strong>{view.party.name}</strong>
        {view.party.address && <span>{view.party.address}</span>}
        {view.party.email && <span>{view.party.email}</span>}
        {view.party.taxId && <span>NTN / STRN: {view.party.taxId}</span>}
        {view.party.taxStatus && <span>{view.party.taxStatus}</span>}
      </div>
      {view.meta.length > 0 && <dl className="doc-meta">{view.meta.map(item => <div key={item.label}><dt>{item.label}</dt><dd>{item.value}</dd></div>)}</dl>}
    </section>

    <table className="doc-lines">
      <thead><tr>
        <th>Description</th>
        {hasLines && <><th className="num">Qty</th><th className="num">Rate</th><th className="num">Disc.</th><th className="num">Tax</th></>}
        <th className="num">Amount</th>
      </tr></thead>
      {body.length > 0 && <tbody>{body.map(row)}</tbody>}
      {/* The last line, the totals and the footer print as one unbreakable group, so the totals always land on a page with lines. */}
      <tbody className="doc-tail">
        {last && row(last, view.lines.length - 1)}
        <tr><td className="doc-tail-cell" colSpan={hasLines ? 6 : 2}>
          <section className="doc-bottom">
            <div className="doc-notes">{view.notes && <><span className="doc-label">Notes</span><p>{view.notes}</p></>}</div>
            <table className="doc-totals"><tbody>{view.totals.map(total => <tr key={total.label} className={`${total.emphasis ? 'emphasis' : ''} ${total.credit ? 'credit' : ''}`}><th>{total.label}</th><td>{amount(total.value, total.currency)}</td></tr>)}</tbody></table>
          </section>
          <footer className="doc-footer">
            {branding.footer && <p>{branding.footer}</p>}
            <small>Computer-generated document · {company.name} · amounts in {view.currency}</small>
          </footer>
        </td></tr>
      </tbody>
    </table>
    {unofficial && <div className={`doc-watermark doc-status-${view.status}`} data-mark={unofficial.word} aria-hidden="true"/>}
  </article>;
}

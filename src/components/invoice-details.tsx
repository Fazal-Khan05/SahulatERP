'use client';

import { Dialog, DialogContent, DialogDescription, DialogTitle } from './ui/dialog';
import { outstanding } from '@/modules/erp/engine';
import { D, formatMoney } from '@/modules/erp/money';
import type { Workspace } from '@/modules/erp/types';

const label = (value: string) => value.replaceAll('_', ' ');

export function InvoiceDetails({ workspace, invoiceId, onClose }: {
  workspace: Workspace;
  invoiceId: string | null;
  onClose: () => void;
}) {
  const invoice = workspace.documents.find(document => document.id === invoiceId && document.kind === 'sales_invoice');
  const customer = workspace.parties.find(party => party.id === invoice?.partyId);
  const warehouse = workspace.warehouses.find(location => location.id === invoice?.warehouseId);
  const branch = workspace.branches.find(location => location.id === warehouse?.branchId);
  const source = workspace.documents.find(document => document.id === invoice?.parentId);
  const receipts = workspace.receipts.filter(receipt => receipt.allocations.some(allocation => allocation.invoiceId === invoiceId));
  const credits = workspace.documents.filter(document => document.kind === 'credit_note' && document.parentId === invoiceId);

  return <Dialog open={!!invoice} onOpenChange={open => { if (!open) onClose(); }}>
    <DialogContent className="invoice-dialog">
      {invoice && <>
        <div className="invoice-heading">
          <div>
            <span className="invoice-eyebrow">SALES INVOICE</span>
            <DialogTitle>Invoice {invoice.number}</DialogTitle>
            <DialogDescription>Issued {invoice.date} · Due {invoice.dueDate}</DialogDescription>
          </div>
          <span className={`badge ${invoice.status === 'submitted' ? 'success' : 'warning'}`}>{label(invoice.status)}</span>
        </div>

        <div className="invoice-parties">
          <section>
            <span className="invoice-section-label">FROM</span>
            <strong>{workspace.company.name}</strong>
            <span>{workspace.company.address}</span>
            {workspace.company.taxId && <span>Tax ID: {workspace.company.taxId}</span>}
          </section>
          <section>
            <span className="invoice-section-label">BILL TO</span>
            <strong>{customer?.name || 'Unknown customer'}</strong>
            {customer?.city && <span>{customer.city}</span>}
            {customer?.email && <span>{customer.email}</span>}
            {customer?.taxId && <span>Tax ID: {customer.taxId}</span>}
          </section>
        </div>

        <div className="invoice-meta">
          <span><strong>Warehouse</strong>{warehouse?.name || '—'}</span>
          <span><strong>Branch</strong>{branch?.name || '—'}</span>
          <span><strong>Currency</strong>{invoice.currency}</span>
          {customer && <span><strong>Payment terms</strong>{customer.terms} days</span>}
          {source && <span><strong>Source</strong>{source.number}</span>}
        </div>

        <section className="invoice-section">
          <h3>Items</h3>
          <div className="table-scroll">
            <table className="invoice-lines">
              <thead><tr><th>Product</th><th>Quantity</th><th>Unit price</th><th>Discount</th><th>Tax</th><th className="align-right">Line total</th></tr></thead>
              <tbody>{invoice.lines.map(line => {
                const item = workspace.items.find(product => product.id === line.itemId);
                const net = D(line.quantity).mul(line.price).mul(D(100).minus(line.discount)).div(100);
                const tax = net.mul(line.taxRate).div(100);
                const salesperson = workspace.employees.find(employee => employee.id === line.employeeId)?.name;
                const splitNames = line.splits.map(split => workspace.employees.find(employee => employee.id === split.employeeId)?.name || split.employeeId).join(', ');
                return <tr key={line.id}>
                  <td><strong>{item?.name || 'Unknown product'}</strong><small>{item?.sku || line.itemId}{salesperson ? ` · ${salesperson}` : ''}{splitNames ? ` · Split: ${splitNames}` : ''}{D(line.returned).gt(0) ? ` · ${D(line.returned).toString()} returned` : ''}</small></td>
                  <td>{D(line.quantity).toString()} {item?.unit || ''}</td>
                  <td>{formatMoney(line.price)}</td>
                  <td>{D(line.discount).toString()}%</td>
                  <td>{D(line.taxRate).toString()}% · {formatMoney(tax.toString())}</td>
                  <td className="align-right amount">{formatMoney(net.plus(tax).toString())}</td>
                </tr>;
              })}</tbody>
            </table>
          </div>
        </section>

        <div className="invoice-bottom">
          <div className="invoice-related">
            {invoice.notes && <section><h3>Notes</h3><p>{invoice.notes}</p></section>}
            <section>
              <h3>Receipts</h3>
              {receipts.length ? receipts.map(receipt => <div className="invoice-related-row" key={receipt.id}>
                <span><strong>{receipt.number}</strong><small>{receipt.date} · {label(receipt.method)}{receipt.chequeNo ? ` · ${receipt.chequeNo}` : ''} · {label(receipt.status)}</small></span>
                <strong>{formatMoney(receipt.allocations.find(allocation => allocation.invoiceId === invoiceId)?.amount || '0')}</strong>
              </div>) : <p>No receipts recorded.</p>}
            </section>
            {credits.length > 0 && <section>
              <h3>Credit notes</h3>
              {credits.map(credit => <div className="invoice-related-row" key={credit.id}>
                <span><strong>{credit.number}</strong><small>{credit.date} · {label(credit.status)}</small></span>
                <strong>{formatMoney(credit.total)}</strong>
              </div>)}
            </section>}
          </div>
          <div className="invoice-totals">
            <div><span>Subtotal</span><strong>{formatMoney(invoice.net)}</strong></div>
            <div><span>Tax</span><strong>{formatMoney(invoice.tax)}</strong></div>
            <div className="invoice-total"><span>Invoice total</span><strong>{formatMoney(invoice.total)}</strong></div>
            <div><span>Cleared payments</span><strong>− {formatMoney(invoice.paid)}</strong></div>
            <div><span>Returns / credits</span><strong>− {formatMoney(invoice.returned)}</strong></div>
            <div className="invoice-balance"><span>Balance due</span><strong>{formatMoney(outstanding(invoice))}</strong></div>
          </div>
        </div>
      </>}
    </DialogContent>
  </Dialog>;
}

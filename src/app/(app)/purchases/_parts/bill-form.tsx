"use client";

import Decimal from "decimal.js";
import { useRef, useState } from "react";
import { useFormAction, type FormAction } from "@/components/action-form";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatAmount } from "@/lib/money";

type Choice = { id: string; label: string };
type Line = { code: string; label: string };
type GoodsRow = { receiptLineId: string; receiptNumber: string; itemCode: string; description: string; unitCode: string; left: string; quantity: string; price: string; taxCategoryId: string };
type ExpenseRow = { key: number; accountId: string; description: string; amount: string; taxCategoryId: string };

export type BillFormProps = {
  action: FormAction;
  /** What has been received from the supplier into the branch and is not yet billed, with what is already on this draft. */
  goods: GoodsRow[];
  expenses: Omit<ExpenseRow, "key">[];
  accounts: Choice[];
  /** Empty when no input tax can be claimed on this bill: the column is then left out. */
  taxCategories: Choice[];
  /** Null when the company does not withhold tax. */
  withholding: { income: Line[]; sales: Line[]; provincial: Line[] } | null;
  initial: { date: string; supplierInvoiceNo: string; dueDate: string; note: string; incomeTaxCode: string; salesTaxCode: string; provincialTaxCode: string };
  /** Shown once, when a new bill was saved as a draft but could not be posted. */
  refused?: string;
};

const SELECT = "h-8 w-full min-w-0 rounded-lg border border-input bg-card px-2 text-sm";
const EMPTY = { accountId: "", description: "", amount: "", taxCategoryId: "" };
const PLAIN = /^\d+(\.\d+)?$/;
const amountOf = (quantity: string, price: string) => (PLAIN.test(quantity.trim()) && PLAIN.test(price.trim()) ? new Decimal(quantity.trim()).times(price.trim()).toDecimalPlaces(2, Decimal.ROUND_HALF_UP) : null);

function TaxSelect({ name, label, value, onChange, categories }: { name: string; label: string; value: string; onChange: (value: string) => void; categories: Choice[] }) {
  return (
    <select name={name} aria-label={label} value={value} onChange={(event) => onChange(event.target.value)} className={SELECT}>
      <option value="">No sales tax</option>
      {categories.map((category) => (
        <option key={category.id} value={category.id}>
          {category.label}
        </option>
      ))}
    </select>
  );
}

function LineSelect({ id, label, lines, defaultValue, none }: { id: string; label: string; lines: Line[]; defaultValue: string; none: string }) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <select id={id} name={id} defaultValue={defaultValue} className={SELECT}>
        <option value="">{none}</option>
        {lines.map((line) => (
          <option key={line.code} value={line.code}>
            {line.label}
          </option>
        ))}
      </select>
    </div>
  );
}

/**
 * The form of a supplier's bill: the supplier's invoice number and date, how much of the goods
 * received is billed and at what price, any services or expenses, and, for a company that
 * withholds tax, the lines of the withholding tables that apply. No rate is typed: the taxes
 * are worked out from the tax tables when the draft is saved. The server reads and checks
 * everything again.
 */
export function BillForm({ action, goods, expenses, accounts, taxCategories, withholding, initial, refused }: BillFormProps) {
  const { state, ready, busy, run } = useFormAction(action);
  const nextKey = useRef(expenses.length + 1);
  const [rows, setRows] = useState<GoodsRow[]>(goods);
  const [costs, setCosts] = useState<ExpenseRow[]>(() => (expenses.length > 0 ? expenses.map((line, index) => ({ key: index, ...line })) : [{ key: 0, ...EMPTY }]));
  const setRow = (id: string, change: Partial<GoodsRow>) => setRows((all) => all.map((row) => (row.receiptLineId === id ? { ...row, ...change } : row)));
  const setCost = (key: number, change: Partial<ExpenseRow>) => setCosts((all) => all.map((row) => (row.key === key ? { ...row, ...change } : row)));
  const taxed = taxCategories.length > 0;
  const error = state.error ?? refused;
  const subtotal = rows.reduce((sum, row) => sum.plus(row.quantity.trim() === "" ? 0 : (amountOf(row.quantity, row.price) ?? 0)), new Decimal(0)).plus(costs.reduce((sum, row) => sum.plus(PLAIN.test(row.amount.trim()) ? row.amount.trim() : 0), new Decimal(0)));

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        const submitter = (event.nativeEvent as SubmitEvent).submitter;
        data.set("intent", submitter instanceof HTMLButtonElement && submitter.value === "post" ? "post" : "save");
        run(data);
      }}
      className="flex flex-col gap-5"
    >
      <div className="grid gap-4 sm:grid-cols-[10rem_1fr_10rem_1fr]">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="date">Date on the invoice</Label>
          <Input id="date" name="date" type="date" defaultValue={initial.date} required />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="supplierInvoiceNo">Supplier&apos;s invoice number</Label>
          <Input id="supplierInvoiceNo" name="supplierInvoiceNo" defaultValue={initial.supplierInvoiceNo} maxLength={60} autoComplete="off" required />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="dueDate">Due on</Label>
          <Input id="dueDate" name="dueDate" type="date" defaultValue={initial.dueDate} />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="note">Note</Label>
          <Input id="note" name="note" defaultValue={initial.note} maxLength={500} autoComplete="off" />
        </div>
      </div>

      <section className="flex flex-col gap-2">
        <h3 className="text-sm font-semibold">Goods received, not yet billed</h3>
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing received from this supplier into this branch is waiting for a bill.</p>
        ) : (
          <div className="overflow-x-auto">
            <table aria-label="Goods to bill" className="w-full min-w-[820px] text-left text-sm">
              <thead className="border-b text-muted-foreground">
                <tr>
                  <th className="py-2 pr-4 font-medium">Received on</th>
                  <th className="py-2 pr-4 font-medium">Item</th>
                  <th className="py-2 pr-2 text-right font-medium">Not yet billed</th>
                  <th className="w-28 py-2 pr-2 text-right font-medium">Billed now</th>
                  <th className="py-2 pr-2 font-medium">Unit</th>
                  <th className="w-32 py-2 pr-2 text-right font-medium">Price of one</th>
                  {taxed ? <th className="w-44 py-2 pr-2 font-medium">Sales tax</th> : null}
                  <th className="w-32 py-2 text-right font-medium">Amount</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {rows.map((row, index) => {
                  const amount = row.quantity.trim() === "" ? null : amountOf(row.quantity, row.price);
                  return (
                    <tr key={row.receiptLineId}>
                      <td className="py-1 pr-4 whitespace-nowrap">{row.receiptNumber}</td>
                      <td className="py-1 pr-4">
                        <span className="font-medium">{row.itemCode}</span> {row.description}
                      </td>
                      <td className="py-1 pr-2 text-right tabular-nums" data-testid={`to-bill-${index + 1}`}>
                        {row.left}
                      </td>
                      <td className="py-1 pr-2">
                        <input type="hidden" name="receiptLineId" value={row.receiptLineId} />
                        <Input name="goodsQuantity" aria-label={`Billed now, line ${index + 1}`} value={row.quantity} onChange={(event) => setRow(row.receiptLineId, { quantity: event.target.value })} inputMode="decimal" autoComplete="off" className="text-right tabular-nums" />
                      </td>
                      <td className="py-1 pr-2 text-muted-foreground">{row.unitCode}</td>
                      <td className="py-1 pr-2">
                        <Input name="goodsPrice" aria-label={`Price of one, line ${index + 1}`} value={row.price} onChange={(event) => setRow(row.receiptLineId, { price: event.target.value })} inputMode="decimal" autoComplete="off" className="text-right tabular-nums" />
                      </td>
                      {taxed ? (
                        <td className="py-1 pr-2">
                          <TaxSelect name="goodsTax" label={`Sales tax, line ${index + 1}`} value={row.taxCategoryId} onChange={(value) => setRow(row.receiptLineId, { taxCategoryId: value })} categories={taxCategories} />
                        </td>
                      ) : (
                        <td className="hidden">
                          <input type="hidden" name="goodsTax" value="" />
                        </td>
                      )}
                      <td className="py-1 text-right tabular-nums" data-testid={`goods-amount-${index + 1}`}>
                        {amount ? formatAmount(amount) : ""}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {rows.length > 0 ? (
          <div>
            <Button type="button" variant="outline" size="sm" onClick={() => setRows((all) => all.map((row) => ({ ...row, quantity: row.left })))}>
              Bill all of it
            </Button>
          </div>
        ) : null}
      </section>

      <section className="flex flex-col gap-2">
        <h3 className="text-sm font-semibold">Services and expenses</h3>
        <div className="overflow-x-auto">
          <table aria-label="Services and expenses" className="w-full min-w-[720px] text-left text-sm">
            <thead className="border-b text-muted-foreground">
              <tr>
                <th className="w-64 py-2 pr-2 font-medium">Charged to</th>
                <th className="py-2 pr-2 font-medium">What it is for</th>
                {taxed ? <th className="w-44 py-2 pr-2 font-medium">Sales tax</th> : null}
                <th className="w-32 py-2 pr-2 text-right font-medium">Amount</th>
                <th className="w-8 py-2" />
              </tr>
            </thead>
            <tbody>
              {costs.map((row, index) => (
                <tr key={row.key}>
                  <td className="py-1 pr-2">
                    <select name="accountId" aria-label={`Charged to, line ${index + 1}`} value={row.accountId} onChange={(event) => setCost(row.key, { accountId: event.target.value })} className={SELECT}>
                      <option value="">Choose an account</option>
                      {accounts.map((account) => (
                        <option key={account.id} value={account.id}>
                          {account.label}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="py-1 pr-2">
                    <Input name="expenseDescription" aria-label={`What it is for, line ${index + 1}`} value={row.description} onChange={(event) => setCost(row.key, { description: event.target.value })} maxLength={300} autoComplete="off" />
                  </td>
                  {taxed ? (
                    <td className="py-1 pr-2">
                      <TaxSelect name="expenseTax" label={`Sales tax on expense, line ${index + 1}`} value={row.taxCategoryId} onChange={(value) => setCost(row.key, { taxCategoryId: value })} categories={taxCategories} />
                    </td>
                  ) : (
                    <td className="hidden">
                      <input type="hidden" name="expenseTax" value="" />
                    </td>
                  )}
                  <td className="py-1 pr-2">
                    <Input name="expenseAmount" aria-label={`Amount, line ${index + 1}`} value={row.amount} onChange={(event) => setCost(row.key, { amount: event.target.value })} inputMode="decimal" autoComplete="off" className="text-right tabular-nums" />
                  </td>
                  <td className="py-1 text-right">
                    {costs.length > 1 ? (
                      <Button type="button" variant="ghost" size="icon-sm" aria-label={`Remove expense line ${index + 1}`} onClick={() => setCosts((all) => all.filter((other) => other.key !== row.key))}>
                        ×
                      </Button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div>
          <Button type="button" variant="outline" size="sm" onClick={() => setCosts((all) => [...all, { key: (nextKey.current += 1), ...EMPTY }])}>
            Add an expense line
          </Button>
        </div>
      </section>

      <p className="text-sm">
        Lines before tax: <span className="font-semibold tabular-nums" data-testid="bill-subtotal">{formatAmount(subtotal)}</span>
        <span className="text-muted-foreground"> Tax and what is withheld are worked out from the tax tables when the draft is saved.</span>
      </p>

      {withholding ? (
        <section className="flex flex-col gap-2">
          <h3 className="text-sm font-semibold">Tax withheld from the supplier</h3>
          <div className="grid gap-4 sm:grid-cols-3">
            <LineSelect id="incomeTaxCode" label="Income tax (section 153)" lines={withholding.income} defaultValue={initial.incomeTaxCode} none="Nothing withheld" />
            <LineSelect id="salesTaxCode" label="Sales tax (Eleventh Schedule)" lines={withholding.sales} defaultValue={initial.salesTaxCode} none="Nothing withheld" />
            <LineSelect id="provincialTaxCode" label="Provincial sales tax on services" lines={withholding.provincial} defaultValue={initial.provincialTaxCode} none="None on this bill" />
          </div>
          <p className="text-sm text-muted-foreground">
            The rates come from the tax tables for the bill&apos;s date, and depend on whether the supplier is on the Active Taxpayers List as recorded on the supplier. The listed sectors at the lower services rate are: transport, freight forwarding, air cargo, courier,
            manpower outsourcing, hotel, security guard, software development, tracking, advertising other than in print or electronic media, share registrar, engineering including architectural, warehousing, non-banking finance companies, data services under a PTA
            licence, telecommunication towers, car rental, building maintenance, the stock and mercantile exchanges, inspection, certification, testing and training, oilfield, telecommunication, collateral management, travel and tour, REIT management and the National
            Clearing Company. The law sets no deduction where a supplier is paid less than Rs 75,000 for goods or Rs 30,000 for services in a year: choose &quot;Nothing withheld&quot; for such a bill.
          </p>
        </section>
      ) : null}

      {error ? (
        <p role="alert" data-testid="form-error" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {/* Saving comes first in the page, so pressing Enter in a field saves the draft and never posts. */}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" name="intent" value="save" variant="outline" disabled={!ready || busy} className="order-2">
          Save as draft
        </Button>
        <Button type="submit" name="intent" value="post" disabled={!ready || busy} className="order-1">
          {busy ? "Working…" : "Post bill"}
        </Button>
      </div>
    </form>
  );
}

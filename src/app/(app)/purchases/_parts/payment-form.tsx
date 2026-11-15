"use client";

import Decimal from "decimal.js";
import { useState } from "react";
import { useFormAction, type FormAction } from "@/components/action-form";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatAmount } from "@/lib/money";

type Choice = { id: string; label: string };
type BillRow = { billId: string; number: string; supplierInvoiceNo: string; date: string; owed: string; amount: string };

const SELECT = "h-8 w-full min-w-0 rounded-lg border border-input bg-card px-2 text-sm";
const PLAIN = /^\d+(\.\d+)?$/;
const money = (typed: string) => (PLAIN.test(typed.trim()) ? new Decimal(typed.trim()) : new Decimal(0));

/** The supplier's unpaid bills, each with a box for how much of the money is set against it. */
function BillsTable({ bills, onChange }: { bills: BillRow[]; onChange: (billId: string, amount: string) => void }) {
  return (
    <div className="overflow-x-auto">
      <table aria-label="Bills to pay" className="w-full min-w-[640px] text-left text-sm">
        <thead className="border-b text-muted-foreground">
          <tr>
            <th className="py-2 pr-4 font-medium">Bill</th>
            <th className="py-2 pr-4 font-medium">Their invoice</th>
            <th className="py-2 pr-4 font-medium">Date</th>
            <th className="py-2 pr-4 text-right font-medium">Still owed</th>
            <th className="w-36 py-2 text-right font-medium">Paid now</th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {bills.map((bill, index) => (
            <tr key={bill.billId}>
              <td className="py-1 pr-4 font-medium whitespace-nowrap">{bill.number}</td>
              <td className="py-1 pr-4">{bill.supplierInvoiceNo}</td>
              <td className="py-1 pr-4 whitespace-nowrap">{bill.date}</td>
              <td className="py-1 pr-4 text-right tabular-nums" data-testid={`owed-${index + 1}`}>
                {formatAmount(new Decimal(bill.owed))}
              </td>
              <td className="py-1">
                <input type="hidden" name="billId" value={bill.billId} />
                <Input name="billAmount" aria-label={`Paid now, bill ${index + 1}`} value={bill.amount} onChange={(event) => onChange(bill.billId, event.target.value)} inputMode="decimal" autoComplete="off" className="text-right tabular-nums" />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export type PaymentFormProps = {
  action: FormAction;
  accounts: Choice[];
  /** The company's other currencies, for a payment made abroad; empty when it has none. */
  currencies: string[];
  bills: BillRow[];
  initial: { date: string; accountId: string; reference: string; note: string; amount: string; foreignCurrency: string; foreignAmount: string };
  /** Shown once, when a new payment was saved as a draft but could not be posted. */
  refused?: string;
};

/**
 * The form of a payment to a supplier: the day, the cash or bank account, the rupees paid, and
 * how much of that settles each unpaid bill. Whatever is not set against a bill is an advance.
 * The server reads and checks everything again.
 */
export function PaymentForm({ action, accounts, currencies, bills, initial, refused }: PaymentFormProps) {
  const { state, ready, busy, run } = useFormAction(action);
  const [rows, setRows] = useState<BillRow[]>(bills);
  const [amount, setAmount] = useState(initial.amount);
  const settled = rows.reduce((sum, row) => sum.plus(money(row.amount)), new Decimal(0));
  const left = money(amount).minus(settled);
  const error = state.error ?? refused;

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
      <div className="grid gap-4 sm:grid-cols-[10rem_1fr_12rem]">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="date">Paid on</Label>
          <Input id="date" name="date" type="date" defaultValue={initial.date} required />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="accountId">Paid from</Label>
          <select id="accountId" name="accountId" defaultValue={initial.accountId} required className={SELECT}>
            <option value="">Choose a cash or bank account</option>
            {accounts.map((account) => (
              <option key={account.id} value={account.id}>
                {account.label}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="amount">Amount paid (rupees)</Label>
          <Input id="amount" name="amount" value={amount} onChange={(event) => setAmount(event.target.value)} inputMode="decimal" autoComplete="off" required className="text-right tabular-nums" />
        </div>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="reference">Cheque number or bank reference</Label>
          <Input id="reference" name="reference" defaultValue={initial.reference} maxLength={60} autoComplete="off" />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="note">Note</Label>
          <Input id="note" name="note" defaultValue={initial.note} maxLength={500} autoComplete="off" />
        </div>
      </div>
      {currencies.length > 0 ? (
        <div className="grid gap-4 sm:grid-cols-[12rem_12rem_1fr]">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="foreignCurrency">Paid abroad in</Label>
            <select id="foreignCurrency" name="foreignCurrency" defaultValue={initial.foreignCurrency} className={SELECT}>
              <option value="">Rupees only</option>
              {currencies.map((code) => (
                <option key={code} value={code}>
                  {code}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="foreignAmount">Amount in that currency</Label>
            <Input id="foreignAmount" name="foreignAmount" defaultValue={initial.foreignAmount} inputMode="decimal" autoComplete="off" className="text-right tabular-nums" />
          </div>
          <p className="self-end text-sm text-muted-foreground">For the record only. The books hold the rupees that left the account, and an advance is never revalued.</p>
        </div>
      ) : null}

      <section className="flex flex-col gap-2">
        <h3 className="text-sm font-semibold">Bills this payment settles</h3>
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">This supplier has no unpaid bill in this branch. The whole payment will be an advance.</p>
        ) : (
          <>
            <BillsTable bills={rows} onChange={(billId, value) => setRows((all) => all.map((row) => (row.billId === billId ? { ...row, amount: value } : row)))} />
            <div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => {
                  setRows((all) => all.map((row) => ({ ...row, amount: new Decimal(row.owed).toFixed(2) })));
                  setAmount(rows.reduce((sum, row) => sum.plus(row.owed), new Decimal(0)).toFixed(2));
                }}
              >
                Pay all that is owed
              </Button>
            </div>
          </>
        )}
        <p className="text-sm">
          Set against bills: <span className="font-semibold tabular-nums" data-testid="payment-settled">{formatAmount(settled)}</span>.{" "}
          {left.gt(0) ? (
            <>
              Left over as an advance: <span className="font-semibold tabular-nums" data-testid="payment-advance">{formatAmount(left)}</span>.
            </>
          ) : left.lt(0) ? (
            <span className="text-destructive">That is more than the amount paid.</span>
          ) : null}
        </p>
      </section>

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
          {busy ? "Working…" : "Post payment"}
        </Button>
      </div>
    </form>
  );
}

export type AdvanceFormProps = { action: FormAction; bills: BillRow[]; left: string; today: string };

/** Sets what is left of a posted payment against the supplier's unpaid bills, on a day. */
export function AdvanceForm({ action, bills, left, today }: AdvanceFormProps) {
  const { state, ready, busy, run } = useFormAction(action);
  const [rows, setRows] = useState<BillRow[]>(bills);
  const settled = rows.reduce((sum, row) => sum.plus(money(row.amount)), new Decimal(0));
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        run(new FormData(event.currentTarget));
      }}
      className="flex flex-col gap-4"
    >
      <div className="flex max-w-[10rem] flex-col gap-1.5">
        <Label htmlFor="advance-date">Set against the bills on</Label>
        <Input id="advance-date" name="date" type="date" defaultValue={today} required />
      </div>
      <BillsTable bills={rows} onChange={(billId, value) => setRows((all) => all.map((row) => (row.billId === billId ? { ...row, amount: value } : row)))} />
      <p className="text-sm">
        Set against bills: <span className="font-semibold tabular-nums">{formatAmount(settled)}</span> of the <span className="tabular-nums">{formatAmount(new Decimal(left))}</span> that is left.
      </p>
      {state.error ? (
        <p role="alert" data-testid="advance-error" className="text-sm text-destructive">
          {state.error}
        </p>
      ) : null}
      <Button type="submit" disabled={!ready || busy} className="self-start">
        {busy ? "Working…" : "Set the advance against these bills"}
      </Button>
    </form>
  );
}

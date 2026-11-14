"use client";

import Decimal from "decimal.js";
import { useState } from "react";
import { useFormAction, type FormAction } from "@/components/action-form";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatAmount } from "@/lib/money";

export type OpenRow = { kind: "invoice" | "opening"; id: string; number: string; date: string; dueDate: string; overdue: boolean; outstanding: string };

export type ReceiptFormProps = {
  action: FormAction;
  accounts: { id: string; label: string; kind: "cash" | "bank" }[];
  branches: { id: string; name: string }[];
  /** A member limited to some branches must choose one of them. */
  mustChooseBranch: boolean;
  /** What the customer still has to pay, the invoice that fell due first before the next. */
  open: OpenRow[];
  initial: {
    date: string;
    method: string;
    accountId: string;
    amount: string;
    bankCharges: string;
    reference: string;
    note: string;
    branchId: string;
    chequeNumber: string;
    chequeBank: string;
    chequeDate: string;
    /** What the draft already sets against each invoice, by "kind:id". */
    paying: Record<string, string>;
  };
  /** Shown once, when a new receipt was saved as a draft but could not be posted. */
  refused?: string;
};

const SELECT = "h-8 w-full min-w-0 rounded-lg border border-input bg-card px-2 text-sm";

/** A typed amount as a Decimal for the running totals; anything not yet a number counts as nothing. */
function amount(text: string): Decimal {
  return /^\d+(\.\d{1,4})?$/.test(text.trim()) ? new Decimal(text.trim()) : new Decimal(0);
}
const plain = (value: Decimal) => value.toFixed(4).replace(/\.?0+$/, "");

/**
 * The receipt form: when, how and how much, and which of the customer's unpaid invoices it
 * pays. What is not set against an invoice is kept as the customer's advance. The totals are a
 * guide only: the server reads and checks everything again.
 */
export function ReceiptForm({ action, accounts, branches, mustChooseBranch, open, initial, refused }: ReceiptFormProps) {
  const { state, ready, busy, run } = useFormAction(action);
  const [method, setMethod] = useState(initial.method);
  const [received, setReceived] = useState(initial.amount);
  const [paying, setPaying] = useState<Record<string, string>>(() => Object.fromEntries(open.map((row) => [`${row.kind}:${row.id}`, initial.paying[`${row.kind}:${row.id}`] ?? ""])));
  const offered = accounts.filter((account) => account.kind === (method === "cash" ? "cash" : "bank"));
  const total = amount(received);
  const set = open.reduce((sum, row) => sum.plus(amount(paying[`${row.kind}:${row.id}`] ?? "")), new Decimal(0));
  const left = total.minus(set);
  const error = state.error ?? (state.message ? undefined : refused);

  /** The oldest invoice first, until the amount received runs out. */
  const spread = () => {
    let remaining = total;
    const next: Record<string, string> = {};
    for (const row of open) {
      const pay = Decimal.min(remaining, new Decimal(row.outstanding));
      next[`${row.kind}:${row.id}`] = pay.gt(0) ? plain(pay) : "";
      remaining = remaining.minus(pay);
    }
    setPaying(next);
  };

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        const submitter = (event.nativeEvent as SubmitEvent).submitter;
        data.set("intent", submitter instanceof HTMLButtonElement && submitter.value === "post" ? "post" : "save");
        run(data);
      }}
      className="flex flex-col gap-4"
    >
      <div className="grid gap-4 sm:grid-cols-[10rem_1fr_10rem]">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="date">Date received</Label>
          <Input id="date" name="date" type="date" defaultValue={initial.date} required />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="method">How it came</Label>
          <select id="method" name="method" value={method} onChange={(event) => setMethod(event.target.value)} required className={SELECT}>
            <option value="cash">Cash</option>
            <option value="bank">Bank transfer or deposit</option>
            <option value="cheque">Cheque</option>
          </select>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="amount">Amount received</Label>
          <Input id="amount" name="amount" value={received} onChange={(event) => setReceived(event.target.value)} inputMode="decimal" autoComplete="off" required className="text-right tabular-nums" />
        </div>
      </div>

      {method === "cheque" ? (
        <div className="grid gap-4 sm:grid-cols-[1fr_1fr_10rem]">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="chequeNumber">Cheque number</Label>
            <Input id="chequeNumber" name="chequeNumber" defaultValue={initial.chequeNumber} maxLength={40} autoComplete="off" required />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="chequeBank">Bank it is drawn on</Label>
            <Input id="chequeBank" name="chequeBank" defaultValue={initial.chequeBank} maxLength={80} autoComplete="off" required />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="chequeDate">Date on the cheque</Label>
            <Input id="chequeDate" name="chequeDate" type="date" defaultValue={initial.chequeDate} required />
          </div>
          <p className="text-sm text-muted-foreground sm:col-span-3">
            The invoices are paid from today and the cheque is held in Cheques in hand. You say which bank account it goes into when you deposit it. If it bounces, the invoices are unpaid again.
          </p>
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-[1fr_10rem]">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="accountId">{method === "cash" ? "Cash account it went into" : "Bank account it went into"}</Label>
            {/* Keyed by the method, so the choice does not carry from a cash account to a bank account. */}
            <select key={method} id="accountId" name="accountId" defaultValue={offered.some((account) => account.id === initial.accountId) ? initial.accountId : offered.length === 1 ? offered[0].id : ""} required className={SELECT}>
              <option value="">Choose an account</option>
              {offered.map((account) => (
                <option key={account.id} value={account.id}>
                  {account.label}
                </option>
              ))}
            </select>
            {offered.length === 0 ? (
              <p className="text-xs text-destructive">{method === "cash" ? "There is no cash account." : "There is no bank account yet. An owner or an accountant adds one under Chart of accounts, Bank accounts."}</p>
            ) : null}
          </div>
          {method === "bank" ? (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="bankCharges">Kept by the bank</Label>
              <Input id="bankCharges" name="bankCharges" defaultValue={initial.bankCharges} inputMode="decimal" autoComplete="off" className="text-right tabular-nums" />
            </div>
          ) : null}
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="reference">Reference</Label>
          <Input id="reference" name="reference" defaultValue={initial.reference} maxLength={60} autoComplete="off" placeholder="Slip or transfer number" />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="note">Note</Label>
          <Input id="note" name="note" defaultValue={initial.note} maxLength={500} autoComplete="off" />
        </div>
      </div>
      {branches.length > 0 ? (
        <div className="flex max-w-xs flex-col gap-1.5">
          <Label htmlFor="branchId">Branch</Label>
          <select id="branchId" name="branchId" defaultValue={initial.branchId} required={mustChooseBranch} className={SELECT}>
            {mustChooseBranch ? <option value="">Choose a branch</option> : <option value="">Whole company</option>}
            {branches.map((branch) => (
              <option key={branch.id} value={branch.id}>
                {branch.name}
              </option>
            ))}
          </select>
        </div>
      ) : null}

      <div>
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-semibold">What it pays</h3>
          {open.length > 0 ? (
            <Button type="button" variant="outline" size="sm" onClick={spread}>
              Oldest invoices first
            </Button>
          ) : null}
        </div>
        {open.length === 0 ? (
          <p className="text-sm text-muted-foreground">This customer has no unpaid invoices. The whole amount is kept as their advance.</p>
        ) : (
          <div className="overflow-x-auto">
            <table aria-label="Unpaid invoices" className="w-full min-w-[560px] text-left text-sm">
              <thead className="border-b text-muted-foreground">
                <tr>
                  <th className="py-2 pr-4 font-medium">Invoice</th>
                  <th className="py-2 pr-4 font-medium">Date</th>
                  <th className="py-2 pr-4 font-medium">Due</th>
                  <th className="py-2 pr-4 text-right font-medium">Still to pay</th>
                  <th className="w-36 py-2 text-right font-medium">Pay now</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {open.map((row) => {
                  const key = `${row.kind}:${row.id}`;
                  return (
                    <tr key={key}>
                      <td className="py-1 pr-4 font-medium whitespace-nowrap">
                        {row.number}
                        <input type="hidden" name="allocKind" value={row.kind} />
                        <input type="hidden" name="allocId" value={row.id} />
                        <input type="hidden" name="allocLabel" value={row.number} />
                      </td>
                      <td className="py-1 pr-4 whitespace-nowrap">{row.date}</td>
                      <td className={`py-1 pr-4 whitespace-nowrap ${row.overdue ? "text-destructive" : ""}`}>{row.dueDate}</td>
                      <td className="py-1 pr-4 text-right tabular-nums">{formatAmount(new Decimal(row.outstanding))}</td>
                      <td className="py-1">
                        <Input
                          name="allocAmount"
                          aria-label={`Pay now, ${row.number}`}
                          value={paying[key] ?? ""}
                          onChange={(event) => setPaying((all) => ({ ...all, [key]: event.target.value }))}
                          inputMode="decimal"
                          autoComplete="off"
                          className="text-right tabular-nums"
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <p className="mt-2 text-sm" data-testid="receipt-split">
          Against invoices: <span className="font-semibold tabular-nums">{formatAmount(set)}</span>.{" "}
          {left.isNegative() ? (
            <span className="text-destructive">That is {formatAmount(left.abs())} more than the amount received.</span>
          ) : (
            <>
              Kept as the customer&apos;s advance: <span className="font-semibold tabular-nums">{formatAmount(left)}</span>.
            </>
          )}
        </p>
      </div>

      {error ? (
        <p role="alert" data-testid="form-error" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {state.message ? (
        <p role="status" className="text-sm text-muted-foreground">
          {state.message}
        </p>
      ) : null}
      {/* Saving comes first in the page, so pressing Enter in a field saves the draft and never posts. */}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" name="intent" value="save" variant="outline" disabled={!ready || busy} className="order-2">
          Save as draft
        </Button>
        <Button type="submit" name="intent" value="post" disabled={!ready || busy} className="order-1">
          {busy ? "Working…" : "Post receipt"}
        </Button>
      </div>
    </form>
  );
}

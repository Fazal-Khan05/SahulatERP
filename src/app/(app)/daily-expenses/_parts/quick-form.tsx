"use client";

import { useEffect, useRef, useState } from "react";
import { useFormAction, type FormAction } from "@/components/action-form";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { shrinkPhoto } from "./shrink-photo";

type Choice = { id: string; label: string };

export type QuickFormProps = {
  action: FormAction;
  today: string;
  expenseAccounts: Choice[];
  moneyAccounts: Choice[];
  /** The account this person paid from last, chosen to begin with. */
  paidFromId: string;
  /** The branches to choose from; none when the company has one branch and this person works in all of it. */
  branches: Choice[];
  /** Whether "The whole company" may be chosen: only by someone who works in every branch. */
  wholeCompany: boolean;
  maxReceiptBytes: number;
  receiptTypes: string;
  taxNote: string;
};

const SELECT = "h-8 w-full min-w-0 rounded-lg border border-input bg-card px-2 text-sm";

/**
 * The quick form: one expense, in the books when the button is pressed. The day and the account
 * it was paid from stay as they were for the next one; the rest is cleared. The server reads and
 * checks everything again.
 */
export function QuickAddForm({ action, today, expenseAccounts, moneyAccounts, paidFromId, branches, wholeCompany, maxReceiptBytes, receiptTypes, taxNote }: QuickFormProps) {
  const { state, ready, busy, run } = useFormAction(action);
  // One key for each expense, however many times it is sent: it is recorded once. A new one after each that is recorded.
  const clientKey = useRef<string | null>(null);
  const [date, setDate] = useState(today);
  const [paidFrom, setPaidFrom] = useState(paidFromId);
  const [branch, setBranch] = useState(wholeCompany ? "" : (branches[0]?.id ?? ""));
  const [tooLarge, setTooLarge] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const form = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (!state.ok) return;
    clientKey.current = null;
    const fields = form.current;
    if (!fields) return;
    for (const name of ["whatForId", "amount", "paidTo", "note", "receipt"]) {
      const field = fields.elements.namedItem(name);
      if (field instanceof HTMLInputElement || field instanceof HTMLSelectElement) field.value = "";
    }
    (fields.elements.namedItem("whatForId") as HTMLSelectElement | null)?.focus();
  }, [state]);

  const error = tooLarge ? "The receipt must be 4 MB or smaller." : state.error;
  return (
    <form
      ref={form}
      onSubmit={async (event) => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        clientKey.current ??= crypto.randomUUID();
        data.set("clientKey", clientKey.current);
        const receipt = data.get("receipt");
        if (receipt instanceof File && receipt.size > 0) {
          setPreparing(true);
          const ready = await shrinkPhoto(receipt);
          setPreparing(false);
          data.set("receipt", ready);
          if (ready.size > maxReceiptBytes) return setTooLarge(true);
        } else data.delete("receipt");
        setTooLarge(false);
        run(data);
      }}
      className="flex flex-col gap-4"
    >
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-[10rem_minmax(0,1.2fr)_9rem_minmax(0,1fr)]">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="date">Date</Label>
          <Input id="date" name="date" type="date" value={date} max={today} onChange={(event) => setDate(event.target.value)} required />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="whatForId">What for</Label>
          <select id="whatForId" name="whatForId" className={SELECT} defaultValue="" required>
            <option value="">Choose</option>
            {expenseAccounts.map((account) => (
              <option key={account.id} value={account.id}>
                {account.label}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="amount">Amount (Rs)</Label>
          <Input id="amount" name="amount" inputMode="decimal" autoComplete="off" className="text-right tabular-nums" placeholder="0.00" required />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="paidFromId">Paid from</Label>
          <select id="paidFromId" name="paidFromId" className={SELECT} value={paidFrom} onChange={(event) => setPaidFrom(event.target.value)} required>
            <option value="">Choose</option>
            {moneyAccounts.map((account) => (
              <option key={account.id} value={account.id}>
                {account.label}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,1fr)]">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="note">Note (optional)</Label>
          <Input id="note" name="note" maxLength={200} autoComplete="off" placeholder="Such as: tea for the office" />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="paidTo">Paid to (optional)</Label>
          <Input id="paidTo" name="paidTo" maxLength={120} autoComplete="off" />
        </div>
        {branches.length > 0 ? (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="branchId">Branch</Label>
            <select id="branchId" name="branchId" className={SELECT} value={branch} onChange={(event) => setBranch(event.target.value)}>
              {wholeCompany ? <option value="">The whole company</option> : null}
              {branches.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.label}
                </option>
              ))}
            </select>
          </div>
        ) : null}
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="receipt">Receipt (optional)</Label>
        <input
          id="receipt"
          name="receipt"
          type="file"
          accept={receiptTypes}
          className="text-sm file:mr-3 file:rounded-lg file:border file:border-input file:bg-card file:px-3 file:py-1.5 file:text-sm file:font-semibold"
        />
        <p className="text-xs text-muted-foreground">A PDF, or a photo of the bill. A large photo is made smaller before it is sent.</p>
      </div>
      <p className="text-xs text-muted-foreground">{taxNote}</p>
      {error ? (
        <p role="alert" data-testid="form-error" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {state.message && !error ? (
        <p role="status" data-testid="quick-added" className="text-sm">
          {state.message}
        </p>
      ) : null}
      <div>
        <Button type="submit" disabled={!ready || busy || preparing}>
          {busy || preparing ? "Working…" : "Add expense"}
        </Button>
      </div>
    </form>
  );
}

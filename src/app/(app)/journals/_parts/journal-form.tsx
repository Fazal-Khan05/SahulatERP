"use client";

import Decimal from "decimal.js";
import { useRef, useState } from "react";
import { useFormAction, type FormAction } from "@/components/action-form";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatAmount } from "@/lib/money";

type Row = { key: number; accountId: string; description: string; debit: string; credit: string };

export type JournalFormProps = {
  action: FormAction;
  accounts: { id: string; label: string }[];
  branches: { id: string; name: string }[];
  /** A member limited to some branches must choose one of them. */
  mustChooseBranch: boolean;
  initial: { date: string; memo: string; branchId: string; lines: { accountId: string; description: string; debit: string; credit: string }[] };
  /** Shown once, when a new journal was saved as a draft but could not be posted. */
  refused?: string;
};

const SELECT = "h-8 w-full min-w-0 rounded-lg border border-input bg-card px-2 text-sm";
const EMPTY = { accountId: "", description: "", debit: "", credit: "" };

/** A typed amount as a Decimal for the running totals; anything not yet a number counts as nothing. */
function amount(text: string): Decimal {
  return /^\d+(\.\d{1,4})?$/.test(text.trim()) ? new Decimal(text.trim()) : new Decimal(0);
}

/**
 * The journal entry form: date, reason, branch, and a grid of lines. Rows can be added and
 * removed; the totals and what is still missing are shown as the lines are typed. The totals
 * are a guide only: the server reads and checks every line again.
 */
export function JournalForm({ action, accounts, branches, mustChooseBranch, initial, refused }: JournalFormProps) {
  const { state, ready, busy, run } = useFormAction(action);
  const nextKey = useRef(initial.lines.length + 2);
  const [rows, setRows] = useState<Row[]>(() => {
    const filled = initial.lines.map((line, index) => ({ key: index, ...line }));
    while (filled.length < 2) filled.push({ key: 1000 + filled.length, ...EMPTY });
    return filled;
  });
  const set = (key: number, change: Partial<Row>) => setRows((all) => all.map((row) => (row.key === key ? { ...row, ...change } : row)));
  const debit = rows.reduce((sum, row) => sum.plus(amount(row.debit)), new Decimal(0));
  const credit = rows.reduce((sum, row) => sum.plus(amount(row.credit)), new Decimal(0));
  const difference = debit.minus(credit);
  const error = state.error ?? (state.message ? undefined : refused);

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        const submitter = (event.nativeEvent as SubmitEvent).submitter;
        data.set("intent", submitter instanceof HTMLButtonElement && submitter.value === "post" ? "post" : "save");
        // Rows left empty are not kept, so they are closed up here too: "Line 2" in a message
        // is then the second line on the screen.
        setRows((all) => {
          const filled = all.filter((row) => row.accountId !== "" || row.description.trim() !== "" || row.debit.trim() !== "" || row.credit.trim() !== "");
          while (filled.length < 2) filled.push({ key: (nextKey.current += 1), ...EMPTY });
          return filled;
        });
        run(data);
      }}
      className="flex flex-col gap-4"
    >
      <div className="grid gap-4 sm:grid-cols-[10rem_1fr]">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="date">Date</Label>
          <Input id="date" name="date" type="date" defaultValue={initial.date} required />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="memo">What it is for</Label>
          <Input id="memo" name="memo" defaultValue={initial.memo} required maxLength={500} autoComplete="off" placeholder="Such as: Depreciation for November" />
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

      <div className="overflow-x-auto">
        <table aria-label="Journal lines" className="w-full min-w-[640px] text-left text-sm">
          <thead className="border-b text-muted-foreground">
            <tr>
              <th className="w-[34%] py-2 pr-2 font-medium">Account</th>
              <th className="py-2 pr-2 font-medium">Description</th>
              <th className="w-28 py-2 pr-2 text-right font-medium">Debit</th>
              <th className="w-28 py-2 pr-2 text-right font-medium">Credit</th>
              <th className="w-8 py-2" />
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => (
              <tr key={row.key}>
                <td className="py-1 pr-2">
                  <select name="accountId" aria-label={`Account, line ${index + 1}`} value={row.accountId} onChange={(event) => set(row.key, { accountId: event.target.value })} className={SELECT}>
                    <option value="">Choose an account</option>
                    {accounts.map((account) => (
                      <option key={account.id} value={account.id}>
                        {account.label}
                      </option>
                    ))}
                  </select>
                </td>
                <td className="py-1 pr-2">
                  <Input name="description" aria-label={`Description, line ${index + 1}`} value={row.description} onChange={(event) => set(row.key, { description: event.target.value })} maxLength={300} autoComplete="off" />
                </td>
                <td className="py-1 pr-2">
                  <Input name="debit" aria-label={`Debit, line ${index + 1}`} value={row.debit} onChange={(event) => set(row.key, { debit: event.target.value })} inputMode="decimal" autoComplete="off" className="text-right tabular-nums" />
                </td>
                <td className="py-1 pr-2">
                  <Input name="credit" aria-label={`Credit, line ${index + 1}`} value={row.credit} onChange={(event) => set(row.key, { credit: event.target.value })} inputMode="decimal" autoComplete="off" className="text-right tabular-nums" />
                </td>
                <td className="py-1 text-right">
                  {rows.length > 2 ? (
                    <Button type="button" variant="ghost" size="icon-sm" aria-label={`Remove line ${index + 1}`} onClick={() => setRows((all) => all.filter((other) => other.key !== row.key))}>
                      ×
                    </Button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot className="border-t font-medium">
            <tr>
              <td className="py-2 pr-2" colSpan={2}>
                <Button type="button" variant="outline" size="sm" onClick={() => setRows((all) => [...all, { key: (nextKey.current += 1), ...EMPTY }])}>
                  Add a line
                </Button>
              </td>
              <td className="py-2 pr-2 text-right tabular-nums" data-testid="total-debit">
                {formatAmount(debit)}
              </td>
              <td className="py-2 pr-2 text-right tabular-nums" data-testid="total-credit">
                {formatAmount(credit)}
              </td>
              <td />
            </tr>
          </tfoot>
        </table>
      </div>
      <p className="text-sm text-muted-foreground" data-testid="balance-note">
        {difference.isZero()
          ? debit.isZero()
            ? "Debits must equal credits before the journal can be posted."
            : "Debits equal credits."
          : `Debits and credits differ by ${formatAmount(difference.abs())}: ${difference.isPositive() ? "credits" : "debits"} are short.`}
      </p>

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
          {busy ? "Working…" : "Post journal"}
        </Button>
      </div>
    </form>
  );
}

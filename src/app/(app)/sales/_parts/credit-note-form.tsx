"use client";

import { useFormAction, type FormAction } from "@/components/action-form";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export type CreditNoteFormProps = {
  action: FormAction;
  date: string;
  /** The invoice's date: a credit note is never dated before it. */
  earliest: string;
  /** Today: nothing is recorded before it happens. */
  latest: string;
  notes: string;
  /** The customer's own number for the return: a registered buyer's debit note. */
  reference: string;
  /** Every line of the invoice that still has something to come back. */
  rows: { sourceLineId: string; itemCode: string; description: string; unitCode: string; invoiced: string; returned: string; left: string; quantity: string; damaged: string }[];
};

/**
 * A draft credit note: the date, why, and for each line of the invoice how much came back and
 * how much of that is damaged. A line left empty is left out. Saving keeps the draft and shows
 * what it comes to; posting puts it into the books, the goods that can be sold again back into
 * stock, and writes the damaged ones off.
 */
export function CreditNoteForm({ action, date, earliest, latest, notes, reference, rows }: CreditNoteFormProps) {
  const { state, ready, busy, run } = useFormAction(action);
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
      <div className="grid gap-4 sm:grid-cols-[10rem_1fr_14rem]">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="date">Date of credit note</Label>
          <Input id="date" name="date" type="date" defaultValue={date} min={earliest} max={latest} required />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="notes">Reason</Label>
          <Input id="notes" name="notes" defaultValue={notes} maxLength={1000} autoComplete="off" placeholder="Such as: wrong size sent, two arrived cracked" />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="reference">Customer&apos;s debit note no.</Label>
          <Input id="reference" name="reference" defaultValue={reference} maxLength={60} autoComplete="off" placeholder="If the customer sent one" />
        </div>
      </div>
      <div className="overflow-x-auto">
        <table aria-label="Lines to take back" className="w-full min-w-[680px] text-left text-sm">
          <thead className="border-b text-muted-foreground">
            <tr>
              <th className="py-2 pr-4 font-medium">Item</th>
              <th className="py-2 pr-4 font-medium">Description</th>
              <th className="py-2 pr-4 text-right font-medium">Invoiced</th>
              <th className="py-2 pr-4 text-right font-medium">Already returned</th>
              <th className="w-28 py-2 pr-2 text-right font-medium">Returned now</th>
              <th className="w-28 py-2 pr-2 text-right font-medium">Of which damaged</th>
              <th className="py-2 font-medium">Unit</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {rows.map((row, index) => (
              <tr key={row.sourceLineId}>
                <td className="py-2 pr-4 font-medium whitespace-nowrap">{row.itemCode}</td>
                <td className="py-2 pr-4">{row.description}</td>
                <td className="py-2 pr-4 text-right tabular-nums">{row.invoiced}</td>
                <td className="py-2 pr-4 text-right tabular-nums">{row.returned}</td>
                <td className="py-1 pr-2">
                  <input type="hidden" name="sourceLineId" value={row.sourceLineId} />
                  <Input name="quantity" aria-label={`Returned now, line ${index + 1}`} defaultValue={row.quantity} inputMode="decimal" autoComplete="off" placeholder={`up to ${row.left}`} className="text-right tabular-nums" />
                </td>
                <td className="py-1 pr-2">
                  <Input name="damaged" aria-label={`Of which damaged, line ${index + 1}`} defaultValue={row.damaged} inputMode="decimal" autoComplete="off" className="text-right tabular-nums" />
                </td>
                <td className="py-2 text-muted-foreground">{row.unitCode}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-sm text-muted-foreground">Goods that can be sold again go back into stock. Damaged goods are written off: they do not go back on the shelf.</p>
      {state.error ? (
        <p role="alert" data-testid="form-error" className="text-sm text-destructive">
          {state.error}
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
          {busy ? "Working…" : "Post credit note"}
        </Button>
      </div>
    </form>
  );
}

"use client";

import { useFormAction, type FormAction } from "@/components/action-form";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export type DeliveryFormProps = {
  action: FormAction;
  date: string;
  /** The order's date: a delivery note is never dated before it. */
  earliest: string;
  notes: string;
  rows: { sourceLineId: string; itemCode: string; description: string; unitCode: string; ordered: string; delivered: string; remaining: string; inStock: string; quantity: string }[];
};

/**
 * A draft delivery note: the date, and how much of each line of the order leaves now. Every
 * line of the order that still has something to deliver is listed; a line left empty is not
 * delivered. Saving keeps the draft; posting takes the goods out of stock.
 */
export function DeliveryForm({ action, date, earliest, notes, rows }: DeliveryFormProps) {
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
      <div className="grid gap-4 sm:grid-cols-[10rem_1fr]">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="date">Date of delivery</Label>
          <Input id="date" name="date" type="date" defaultValue={date} min={earliest} required />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="notes">Notes</Label>
          <Input id="notes" name="notes" defaultValue={notes} maxLength={1000} autoComplete="off" placeholder="Such as: vehicle number, who received the goods" />
        </div>
      </div>
      <div className="overflow-x-auto">
        <table aria-label="Lines to deliver" className="w-full min-w-[640px] text-left text-sm">
          <thead className="border-b text-muted-foreground">
            <tr>
              <th className="py-2 pr-4 font-medium">Item</th>
              <th className="py-2 pr-4 font-medium">Description</th>
              <th className="py-2 pr-4 text-right font-medium">Ordered</th>
              <th className="py-2 pr-4 text-right font-medium">Already delivered</th>
              <th className="py-2 pr-4 text-right font-medium">In stock</th>
              <th className="w-28 py-2 pr-2 text-right font-medium">Deliver now</th>
              <th className="py-2 font-medium">Unit</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {rows.map((row, index) => (
              <tr key={row.sourceLineId}>
                <td className="py-2 pr-4 font-medium whitespace-nowrap">{row.itemCode}</td>
                <td className="py-2 pr-4">{row.description}</td>
                <td className="py-2 pr-4 text-right tabular-nums">{row.ordered}</td>
                <td className="py-2 pr-4 text-right tabular-nums">{row.delivered}</td>
                <td className="py-2 pr-4 text-right tabular-nums" data-testid={`in-stock-${index + 1}`}>
                  {row.inStock}
                </td>
                <td className="py-1 pr-2">
                  <input type="hidden" name="sourceLineId" value={row.sourceLineId} />
                  <Input name="quantity" aria-label={`Deliver now, line ${index + 1}`} defaultValue={row.quantity} inputMode="decimal" autoComplete="off" className="text-right tabular-nums" />
                </td>
                <td className="py-2 text-muted-foreground">{row.unitCode}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
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
          {busy ? "Working…" : "Post delivery note"}
        </Button>
      </div>
    </form>
  );
}

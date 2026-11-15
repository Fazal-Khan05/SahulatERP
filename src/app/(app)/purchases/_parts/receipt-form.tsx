"use client";

import { useState } from "react";
import { useFormAction, type FormAction } from "@/components/action-form";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export type ReceiptFormProps = {
  action: FormAction;
  /** The lines of the order that still have something to arrive, or are already on this note. */
  lines: { orderLineId: string; itemCode: string; description: string; unitCode: string; ordered: string; received: string; left: string; quantity: string }[];
  initial: { date: string; supplierDeliveryNote: string; note: string };
  /** Shown once, when a new note was saved as a draft but could not be posted. */
  refused?: string;
};

/**
 * The form of a goods received note: the day the goods arrived and how much of each line of the
 * order came, in the unit it was ordered in. No cost is shown or asked for: the goods come into
 * stock at the order's cost. The server reads and checks everything again.
 */
export function ReceiptForm({ action, lines, initial, refused }: ReceiptFormProps) {
  const { state, ready, busy, run } = useFormAction(action);
  const [quantities, setQuantities] = useState<Record<string, string>>(() => Object.fromEntries(lines.map((line) => [line.orderLineId, line.quantity])));
  const error = state.error ?? (state.message ? undefined : refused);

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
      <div className="grid gap-4 sm:grid-cols-[10rem_1fr_1fr]">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="date">Arrived on</Label>
          <Input id="date" name="date" type="date" defaultValue={initial.date} required />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="supplierDeliveryNote">Supplier&apos;s delivery note number</Label>
          <Input id="supplierDeliveryNote" name="supplierDeliveryNote" defaultValue={initial.supplierDeliveryNote} maxLength={60} autoComplete="off" />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="note">Note</Label>
          <Input id="note" name="note" defaultValue={initial.note} maxLength={500} autoComplete="off" placeholder="Such as: two cartons wet" />
        </div>
      </div>

      <div className="overflow-x-auto">
        <table aria-label="Goods received" className="w-full min-w-[640px] text-left text-sm">
          <thead className="border-b text-muted-foreground">
            <tr>
              <th className="py-2 pr-4 font-medium">Item code</th>
              <th className="py-2 pr-4 font-medium">Item</th>
              <th className="py-2 pr-4 text-right font-medium">Ordered</th>
              <th className="py-2 pr-4 text-right font-medium">Still to come</th>
              <th className="w-32 py-2 pr-2 text-right font-medium">Arrived now</th>
              <th className="py-2 font-medium">Unit</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {lines.map((line, index) => (
              <tr key={line.orderLineId}>
                <td className="py-1 pr-4 font-medium whitespace-nowrap">{line.itemCode}</td>
                <td className="py-1 pr-4">{line.description}</td>
                <td className="py-1 pr-4 text-right tabular-nums">{line.ordered}</td>
                <td className="py-1 pr-4 text-right tabular-nums" data-testid={`left-${index + 1}`}>
                  {line.left}
                </td>
                <td className="py-1 pr-2">
                  <input type="hidden" name="orderLineId" value={line.orderLineId} />
                  <Input
                    name="quantity"
                    aria-label={`Arrived now, line ${index + 1}`}
                    value={quantities[line.orderLineId] ?? ""}
                    onChange={(event) => setQuantities((all) => ({ ...all, [line.orderLineId]: event.target.value }))}
                    inputMode="decimal"
                    autoComplete="off"
                    className="text-right tabular-nums"
                  />
                </td>
                <td className="py-1 text-muted-foreground">{line.unitCode}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div>
        <Button type="button" variant="outline" size="sm" onClick={() => setQuantities(Object.fromEntries(lines.map((line) => [line.orderLineId, line.left])))}>
          All of it arrived
        </Button>
      </div>
      <p className="text-sm text-muted-foreground">Enter only what arrived. A line left empty did not come; what is left of the order can be received on another note.</p>

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
          {busy ? "Working…" : "Post goods received"}
        </Button>
      </div>
    </form>
  );
}

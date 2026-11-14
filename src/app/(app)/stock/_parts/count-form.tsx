"use client";

import { useState } from "react";
import { useFormAction, type FormAction } from "@/components/action-form";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export type CountFormProps = {
  action: FormAction;
  initial: { date: string; note: string };
  lines: { id: string; code: string; name: string; unit: string; book: string; counted: string }[];
  /** Whether to show what the books hold beside each line. The warehouse counts without it. */
  showBook: boolean;
};

/**
 * The count sheet as it is filled in: one row for each item, with what was counted. A row left
 * empty has not been counted (yet). Saving keeps what is typed; "Finish counting" saves and
 * closes the sheet, which then waits for an owner or an accountant.
 */
export function CountForm({ action, initial, lines, showBook }: CountFormProps) {
  const { state, ready, busy, run } = useFormAction(action);
  const [counted, setCounted] = useState<Record<string, string>>(() => Object.fromEntries(lines.map((line) => [line.id, line.counted])));
  const done = lines.filter((line) => (counted[line.id] ?? "").trim() !== "").length;

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        const submitter = (event.nativeEvent as SubmitEvent).submitter;
        data.set("intent", submitter instanceof HTMLButtonElement && submitter.value === "finish" ? "finish" : "save");
        run(data);
      }}
      className="flex flex-col gap-4"
    >
      <div className="grid gap-4 sm:grid-cols-[10rem_1fr]">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="date">Date of the count</Label>
          <Input id="date" name="date" type="date" defaultValue={initial.date} required />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="note">Note</Label>
          <Input id="note" name="note" defaultValue={initial.note} maxLength={500} autoComplete="off" />
        </div>
      </div>
      {lines.length === 0 ? (
        <p className="py-4 text-muted-foreground">The books say this warehouse holds nothing. Add what you find on the shelves below, one item at a time.</p>
      ) : (
        <div className="overflow-x-auto">
          <table aria-label="Count sheet" className="w-full min-w-[520px] text-left text-sm">
            <thead className="border-b text-muted-foreground">
              <tr>
                <th className="py-2 pr-4 font-medium">Item code</th>
                <th className="py-2 pr-4 font-medium">Item</th>
                {showBook ? <th className="py-2 pr-4 text-right font-medium">Books say</th> : null}
                <th className="w-32 py-2 pr-2 text-right font-medium">Counted</th>
                <th className="py-2 font-medium">Unit</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {lines.map((line) => (
                <tr key={line.id}>
                  <td className="py-1 pr-4 font-medium whitespace-nowrap">
                    {line.code}
                    <input type="hidden" name="lineId" value={line.id} />
                    <input type="hidden" name="label" value={line.code} />
                  </td>
                  <td className="py-1 pr-4">{line.name}</td>
                  {showBook ? <td className="py-1 pr-4 text-right tabular-nums">{line.book}</td> : null}
                  <td className="py-1 pr-2">
                    <Input
                      name="counted"
                      aria-label={`Counted, ${line.code}`}
                      value={counted[line.id] ?? ""}
                      onChange={(event) => setCounted((all) => ({ ...all, [line.id]: event.target.value }))}
                      inputMode="decimal"
                      autoComplete="off"
                      className="text-right tabular-nums"
                    />
                  </td>
                  <td className="py-1 text-muted-foreground">{line.unit}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="text-sm text-muted-foreground" data-testid="count-progress">
        {done} of {lines.length} counted. A row left empty is not counted and stays as the books have it; enter 0 for an empty shelf.
      </p>
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
      <div className="flex flex-wrap gap-2">
        <Button type="submit" name="intent" value="save" variant="outline" disabled={!ready || busy} className="order-2">
          Save
        </Button>
        <Button type="submit" name="intent" value="finish" disabled={!ready || busy} className="order-1">
          {busy ? "Working…" : "Finish counting"}
        </Button>
      </div>
    </form>
  );
}

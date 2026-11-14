"use client";

import { useState } from "react";
import { useFormAction } from "@/components/action-form";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { OpeningImportState } from "./actions";

type Props = {
  action: (state: OpeningImportState, formData: FormData) => Promise<OpeningImportState>;
  warehouses: { id: string; name: string }[];
  today: string;
  maxBytes: number;
};

const SELECT = "h-8 w-full min-w-0 rounded-lg border border-input bg-card px-2 text-sm";

/**
 * Sends a CSV file of opening stock for one warehouse. When every row is right the draft opens,
 * to be looked over and posted; otherwise each wrong row is listed and nothing is kept.
 */
export function OpeningImport({ action, warehouses, today, maxBytes }: Props) {
  const { state, ready, busy, run } = useFormAction<OpeningImportState>(action);
  const [tooLarge, setTooLarge] = useState(false);
  const error = tooLarge ? "The file is too large. Import at most 2,000 rows at a time." : state.error;

  return (
    <div className="flex flex-col gap-4">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          const data = new FormData(event.currentTarget);
          const file = data.get("file");
          const oversized = file instanceof File && file.size > maxBytes;
          setTooLarge(oversized);
          if (!oversized) run(data);
        }}
        className="flex flex-col gap-4"
      >
        <div className="grid gap-4 sm:grid-cols-[10rem_1fr]">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="import-date">Date</Label>
            <Input id="import-date" name="date" type="date" defaultValue={today} required />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="import-warehouse">Warehouse</Label>
            <select id="import-warehouse" name="warehouseId" defaultValue={warehouses.length === 1 ? warehouses[0].id : ""} required className={SELECT}>
              <option value="">Choose a warehouse</option>
              {warehouses.map((warehouse) => (
                <option key={warehouse.id} value={warehouse.id}>
                  {warehouse.name}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="import-file">CSV file</Label>
          <input id="import-file" name="file" type="file" accept=".csv,text/csv" required className="text-sm" />
        </div>
        {error ? (
          <p role="alert" data-testid="import-error" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        <Button type="submit" disabled={!ready || busy} className="self-start">
          {busy ? "Working…" : "Read the file"}
        </Button>
      </form>

      {!busy && state.problems ? (
        <div data-testid="import-problems">
          <p role="alert" className="mb-2 text-sm font-semibold text-destructive">
            Nothing was kept. {state.problems.length === 1 ? "1 row needs" : `${state.problems.length} rows need`} correcting; put {state.problems.length === 1 ? "it" : "them"} right in the file and
            read it again.
          </p>
          <div className="overflow-x-auto">
            <table aria-label="Rows to correct" className="w-full text-left text-sm">
              <thead className="border-b text-muted-foreground">
                <tr>
                  <th className="py-2 pr-4 font-medium">Row</th>
                  <th className="py-2 pr-4 font-medium">Item code</th>
                  <th className="py-2 font-medium">What is wrong</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {state.problems.map((problem) => (
                  <tr key={problem.row}>
                    <td className="py-2 pr-4 align-top whitespace-nowrap">{problem.row}</td>
                    <td className="py-2 pr-4 align-top">{problem.name || "(none)"}</td>
                    <td className="py-2 align-top">{problem.problems.join(" ")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}
    </div>
  );
}

"use client";

import { useRef, useState } from "react";
import { useFormAction } from "@/components/action-form";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import type { ImportState } from "./actions";

type Props = {
  action: (state: ImportState, formData: FormData) => Promise<ImportState>;
  /** "customers" or "suppliers", for the messages. */
  many: string;
  maxBytes: number;
  /** The file input's id; give one when two imports sit on the same screen. */
  id?: string;
};

/**
 * Sends a CSV file to the import and shows what came back: how many rows were imported, or every
 * row that stopped the import with what is wrong in it.
 */
export function ImportForm({ action, many, maxBytes, id = "file" }: Props) {
  const { state, ready, busy, run } = useFormAction<ImportState>(action);
  const [tooLarge, setTooLarge] = useState(false);
  const form = useRef<HTMLFormElement>(null);
  const error = tooLarge ? "The file is too large. Import at most 2,000 rows at a time." : state.error;

  return (
    <div className="flex flex-col gap-4">
      <form
        ref={form}
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
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={id}>CSV file</Label>
          <input id={id} name="file" type="file" accept=".csv,text/csv" required className="text-sm" />
        </div>
        {error ? (
          <p role="alert" data-testid="form-error" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        <Button type="submit" disabled={!ready || busy} className="self-start">
          {busy ? "Working…" : "Import"}
        </Button>
      </form>

      {!busy && state.imported !== undefined ? (
        <p role="status" data-testid="import-done" className="text-sm font-semibold">
          Imported {state.imported} {many}.
        </p>
      ) : null}

      {!busy && state.problems ? (
        <div data-testid="import-problems">
          <p role="alert" className="mb-2 text-sm font-semibold text-destructive">
            Nothing was imported. {state.problems.length === 1 ? "1 row needs" : `${state.problems.length} rows need`} correcting; put{" "}
            {state.problems.length === 1 ? "it" : "them"} right in the file and import it again.
          </p>
          <div className="overflow-x-auto">
            <table aria-label="Rows to correct" className="w-full text-left text-sm">
              <thead className="border-b text-muted-foreground">
                <tr>
                  <th className="py-2 pr-4 font-medium">Row</th>
                  <th className="py-2 pr-4 font-medium">Name</th>
                  <th className="py-2 font-medium">What is wrong</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {state.problems.map((problem) => (
                  <tr key={problem.row}>
                    <td className="py-2 pr-4 align-top whitespace-nowrap">{problem.row}</td>
                    <td className="py-2 pr-4 align-top">{problem.name || "(no name)"}</td>
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

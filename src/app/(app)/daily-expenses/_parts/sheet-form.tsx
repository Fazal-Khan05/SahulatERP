"use client";

import { useFormAction } from "@/components/action-form";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import type { SheetState } from "./actions";

type Choice = { id: string; label: string };
type SheetAction = (state: SheetState, formData: FormData) => Promise<SheetState>;

const SELECT = "h-8 w-full min-w-0 rounded-lg border border-input bg-card px-2 text-sm";

/**
 * A sheet of expenses in two steps: it is read and shown first, every row with what is wrong
 * with it, and entered only when the button under the preview is pressed: every row or none.
 */
export function SheetForm({ preview, record, branches, wholeCompany }: { preview: SheetAction; record: SheetAction; branches: Choice[]; wholeCompany: boolean }) {
  const read = useFormAction<SheetState>(preview);
  const enter = useFormAction<SheetState>(record);
  // The preview that was entered is not shown again under its own "Entered" line.
  const shown = read.state.preview && read.state.preview.clientKey !== enter.state.enteredKey ? read.state.preview : null;

  return (
    <div className="flex flex-col gap-5">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          read.run(new FormData(event.currentTarget));
        }}
        className="flex flex-col gap-4"
      >
        <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_14rem]">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="sheet">The sheet</Label>
            <input
              id="sheet"
              name="sheet"
              type="file"
              required
              accept=".xlsx,.csv,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              className="text-sm file:mr-3 file:rounded-lg file:border file:border-input file:bg-card file:px-3 file:py-1.5 file:text-sm file:font-semibold"
            />
            <p className="text-xs text-muted-foreground">An Excel file (.xlsx) or a CSV file, up to 200 expenses.</p>
          </div>
          {branches.length > 0 ? (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="branchId">Branch (for every row)</Label>
              <select id="branchId" name="branchId" className={SELECT} defaultValue={wholeCompany ? "" : branches[0]?.id}>
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
        {read.state.error ? (
          <p role="alert" data-testid="form-error" className="text-sm text-destructive">
            {read.state.error}
          </p>
        ) : null}
        <div>
          <Button type="submit" variant={shown ? "outline" : "default"} disabled={!read.ready || read.busy}>
            {read.busy ? "Reading…" : "Read the sheet"}
          </Button>
        </div>
      </form>

      {enter.state.ok && !shown ? (
        <p role="status" data-testid="sheet-entered" className="text-sm font-medium">
          {enter.state.message}
        </p>
      ) : null}

      {shown ? (
        <section aria-label="Preview" className="flex flex-col gap-3 border-t pt-4">
          <p className="text-sm" data-testid="sheet-summary">
            {shown.bad === 0
              ? `${shown.rows.length} ${shown.rows.length === 1 ? "expense" : "expenses"}, ${shown.total} in all. Nothing is entered until you press the button below.`
              : `${shown.bad} of ${shown.rows.length} ${shown.rows.length === 1 ? "row" : "rows"} ${shown.bad === 1 ? "needs" : "need"} putting right. Nothing was entered: correct the sheet and read it again.`}
          </p>
          <div className="overflow-x-auto">
            <table aria-label="Sheet preview" className="w-full min-w-[820px] text-left text-sm">
              <thead className="border-b text-muted-foreground">
                <tr>
                  <th className="w-12 py-2 pr-3 font-medium">Row</th>
                  <th className="py-2 pr-3 font-medium">Date</th>
                  <th className="py-2 pr-3 font-medium">What for</th>
                  <th className="py-2 pr-3 text-right font-medium">Amount</th>
                  <th className="py-2 pr-3 font-medium">Paid from</th>
                  <th className="py-2 pr-3 font-medium">Paid to</th>
                  <th className="py-2 font-medium">Note</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {shown.rows.map((row) => (
                  <tr key={row.row} className={row.problems.length > 0 ? "bg-destructive/5 align-top" : "align-top"}>
                    <td className="py-2 pr-3 tabular-nums text-muted-foreground">{row.row}</td>
                    <td className="py-2 pr-3 whitespace-nowrap">{row.dateRead ?? row.date}</td>
                    <td className="py-2 pr-3">{row.whatForName ?? row.whatFor}</td>
                    <td className="py-2 pr-3 text-right tabular-nums">{row.amountRead ?? row.amount}</td>
                    <td className="py-2 pr-3">{row.paidFromName ?? row.paidFrom}</td>
                    <td className="py-2 pr-3">{row.paidTo}</td>
                    <td className="py-2">
                      {row.note}
                      {row.problems.length > 0 ? (
                        <ul className="mt-1 list-disc pl-4 text-destructive" data-testid="row-problems">
                          {row.problems.map((problem) => (
                            <li key={problem}>{problem}</li>
                          ))}
                        </ul>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {shown.bad === 0 ? (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                const data = new FormData();
                data.set("rows", JSON.stringify(shown.rows.map(({ row, date, whatFor, amount, paidFrom, paidTo, note }) => ({ row, date, whatFor, amount, paidFrom, paidTo, note }))));
                data.set("clientKey", shown.clientKey);
                data.set("branchId", shown.branchId);
                enter.run(data);
              }}
              className="flex flex-col gap-3"
            >
              {enter.state.error && enter.state.refusedKey === shown.clientKey ? (
                <p role="alert" data-testid="form-error" className="text-sm text-destructive">
                  {enter.state.error}
                </p>
              ) : null}
              <div>
                <Button type="submit" disabled={!enter.ready || enter.busy}>
                  {enter.busy ? "Working…" : `Enter ${shown.rows.length === 1 ? "this expense" : `these ${shown.rows.length} expenses`}`}
                </Button>
              </div>
            </form>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}

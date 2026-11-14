"use client";

import { useMemo, useRef, useState } from "react";
import { useFormAction, type FormAction } from "@/components/action-form";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type Row = { key: number; itemCode: string; direction: string; quantity: string; unitCost: string };
type Choice = { id: string; name: string };
type Reason = { value: string; label: string };

export type StockLinesFormProps = {
  action: FormAction;
  /** A transfer moves goods between two warehouses; the other two change what one warehouse holds. */
  mode: "transfer" | "adjustment" | "opening";
  warehouses: Choice[];
  /** Every item that can be named, for the list offered under the code field and the name shown beside it. */
  items: { code: string; name: string; unit: string }[];
  reasons?: Reason[];
  initial: {
    date: string;
    warehouseId: string;
    toWarehouseId: string;
    reason: string;
    note: string;
    lines: { itemCode: string; direction: string; quantity: string; unitCost: string }[];
  };
  /** Shown once, when a new document was saved as a draft but could not be posted. */
  refused?: string;
};

const SELECT = "h-8 w-full min-w-0 rounded-lg border border-input bg-card px-2 text-sm";
const EMPTY = { itemCode: "", direction: "in", quantity: "", unitCost: "" };
const MIN_ROWS = 3;
const WORDS = {
  transfer: { post: "Post transfer", note: "Such as: for the city counter" },
  adjustment: { post: "Post adjustment", note: "Such as: dropped while unloading" },
  opening: { post: "Post opening stock", note: "Such as: counted on 30 June" },
} as const;

/**
 * The form of a stock transfer, a stock adjustment or opening stock: the warehouse (or two),
 * the date, and a grid of lines, each an item by its code and a quantity. Rows can be added
 * and removed. The server reads and checks everything again.
 */
export function StockLinesForm({ action, mode, warehouses, items, reasons = [], initial, refused }: StockLinesFormProps) {
  const { state, ready, busy, run } = useFormAction(action);
  const nextKey = useRef(initial.lines.length + MIN_ROWS);
  const [rows, setRows] = useState<Row[]>(() => {
    const filled = initial.lines.map((line, index) => ({ key: index, ...line }));
    while (filled.length < MIN_ROWS) filled.push({ key: 1000 + filled.length, ...EMPTY });
    return filled;
  });
  const [reason, setReason] = useState(initial.reason);
  const known = useMemo(() => new Map(items.map((item) => [item.code.toLowerCase(), item])), [items]);
  const set = (key: number, change: Partial<Row>) => setRows((all) => all.map((row) => (row.key === key ? { ...row, ...change } : row)));
  const transfer = mode === "transfer";
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
          const filled = all.filter((row) => row.itemCode.trim() !== "" || row.quantity.trim() !== "" || row.unitCost.trim() !== "");
          while (filled.length < MIN_ROWS) filled.push({ key: (nextKey.current += 1), ...EMPTY });
          return filled;
        });
        run(data);
      }}
      className="flex flex-col gap-4"
    >
      <div className="grid gap-4 sm:grid-cols-[10rem_1fr_1fr]">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="date">Date</Label>
          <Input id="date" name="date" type="date" defaultValue={initial.date} required />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={transfer ? "fromWarehouseId" : "warehouseId"}>{transfer ? "From warehouse" : "Warehouse"}</Label>
          <select id={transfer ? "fromWarehouseId" : "warehouseId"} name={transfer ? "fromWarehouseId" : "warehouseId"} defaultValue={initial.warehouseId} required className={SELECT}>
            <option value="">Choose a warehouse</option>
            {warehouses.map((warehouse) => (
              <option key={warehouse.id} value={warehouse.id}>
                {warehouse.name}
              </option>
            ))}
          </select>
        </div>
        {transfer ? (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="toWarehouseId">To warehouse</Label>
            <select id="toWarehouseId" name="toWarehouseId" defaultValue={initial.toWarehouseId} required className={SELECT}>
              <option value="">Choose a warehouse</option>
              {warehouses.map((warehouse) => (
                <option key={warehouse.id} value={warehouse.id}>
                  {warehouse.name}
                </option>
              ))}
            </select>
          </div>
        ) : mode === "adjustment" ? (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="reason">Reason</Label>
            <select id="reason" name="reason" value={reason} onChange={(event) => setReason(event.target.value)} required className={SELECT}>
              <option value="">Choose a reason</option>
              {reasons.map((choice) => (
                <option key={choice.value} value={choice.value}>
                  {choice.label}
                </option>
              ))}
            </select>
          </div>
        ) : null}
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="note">{reason === "other" ? "Note (say what the reason is)" : "Note"}</Label>
        <Input id="note" name="note" defaultValue={initial.note} maxLength={500} autoComplete="off" required={reason === "other"} placeholder={WORDS[mode].note} />
      </div>

      <datalist id="stock-item-codes">
        {items.map((item) => (
          <option key={item.code} value={item.code}>
            {item.name}
          </option>
        ))}
      </datalist>
      <div className="overflow-x-auto">
        <table aria-label="Lines" className="w-full min-w-[640px] text-left text-sm">
          <thead className="border-b text-muted-foreground">
            <tr>
              <th className="w-44 py-2 pr-2 font-medium">Item code</th>
              <th className="py-2 pr-2 font-medium">Item</th>
              {transfer ? null : <th className="w-32 py-2 pr-2 font-medium">Add or take out</th>}
              <th className="w-28 py-2 pr-2 text-right font-medium">Quantity</th>
              {transfer ? null : <th className="w-32 py-2 pr-2 text-right font-medium">Cost of one</th>}
              <th className="w-8 py-2" />
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => {
              const item = known.get(row.itemCode.trim().toLowerCase());
              const out = row.direction === "out";
              return (
                <tr key={row.key}>
                  <td className="py-1 pr-2">
                    <Input name="itemCode" aria-label={`Item code, line ${index + 1}`} list="stock-item-codes" value={row.itemCode} onChange={(event) => set(row.key, { itemCode: event.target.value })} maxLength={30} autoComplete="off" />
                  </td>
                  <td className="py-1 pr-2 text-muted-foreground" data-testid={`item-name-${index + 1}`}>
                    {item ? `${item.name} (${item.unit})` : row.itemCode.trim() === "" ? "" : "No item has this code"}
                  </td>
                  {transfer ? null : (
                    <td className="py-1 pr-2">
                      <select name="direction" aria-label={`Add or take out, line ${index + 1}`} value={row.direction} onChange={(event) => set(row.key, { direction: event.target.value, unitCost: event.target.value === "out" ? "" : row.unitCost })} className={SELECT}>
                        <option value="in">Add</option>
                        <option value="out">Take out</option>
                      </select>
                    </td>
                  )}
                  <td className="py-1 pr-2">
                    <Input name="quantity" aria-label={`Quantity, line ${index + 1}`} value={row.quantity} onChange={(event) => set(row.key, { quantity: event.target.value })} inputMode="decimal" autoComplete="off" className="text-right tabular-nums" />
                  </td>
                  {transfer ? null : (
                    <td className="py-1 pr-2">
                      {/* Kept in the form when goods are taken out, empty, so the lists of fields line up. */}
                      <Input
                        name="unitCost"
                        aria-label={`Cost of one, line ${index + 1}`}
                        value={out ? "" : row.unitCost}
                        onChange={(event) => set(row.key, { unitCost: event.target.value })}
                        readOnly={out}
                        placeholder={out ? "at average" : mode === "opening" ? "" : "at average"}
                        inputMode="decimal"
                        autoComplete="off"
                        className="text-right tabular-nums"
                      />
                    </td>
                  )}
                  <td className="py-1 text-right">
                    {rows.length > 1 ? (
                      <Button type="button" variant="ghost" size="icon-sm" aria-label={`Remove line ${index + 1}`} onClick={() => setRows((all) => all.filter((other) => other.key !== row.key))}>
                        ×
                      </Button>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div>
        <Button type="button" variant="outline" size="sm" onClick={() => setRows((all) => [...all, { key: (nextKey.current += 1), ...EMPTY }])}>
          Add a line
        </Button>
      </div>
      {transfer ? null : (
        <p className="text-sm text-muted-foreground">
          {mode === "opening"
            ? "Quantities are in each item's own unit. Enter what one cost: opening stock comes into the books at its cost."
            : "Quantities are in each item's own unit. Goods taken out leave at their average cost. For goods added, enter what one cost, or leave it empty to use the cost the warehouse already holds the item at."}
        </p>
      )}

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
          {busy ? "Working…" : WORDS[mode].post}
        </Button>
      </div>
    </form>
  );
}

"use client";

import Decimal from "decimal.js";
import { useMemo, useRef, useState } from "react";
import { useFormAction, type FormAction } from "@/components/action-form";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatAmount } from "@/lib/money";

type Choice = { id: string; label: string };
type Unit = { id: string; code: string; factor: string };
type Item = { id: string; code: string; name: string; units: Unit[] };
type Row = { key: number; itemCode: string; unitId: string; quantity: string; unitCost: string };

export type OrderFormProps = {
  action: FormAction;
  suppliers: Choice[];
  warehouses: Choice[];
  /** Every item that can be ordered, for the list offered under the code field, its name and its units. */
  items: Item[];
  initial: {
    date: string;
    supplierId: string;
    warehouseId: string;
    expectedOn: string;
    supplierReference: string;
    note: string;
    lines: { itemCode: string; unitId: string; quantity: string; unitCost: string }[];
  };
  /** Shown once, when a new order was saved as a draft but could not be submitted. */
  refused?: string;
};

const SELECT = "h-8 w-full min-w-0 rounded-lg border border-input bg-card px-2 text-sm";
const EMPTY = { itemCode: "", unitId: "", quantity: "", unitCost: "" };
const MIN_ROWS = 3;
const PLAIN = /^\d+(\.\d+)?$/;

/** What a line comes to, to the paisa, or null while its quantity or cost is not yet a number. */
function lineAmount(row: Row): Decimal | null {
  const quantity = row.quantity.trim();
  const cost = row.unitCost.trim();
  if (!PLAIN.test(quantity) || !PLAIN.test(cost)) return null;
  return new Decimal(quantity).times(cost).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
}

/**
 * The form of a purchase order: the supplier, the warehouse the goods are to arrive at, the
 * date, and a grid of lines, each an item by its code, a quantity in one of the item's units
 * and what one of that unit costs before tax. The server reads and checks everything again.
 */
export function OrderForm({ action, suppliers, warehouses, items, initial, refused }: OrderFormProps) {
  const { state, ready, busy, run } = useFormAction(action);
  const nextKey = useRef(initial.lines.length + MIN_ROWS);
  const [rows, setRows] = useState<Row[]>(() => {
    const filled = initial.lines.map((line, index) => ({ key: index, ...line }));
    while (filled.length < MIN_ROWS) filled.push({ key: 1000 + filled.length, ...EMPTY });
    return filled;
  });
  const known = useMemo(() => new Map(items.map((item) => [item.code.toLowerCase(), item])), [items]);
  const find = (code: string) => known.get(code.trim().toLowerCase());
  const set = (key: number, change: Partial<Row>) => setRows((all) => all.map((row) => (row.key === key ? { ...row, ...change } : row)));
  const error = state.error ?? (state.message ? undefined : refused);
  const total = rows.reduce((sum, row) => sum.plus(lineAmount(row) ?? 0), new Decimal(0));

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        const submitter = (event.nativeEvent as SubmitEvent).submitter;
        data.set("intent", submitter instanceof HTMLButtonElement && submitter.value === "submit" ? "submit" : "save");
        // Rows left empty are not kept, so they are closed up here too: "Line 2" in a message
        // is then the second line on the screen.
        const filled = rows.filter((row) => row.itemCode.trim() !== "" || row.quantity.trim() !== "" || row.unitCost.trim() !== "");
        for (const name of ["itemCode", "itemId", "unitId", "quantity", "unitCost"]) data.delete(name);
        for (const row of filled) {
          const item = find(row.itemCode);
          // A code no item has is sent as no item: the server says which line to look at.
          data.append("itemId", item?.id ?? "");
          data.append("unitId", item && item.units.some((unit) => unit.id === row.unitId) ? row.unitId : "");
          data.append("quantity", row.quantity);
          data.append("unitCost", row.unitCost);
        }
        setRows(() => {
          const kept = [...filled];
          while (kept.length < MIN_ROWS) kept.push({ key: (nextKey.current += 1), ...EMPTY });
          return kept;
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
          <Label htmlFor="supplierId">Supplier</Label>
          <select id="supplierId" name="supplierId" defaultValue={initial.supplierId} required className={SELECT}>
            <option value="">Choose a supplier</option>
            {suppliers.map((supplier) => (
              <option key={supplier.id} value={supplier.id}>
                {supplier.label}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="warehouseId">Warehouse the goods arrive at</Label>
          <select id="warehouseId" name="warehouseId" defaultValue={initial.warehouseId} required className={SELECT}>
            <option value="">Choose a warehouse</option>
            {warehouses.map((warehouse) => (
              <option key={warehouse.id} value={warehouse.id}>
                {warehouse.label}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="grid gap-4 sm:grid-cols-[10rem_1fr_1fr]">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="expectedOn">Expected on</Label>
          <Input id="expectedOn" name="expectedOn" type="date" defaultValue={initial.expectedOn} />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="supplierReference">Supplier&apos;s reference</Label>
          <Input id="supplierReference" name="supplierReference" defaultValue={initial.supplierReference} maxLength={60} autoComplete="off" placeholder="Such as their quotation number" />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="note">Note</Label>
          <Input id="note" name="note" defaultValue={initial.note} maxLength={500} autoComplete="off" />
        </div>
      </div>

      <datalist id="purchase-item-codes">
        {items.map((item) => (
          <option key={item.id} value={item.code}>
            {item.name}
          </option>
        ))}
      </datalist>
      <div className="overflow-x-auto">
        <table aria-label="Lines" className="w-full min-w-[760px] text-left text-sm">
          <thead className="border-b text-muted-foreground">
            <tr>
              <th className="w-40 py-2 pr-2 font-medium">Item code</th>
              <th className="py-2 pr-2 font-medium">Item</th>
              <th className="w-28 py-2 pr-2 text-right font-medium">Quantity</th>
              <th className="w-28 py-2 pr-2 font-medium">Unit</th>
              <th className="w-32 py-2 pr-2 text-right font-medium">Cost of one</th>
              <th className="w-32 py-2 pr-2 text-right font-medium">Amount</th>
              <th className="w-8 py-2" />
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => {
              const item = find(row.itemCode);
              const amount = lineAmount(row);
              const unitId = item && item.units.some((unit) => unit.id === row.unitId) ? row.unitId : (item?.units[0]?.id ?? "");
              return (
                <tr key={row.key}>
                  <td className="py-1 pr-2">
                    <Input aria-label={`Item code, line ${index + 1}`} list="purchase-item-codes" value={row.itemCode} onChange={(event) => set(row.key, { itemCode: event.target.value, unitId: "" })} maxLength={30} autoComplete="off" />
                  </td>
                  <td className="py-1 pr-2 text-muted-foreground" data-testid={`item-name-${index + 1}`}>
                    {item ? item.name : row.itemCode.trim() === "" ? "" : "No item has this code"}
                  </td>
                  <td className="py-1 pr-2">
                    <Input aria-label={`Quantity, line ${index + 1}`} value={row.quantity} onChange={(event) => set(row.key, { quantity: event.target.value })} inputMode="decimal" autoComplete="off" className="text-right tabular-nums" />
                  </td>
                  <td className="py-1 pr-2">
                    {item && item.units.length > 1 ? (
                      <select aria-label={`Unit, line ${index + 1}`} value={unitId} onChange={(event) => set(row.key, { unitId: event.target.value })} className={SELECT}>
                        {item.units.map((unit) => (
                          <option key={unit.id} value={unit.id}>
                            {unit.code}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <span className="text-muted-foreground">{item?.units[0]?.code ?? ""}</span>
                    )}
                  </td>
                  <td className="py-1 pr-2">
                    <Input aria-label={`Cost of one, line ${index + 1}`} value={row.unitCost} onChange={(event) => set(row.key, { unitCost: event.target.value })} inputMode="decimal" autoComplete="off" className="text-right tabular-nums" />
                  </td>
                  <td className="py-1 pr-2 text-right tabular-nums" data-testid={`line-amount-${index + 1}`}>
                    {amount ? formatAmount(amount) : ""}
                  </td>
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
          <tfoot className="border-t">
            <tr>
              <td colSpan={5} className="py-2 pr-2 text-right font-medium">
                Total before tax
              </td>
              <td className="py-2 pr-2 text-right font-semibold tabular-nums" data-testid="order-total">
                {formatAmount(total)}
              </td>
              <td />
            </tr>
          </tfoot>
        </table>
      </div>
      <div>
        <Button type="button" variant="outline" size="sm" onClick={() => setRows((all) => [...all, { key: (nextKey.current += 1), ...EMPTY }])}>
          Add a line
        </Button>
      </div>
      <p className="text-sm text-muted-foreground">Enter what one of the unit costs, before tax. The supplier&apos;s bill brings the tax; the goods come into stock at this cost when they are received.</p>

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
      {/* Saving comes first in the page, so pressing Enter in a field saves the draft and never submits. */}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" name="intent" value="save" variant="outline" disabled={!ready || busy} className="order-2">
          Save as draft
        </Button>
        <Button type="submit" name="intent" value="submit" disabled={!ready || busy} className="order-1">
          {busy ? "Working…" : "Submit order"}
        </Button>
      </div>
    </form>
  );
}

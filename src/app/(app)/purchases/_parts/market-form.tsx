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

export type MarketFormProps = {
  action: FormAction;
  suppliers: Choice[];
  warehouses: Choice[];
  items: Item[];
  accounts: (Choice & { kind: "cash" | "bank" })[];
  initial: { date: string; warehouseId: string; lines: { itemCode: string; unitId: string; quantity: string; unitCost: string }[] };
  /** What a quick market purchase does not do about tax, said under the lines. */
  taxNote: string;
};

const SELECT = "h-8 w-full min-w-0 rounded-lg border border-input bg-card px-2 text-sm";
const EMPTY = { itemCode: "", unitId: "", quantity: "", unitCost: "" };
const MIN_ROWS = 2;
const PLAIN = /^\d+(\.\d+)?$/;

/** What a line comes to, to the paisa, or null while its quantity or cost is not yet a number. */
function lineAmount(row: Row): Decimal | null {
  const quantity = row.quantity.trim();
  const cost = row.unitCost.trim();
  if (!PLAIN.test(quantity) || !PLAIN.test(cost)) return null;
  return new Decimal(quantity).times(cost).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
}

/**
 * The one screen of a quick market purchase: what was bought, from whom, what it cost, and the
 * cash or bank account it was paid from. The server reads and checks everything again, and
 * records all of it or none.
 */
export function MarketPurchaseForm({ action, suppliers, warehouses, items, accounts, initial, taxNote }: MarketFormProps) {
  const { state, ready, busy, run } = useFormAction(action);
  // Made once for this form: the same purchase sent twice (a double click, a retry) is recorded once.
  const [clientKey] = useState(() => crypto.randomUUID());
  const nextKey = useRef(initial.lines.length + MIN_ROWS);
  const [rows, setRows] = useState<Row[]>(() => {
    const filled = initial.lines.map((line, index) => ({ key: index, ...line }));
    while (filled.length < MIN_ROWS) filled.push({ key: 1000 + filled.length, ...EMPTY });
    return filled;
  });
  const [sellerKind, setSellerKind] = useState<"market" | "supplier">("market");
  const [method, setMethod] = useState<"cash" | "bank">("cash");
  const known = useMemo(() => new Map(items.map((item) => [item.code.toLowerCase(), item])), [items]);
  const find = (code: string) => known.get(code.trim().toLowerCase());
  const set = (key: number, change: Partial<Row>) => setRows((all) => all.map((row) => (row.key === key ? { ...row, ...change } : row)));
  const total = rows.reduce((sum, row) => sum.plus(lineAmount(row) ?? 0), new Decimal(0));
  const payFrom = accounts.filter((account) => account.kind === method);

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
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
        data.set("clientKey", clientKey);
        setRows(() => {
          const kept = [...filled];
          while (kept.length < MIN_ROWS) kept.push({ key: (nextKey.current += 1), ...EMPTY });
          return kept;
        });
        run(data);
      }}
      className="flex flex-col gap-4"
    >
      <div className="grid gap-4 sm:grid-cols-[10rem_1fr]">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="date">Bought on</Label>
          <Input id="date" name="date" type="date" defaultValue={initial.date} max={initial.date} required />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="warehouseId">Warehouse the goods came into</Label>
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

      <fieldset className="flex flex-col gap-3 rounded-lg border px-3 py-3">
        <legend className="px-1 text-sm font-medium">Bought from</legend>
        <div className="flex flex-wrap gap-4 text-sm">
          <label className="flex items-center gap-2">
            <input type="radio" name="sellerKind" value="market" checked={sellerKind === "market"} onChange={() => setSellerKind("market")} />A seller in the market, not on your list
          </label>
          <label className="flex items-center gap-2">
            <input type="radio" name="sellerKind" value="supplier" checked={sellerKind === "supplier"} onChange={() => setSellerKind("supplier")} disabled={suppliers.length === 0} />A supplier on your list
          </label>
        </div>
        <div className="grid max-w-3xl gap-4 sm:grid-cols-3">
          {sellerKind === "market" ? (
            <>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="sellerName">Seller&apos;s or shop&apos;s name</Label>
                <Input id="sellerName" name="sellerName" maxLength={120} autoComplete="off" required />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="sellerPhone">Phone (if they give it)</Label>
                <Input id="sellerPhone" name="sellerPhone" maxLength={20} autoComplete="off" inputMode="tel" />
              </div>
            </>
          ) : (
            <div className="flex flex-col gap-1.5 sm:col-span-2">
              <Label htmlFor="supplierId">Supplier</Label>
              <select id="supplierId" name="supplierId" defaultValue="" required className={SELECT}>
                <option value="">Choose a supplier</option>
                {suppliers.map((supplier) => (
                  <option key={supplier.id} value={supplier.id}>
                    {supplier.label}
                  </option>
                ))}
              </select>
            </div>
          )}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="memoNo">Cash memo or bill no. (if any)</Label>
            <Input id="memoNo" name="memoNo" maxLength={40} autoComplete="off" />
          </div>
        </div>
      </fieldset>

      <datalist id="market-item-codes">
        {items.map((item) => (
          <option key={item.id} value={item.code}>
            {item.name}
          </option>
        ))}
      </datalist>
      <div className="overflow-x-auto">
        <table aria-label="What was bought" className="w-full min-w-[760px] text-left text-sm">
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
                    <Input aria-label={`Item code, line ${index + 1}`} list="market-item-codes" value={row.itemCode} onChange={(event) => set(row.key, { itemCode: event.target.value, unitId: "" })} maxLength={30} autoComplete="off" />
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
                Paid in all
              </td>
              <td className="py-2 pr-2 text-right font-semibold tabular-nums" data-testid="purchase-total">
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
      <p className="text-sm text-muted-foreground" data-testid="tax-note">
        Enter what one cost, as it was paid. The goods come into stock at this cost. {taxNote}
      </p>

      <fieldset className="flex flex-col gap-3 rounded-lg border px-3 py-3">
        <legend className="px-1 text-sm font-medium">Paid now, in full</legend>
        <div className="flex flex-wrap gap-4 text-sm">
          <label className="flex items-center gap-2">
            <input type="radio" name="method" value="cash" checked={method === "cash"} onChange={() => setMethod("cash")} />
            Cash
          </label>
          <label className="flex items-center gap-2">
            <input type="radio" name="method" value="bank" checked={method === "bank"} onChange={() => setMethod("bank")} />
            From a bank account (transfer, cheque or card)
          </label>
        </div>
        <div className="grid max-w-3xl gap-4 sm:grid-cols-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="accountId">{method === "cash" ? "Cash account" : "Bank account"}</Label>
            <select id="accountId" name="accountId" key={method} defaultValue={payFrom[0]?.id ?? ""} required className={SELECT}>
              {payFrom.length === 0 ? <option value="">No {method === "cash" ? "cash" : "bank"} account yet</option> : null}
              {payFrom.map((account) => (
                <option key={account.id} value={account.id}>
                  {account.label}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="reference">Reference (cheque or slip no.)</Label>
            <Input id="reference" name="reference" maxLength={60} autoComplete="off" />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="note">Note</Label>
            <Input id="note" name="note" maxLength={300} autoComplete="off" />
          </div>
        </div>
      </fieldset>

      {state.error ? (
        <p role="alert" data-testid="form-error" className="text-sm text-destructive">
          {state.error}
        </p>
      ) : null}
      <div>
        <Button type="submit" disabled={!ready || busy}>
          {busy ? "Working…" : "Record the purchase and the payment"}
        </Button>
      </div>
    </form>
  );
}

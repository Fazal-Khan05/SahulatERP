"use client";

import Decimal from "decimal.js";
import { useRef, useState } from "react";
import { useFormAction, type FormAction } from "@/components/action-form";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatAmount } from "@/lib/money";
import type { SalesFormState } from "./actions";
import { Picker, type Choice } from "./picker";

type Unit = { id: string; code: string; factor: string };
type Row = {
  key: number;
  item: Choice | null;
  name: string;
  units: Unit[];
  unitId: string;
  quantity: string;
  unitPrice: string;
  /** True once the price is the user's own: it is then sent as typed and never replaced. */
  priceTyped: boolean;
  /** The price lists' price of one of the item's own unit for the chosen customer. */
  listPrice: string | null;
  discountPercent: string;
};
type ShareRow = { key: number; userId: string; percent: string };
type Credit = { limit: string | null; receivable: string; openOrders: string };

export type SalesFormProps = {
  action: FormAction<SalesFormState>;
  kind: "quotation" | "order";
  /** Whether the company charges sales tax, and whether its prices already hold it. */
  taxed: boolean;
  pricesIncludeTax: boolean;
  warehouses: { id: string; name: string }[];
  salesPeople: { userId: string; email: string }[];
  /** The document being changed, so its own total is left out of the customer's other orders. */
  documentId: string | null;
  initial: {
    date: string;
    validUntil: string;
    customer: Choice | null;
    warehouseId: string;
    customerReference: string;
    notes: string;
    furtherTaxExcluded: boolean;
    /** `priceTyped` is false for a line saved at the price lists' own price: it follows the lists again when its unit changes. */
    lines: { item: Choice; name: string; units: Unit[]; unitId: string; quantity: string; unitPrice: string; priceTyped: boolean; listPrice: string | null; discountPercent: string }[];
    shares: { userId: string; percent: string }[];
  };
  credit: Credit | null;
  /** Shown once, when a new document was saved as a draft but could not be submitted. */
  refused?: string;
  /** True when the owner must give a reason to submit this order over the credit limit. */
  needsReason?: boolean;
};

const SELECT = "h-8 w-full min-w-0 rounded-lg border border-input bg-card px-2 text-sm";
const NIL = new Decimal(0);
const plain = (text: string) => (/^\d+(\.\d+)?$/.test(text.trim()) ? new Decimal(text.trim()) : null);
const paisa = (amount: Decimal) => amount.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
const tidy = (amount: Decimal) => amount.toDecimalPlaces(4, Decimal.ROUND_HALF_UP).toFixed();

/** What a row comes to before tax: the quantity at the price, less the discount. A guide only. */
function rowAmount(row: Row): Decimal {
  const quantity = plain(row.quantity);
  const price = plain(row.unitPrice);
  if (quantity === null || price === null) return NIL;
  const gross = paisa(quantity.times(price));
  const percent = plain(row.discountPercent);
  return percent === null || percent.gt(100) ? gross : gross.minus(paisa(gross.times(percent).div(100)));
}

async function fetchJson<T>(url: string): Promise<T | null> {
  try {
    const response = await fetch(url, { cache: "no-store" });
    return response.ok ? ((await response.json()) as T) : null;
  } catch {
    return null;
  }
}

type LineDefaults = { itemId: string; code: string; name: string; units: Unit[]; listPrice: string | null };

/**
 * The one form for a quotation and a sales order: customer, date, and a grid of lines. An item
 * is found by typing its code or name; its price comes from the customer's price lists and can
 * be typed over. The amounts here are a guide: the server works every line out again, with tax.
 */
export function SalesForm({ action, kind, taxed, pricesIncludeTax, warehouses, salesPeople, documentId, initial, credit: initialCredit, refused, needsReason }: SalesFormProps) {
  const { state, ready, busy, run } = useFormAction(action);
  const nextKey = useRef(initial.lines.length + 10);
  const empty = (): Row => ({ key: (nextKey.current += 1), item: null, name: "", units: [], unitId: "", quantity: "", unitPrice: "", priceTyped: false, listPrice: null, discountPercent: "" });
  const [customer, setCustomer] = useState<Choice | null>(initial.customer);
  const [date, setDate] = useState(initial.date);
  const [credit, setCredit] = useState<Credit | null>(initialCredit);
  const [rows, setRows] = useState<Row[]>(() => [...initial.lines.map((line, index) => ({ key: index, ...line })), { key: initial.lines.length + 5, item: null, name: "", units: [], unitId: "", quantity: "", unitPrice: "", priceTyped: false, listPrice: null, discountPercent: "" }]);
  const [shares, setShares] = useState<ShareRow[]>(() => initial.shares.map((share, index) => ({ key: index, ...share })));
  const set = (key: number, change: Partial<Row>) => setRows((all) => all.map((row) => (row.key === key ? { ...row, ...change } : row)));
  const total = rows.reduce((sum, row) => sum.plus(rowAmount(row)), NIL);
  const askReason = state.needsReason ?? needsReason ?? false;
  const error = state.error ?? (state.message ? undefined : refused);
  const word = kind === "order" ? "order" : "quotation";

  /** The price of one of a unit, from the price of one of the item's own unit. */
  const priceFor = (listPrice: string | null, units: Unit[], unitId: string) => {
    const factor = units.find((unit) => unit.id === unitId)?.factor;
    return listPrice === null || factor === undefined ? "" : tidy(new Decimal(listPrice).times(factor));
  };

  const loadLine = async (key: number, item: Choice, forCustomer: Choice | null, onDate: string) => {
    const found = await fetchJson<{ line: LineDefaults | null }>(`/sales/lookup?what=line&item=${item.id}&customer=${forCustomer?.id ?? ""}&date=${onDate}`);
    const line = found?.line;
    if (!line) return;
    setRows((all) =>
      all.map((row) => {
        if (row.key !== key || row.item?.id !== item.id) return row;
        const unitId = row.units.length > 0 && line.units.some((unit) => unit.id === row.unitId) ? row.unitId : line.units[0].id;
        return { ...row, name: line.name, units: line.units, unitId, listPrice: line.listPrice, unitPrice: row.priceTyped ? row.unitPrice : priceFor(line.listPrice, line.units, unitId) };
      }),
    );
  };

  const pickItem = (key: number, item: Choice | null) => {
    setRows((all) => {
      // A different item starts from its own price: what was typed for the last one does not carry over.
      const changed = all.map((row) => (row.key === key ? { ...row, item, name: item?.sub ?? "", units: [], unitId: "", listPrice: null, unitPrice: "", priceTyped: false } : row));
      // There is always one empty row at the end to type the next item into.
      return item !== null && changed[changed.length - 1].item !== null ? [...changed, empty()] : changed;
    });
    if (item) void loadLine(key, item, customer, date);
  };

  const pickCustomer = (choice: Choice | null) => {
    setCustomer(choice);
    setCredit(null);
    if (!choice) return;
    // The customer decides the prices: every line whose price was not typed is priced again.
    for (const row of rows) if (row.item && !row.priceTyped) void loadLine(row.key, row.item, choice, date);
    if (kind === "order") {
      void fetchJson<{ credit: Credit | null }>(`/sales/lookup?what=credit&customer=${choice.id}&except=${documentId ?? ""}`).then((found) => setCredit(found?.credit ?? null));
    }
  };

  const owed = credit ? new Decimal(credit.receivable).plus(credit.openOrders) : NIL;
  const room = credit?.limit != null ? new Decimal(credit.limit).minus(owed) : null;

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        const submitter = (event.nativeEvent as SubmitEvent).submitter;
        const data = new FormData();
        const typed = new FormData(event.currentTarget);
        for (const name of ["date", "validUntil", "warehouseId", "customerReference", "notes", "furtherTaxExcluded", "reason"]) {
          const value = typed.get(name);
          if (typeof value === "string") data.set(name, value);
        }
        data.set("customerId", customer?.id ?? "");
        data.set("intent", submitter instanceof HTMLButtonElement && submitter.value === "submit" ? "submit" : "save");
        // Rows with nothing in them are not sent, so "Line 2" in a message is the second line on the screen.
        const filled = rows.filter((row) => row.item !== null || row.quantity.trim() !== "" || row.unitPrice.trim() !== "" || row.discountPercent.trim() !== "");
        for (const row of filled) {
          data.append("itemId", row.item?.id ?? "");
          data.append("unitId", row.unitId);
          data.append("quantity", row.quantity);
          // A price that was not typed is left for the server to take from the price lists.
          data.append("unitPrice", row.priceTyped ? row.unitPrice : "");
          data.append("discountPercent", row.discountPercent);
        }
        for (const share of shares) {
          data.append("shareUserId", share.userId);
          data.append("sharePercent", share.percent);
        }
        setRows([...filled, empty()]);
        run(data);
      }}
      className="flex flex-col gap-4"
    >
      <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_10rem_10rem]">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="customer">Customer</Label>
          <Picker id="customer" what="customers" label="Customer" value={customer} onPick={pickCustomer} placeholder="Type a name or code" />
          {credit && credit.limit !== null ? (
            <p className="text-xs text-muted-foreground" data-testid="credit-note">
              Credit limit {formatAmount(new Decimal(credit.limit))}. Owes {formatAmount(new Decimal(credit.receivable))}
              {new Decimal(credit.openOrders).isZero() ? "" : `, ${formatAmount(new Decimal(credit.openOrders))} in other orders`}.{" "}
              {room !== null && room.gt(0) ? `Room for ${formatAmount(room)} more.` : "No room left: an order needs the owner's approval."}
            </p>
          ) : null}
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="date">Date</Label>
          <Input
            id="date"
            name="date"
            type="date"
            value={date}
            onChange={(event) => {
              setDate(event.target.value);
              // Prices are dated: lines whose price was not typed are priced for the new date.
              for (const row of rows) if (row.item && !row.priceTyped && customer) void loadLine(row.key, row.item, customer, event.target.value);
            }}
            required
          />
        </div>
        {kind === "quotation" ? (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="validUntil">Valid until</Label>
            <Input id="validUntil" name="validUntil" type="date" defaultValue={initial.validUntil} min={date} />
          </div>
        ) : (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="customerReference">Customer&apos;s order no.</Label>
            <Input id="customerReference" name="customerReference" defaultValue={initial.customerReference} maxLength={60} autoComplete="off" />
          </div>
        )}
      </div>
      {warehouses.length > 1 ? (
        <div className="flex max-w-xs flex-col gap-1.5">
          <Label htmlFor="warehouseId">Goods leave from</Label>
          <select id="warehouseId" name="warehouseId" defaultValue={initial.warehouseId} required className={SELECT}>
            {warehouses.map((warehouse) => (
              <option key={warehouse.id} value={warehouse.id}>
                {warehouse.name}
              </option>
            ))}
          </select>
        </div>
      ) : (
        <input type="hidden" name="warehouseId" value={warehouses[0]?.id ?? initial.warehouseId} />
      )}

      <div className="overflow-x-auto pb-1">
        <table aria-label="Lines" className="w-full min-w-[720px] text-left text-sm">
          <thead className="border-b text-muted-foreground">
            <tr>
              <th className="w-40 py-2 pr-2 font-medium">Item</th>
              <th className="py-2 pr-2 font-medium">Description</th>
              <th className="w-24 py-2 pr-2 text-right font-medium">Quantity</th>
              <th className="w-20 py-2 pr-2 font-medium">Unit</th>
              <th className="w-28 py-2 pr-2 text-right font-medium">Price</th>
              <th className="w-20 py-2 pr-2 text-right font-medium">Disc. %</th>
              <th className="w-28 py-2 pr-2 text-right font-medium">Amount</th>
              <th className="w-8 py-2" />
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => {
              const listed = priceFor(row.listPrice, row.units, row.unitId);
              const changed = row.item !== null && row.priceTyped && listed !== "" && plain(row.unitPrice) !== null && !new Decimal(listed).eq(plain(row.unitPrice)!);
              return (
                <tr key={row.key} className="align-top">
                  <td className="py-1 pr-2">
                    <Picker what="items" label={`Item, line ${index + 1}`} value={row.item} onPick={(item) => pickItem(row.key, item)} placeholder="Code or name" />
                  </td>
                  <td className="py-1 pr-2">
                    <p className="flex min-h-8 items-center" data-testid={`line-name-${index + 1}`}>
                      {row.name}
                    </p>
                  </td>
                  <td className="py-1 pr-2">
                    <Input aria-label={`Quantity, line ${index + 1}`} value={row.quantity} onChange={(event) => set(row.key, { quantity: event.target.value })} inputMode="decimal" autoComplete="off" className="text-right tabular-nums" />
                  </td>
                  <td className="py-1 pr-2">
                    {row.units.length > 1 ? (
                      <select
                        aria-label={`Unit, line ${index + 1}`}
                        value={row.unitId}
                        onChange={(event) => set(row.key, { unitId: event.target.value, unitPrice: row.priceTyped ? row.unitPrice : priceFor(row.listPrice, row.units, event.target.value) })}
                        className={SELECT}
                      >
                        {row.units.map((unit) => (
                          <option key={unit.id} value={unit.id}>
                            {unit.code}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <p className="flex min-h-8 items-center text-muted-foreground">{row.units[0]?.code ?? ""}</p>
                    )}
                  </td>
                  <td className="py-1 pr-2">
                    <Input
                      aria-label={`Price, line ${index + 1}`}
                      value={row.unitPrice}
                      onChange={(event) => set(row.key, { unitPrice: event.target.value, priceTyped: event.target.value.trim() !== "" })}
                      onBlur={() => {
                        // Emptied: the price lists' price comes back.
                        if (row.unitPrice.trim() === "") set(row.key, { priceTyped: false, unitPrice: listed });
                      }}
                      inputMode="decimal"
                      autoComplete="off"
                      className="text-right tabular-nums"
                    />
                    {changed ? <p className="mt-0.5 text-right text-xs text-muted-foreground">List {formatAmount(new Decimal(listed))}</p> : null}
                  </td>
                  <td className="py-1 pr-2">
                    <Input aria-label={`Discount percent, line ${index + 1}`} value={row.discountPercent} onChange={(event) => set(row.key, { discountPercent: event.target.value })} inputMode="decimal" autoComplete="off" className="text-right tabular-nums" />
                  </td>
                  <td className="py-1 pr-2">
                    <p className="flex min-h-8 items-center justify-end tabular-nums" data-testid={`line-amount-${index + 1}`}>
                      {row.item ? formatAmount(rowAmount(row)) : ""}
                    </p>
                  </td>
                  <td className="py-1 text-right">
                    {row.item !== null || index < rows.length - 1 ? (
                      <Button type="button" variant="ghost" size="icon-sm" aria-label={`Remove line ${index + 1}`} onClick={() => setRows((all) => (all.length > 1 ? all.filter((other) => other.key !== row.key) : [empty()]))}>
                        ×
                      </Button>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
          <tfoot className="border-t font-medium">
            <tr>
              <td className="py-2 pr-2" colSpan={6}>
                {taxed ? (pricesIncludeTax ? "Total, sales tax included" : "Total before sales tax") : "Total"}
              </td>
              <td className="py-2 pr-2 text-right tabular-nums" data-testid="form-total">
                {formatAmount(total)}
              </td>
              <td />
            </tr>
          </tfoot>
        </table>
      </div>
      {taxed ? <p className="text-sm text-muted-foreground">Sales tax is worked out line by line when the {word} is saved.</p> : null}

      <details className="rounded-lg border px-3 py-2" open={initial.notes !== "" || initial.furtherTaxExcluded || shares.length > 1}>
        <summary className="cursor-pointer text-sm font-medium">More: notes and salespeople</summary>
        <div className="mt-3 flex flex-col gap-4">
          {kind === "quotation" ? (
            <div className="flex max-w-xs flex-col gap-1.5">
              <Label htmlFor="customerReference">Customer&apos;s reference</Label>
              <Input id="customerReference" name="customerReference" defaultValue={initial.customerReference} maxLength={60} autoComplete="off" />
            </div>
          ) : null}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="notes">Notes for the customer</Label>
            <Input id="notes" name="notes" defaultValue={initial.notes} maxLength={1000} autoComplete="off" />
          </div>
          {taxed ? (
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" name="furtherTaxExcluded" defaultChecked={initial.furtherTaxExcluded} />
              No further tax on this sale (the buyer is an end consumer, or the sale is otherwise left out by SRO 648)
            </label>
          ) : null}
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1 text-sm font-medium">Salespeople</legend>
            {shares.length === 0 ? <p className="text-sm text-muted-foreground">Nobody is credited with this sale.</p> : null}
            {shares.map((share, index) => (
              <div key={share.key} className="flex max-w-md items-center gap-2">
                <select aria-label={`Salesperson ${index + 1}`} value={share.userId} onChange={(event) => setShares((all) => all.map((other) => (other.key === share.key ? { ...other, userId: event.target.value } : other)))} className={SELECT}>
                  <option value="">Choose a person</option>
                  {salesPeople.map((person) => (
                    <option key={person.userId} value={person.userId}>
                      {person.email}
                    </option>
                  ))}
                </select>
                <Input aria-label={`Share percent ${index + 1}`} value={share.percent} onChange={(event) => setShares((all) => all.map((other) => (other.key === share.key ? { ...other, percent: event.target.value } : other)))} inputMode="decimal" autoComplete="off" className="w-20 text-right tabular-nums" />
                <span className="text-sm text-muted-foreground">%</span>
                <Button type="button" variant="ghost" size="icon-sm" aria-label={`Remove salesperson ${index + 1}`} onClick={() => setShares((all) => all.filter((other) => other.key !== share.key))}>
                  ×
                </Button>
              </div>
            ))}
            <div>
              <Button type="button" variant="outline" size="sm" onClick={() => setShares((all) => [...all, { key: (nextKey.current += 1), userId: "", percent: all.length === 0 ? "100" : "" }])}>
                Add a salesperson
              </Button>
            </div>
          </fieldset>
        </div>
      </details>

      {askReason ? (
        <div className="flex max-w-xl flex-col gap-1.5">
          <Label htmlFor="reason">Reason for approving this order over the credit limit</Label>
          <Input id="reason" name="reason" maxLength={300} autoComplete="off" autoFocus placeholder="Such as: cheque due on Monday" />
        </div>
      ) : null}
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
          {busy ? "Working…" : askReason ? `Approve and submit ${word}` : `Submit ${word}`}
        </Button>
      </div>
    </form>
  );
}

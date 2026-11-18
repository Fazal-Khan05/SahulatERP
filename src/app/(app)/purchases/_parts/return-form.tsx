"use client";

import Decimal from "decimal.js";
import { useState } from "react";
import { useFormAction, type FormAction } from "@/components/action-form";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatAmount } from "@/lib/money";
import { BillsTable, type BillRow } from "./payment-form";

/** One thing that can go back: goods of a line not yet billed, or goods one bill billed. Figures arrive as text. */
export type ReturnRow = {
  receiptLineId: string;
  billLineId: string;
  itemCode: string;
  description: string;
  unitCode: string;
  /** "Not yet billed", or the bill's number. */
  billed: string;
  available: string;
  /** What one unit is taken back at, and the sales tax on one. */
  unitValue: string;
  unitTax: string;
  quantity: string;
};

const PLAIN = /^\d+(\.\d+)?$/;
const number = (typed: string) => (PLAIN.test(typed.trim()) ? new Decimal(typed.trim()) : new Decimal(0));
const paisa = (value: Decimal) => value.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);

export type ReturnFormProps = {
  action: FormAction;
  rows: ReturnRow[];
  initial: { date: string; reason: string; supplierReference: string };
  /** Shown once, when a new return was saved as a draft but could not be posted. */
  refused?: string;
};

/**
 * The form of a return: the day the goods went back, why, and how much of each thing that can
 * go back. The totals shown are an estimate; the database works the exact figures out when the
 * return is posted. The server reads and checks everything again.
 */
export function ReturnForm({ action, rows, initial, refused }: ReturnFormProps) {
  const { state, ready, busy, run } = useFormAction(action);
  const [lines, setLines] = useState<ReturnRow[]>(rows);
  const notBilled = lines.reduce((sum, row) => (row.billLineId === "" ? sum.plus(paisa(number(row.quantity).times(row.unitValue))) : sum), new Decimal(0));
  const credit = lines.reduce((sum, row) => (row.billLineId === "" ? sum : sum.plus(paisa(number(row.quantity).times(row.unitValue))).plus(paisa(number(row.quantity).times(row.unitTax)))), new Decimal(0));
  const error = state.error ?? refused;

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        const submitter = (event.nativeEvent as SubmitEvent).submitter;
        data.set("intent", submitter instanceof HTMLButtonElement && submitter.value === "post" ? "post" : "save");
        run(data);
      }}
      className="flex flex-col gap-5"
    >
      <div className="grid gap-4 sm:grid-cols-[10rem_1fr_14rem]">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="date">Sent back on</Label>
          <Input id="date" name="date" type="date" defaultValue={initial.date} required />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="reason">Reason</Label>
          <Input id="reason" name="reason" defaultValue={initial.reason} required maxLength={300} autoComplete="off" placeholder="Such as: damaged in transit" />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="supplierReference">Supplier&apos;s credit note number</Label>
          <Input id="supplierReference" name="supplierReference" defaultValue={initial.supplierReference} maxLength={60} autoComplete="off" />
        </div>
      </div>

      <div className="overflow-x-auto">
        <table aria-label="Goods that can go back" className="w-full min-w-[760px] text-left text-sm">
          <thead className="border-b text-muted-foreground">
            <tr>
              <th className="py-2 pr-4 font-medium">Item code</th>
              <th className="py-2 pr-4 font-medium">Item</th>
              <th className="py-2 pr-4 font-medium">Billed</th>
              <th className="py-2 pr-4 text-right font-medium">Each</th>
              <th className="py-2 pr-2 text-right font-medium">Can go back</th>
              <th className="py-2 pr-4 font-medium">Unit</th>
              <th className="w-32 py-2 text-right font-medium">Going back</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {lines.map((row, index) => (
              <tr key={`${row.receiptLineId}-${row.billLineId}`}>
                <td className="py-1 pr-4 font-medium whitespace-nowrap">{row.itemCode}</td>
                <td className="py-1 pr-4">{row.description}</td>
                <td className="py-1 pr-4 whitespace-nowrap text-muted-foreground">{row.billed}</td>
                <td className="py-1 pr-4 text-right tabular-nums">{formatAmount(new Decimal(row.unitValue))}</td>
                <td className="py-1 pr-2 text-right tabular-nums" data-testid={`can-go-back-${index + 1}`}>
                  {row.available}
                </td>
                <td className="py-1 pr-4 text-muted-foreground">{row.unitCode}</td>
                <td className="py-1">
                  <input type="hidden" name="receiptLineId" value={row.receiptLineId} />
                  <input type="hidden" name="billLineId" value={row.billLineId} />
                  <Input
                    name="quantity"
                    aria-label={`Going back, row ${index + 1}`}
                    value={row.quantity}
                    onChange={(event) => setLines((all) => all.map((line, at) => (at === index ? { ...line, quantity: event.target.value } : line)))}
                    inputMode="decimal"
                    autoComplete="off"
                    className="text-right tabular-nums"
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-sm">
        Comes off goods received and not yet billed: <span className="font-semibold tabular-nums" data-testid="return-not-billed">{formatAmount(notBilled)}</span>. The supplier owes back for billed goods:{" "}
        <span className="font-semibold tabular-nums" data-testid="return-credit">{formatAmount(credit)}</span>.
      </p>

      {error ? (
        <p role="alert" data-testid="form-error" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {/* Saving comes first in the page, so pressing Enter in a field saves the draft and never posts. */}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" name="intent" value="save" variant="outline" disabled={!ready || busy} className="order-2">
          Save as draft
        </Button>
        <Button type="submit" name="intent" value="post" disabled={!ready || busy} className="order-1">
          {busy ? "Working…" : "Post return"}
        </Button>
      </div>
    </form>
  );
}

export type CreditFormProps = { action: FormAction; bills: BillRow[]; left: string; today: string };

/** Sets what is left of a posted return's credit against the supplier's unpaid bills, on a day. */
export function CreditForm({ action, bills, left, today }: CreditFormProps) {
  const { state, ready, busy, run } = useFormAction(action);
  const [rows, setRows] = useState<BillRow[]>(bills);
  const settled = rows.reduce((sum, row) => sum.plus(number(row.amount)), new Decimal(0));
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        run(new FormData(event.currentTarget));
      }}
      className="flex flex-col gap-4"
    >
      <div className="flex max-w-[10rem] flex-col gap-1.5">
        <Label htmlFor="credit-date">Set against the bills on</Label>
        <Input id="credit-date" name="date" type="date" defaultValue={today} required />
      </div>
      <BillsTable bills={rows} heading="Taken off" onChange={(billId, value) => setRows((all) => all.map((row) => (row.billId === billId ? { ...row, amount: value } : row)))} />
      <p className="text-sm">
        Set against bills: <span className="font-semibold tabular-nums">{formatAmount(settled)}</span> of the <span className="tabular-nums">{formatAmount(new Decimal(left))}</span> that is left.
      </p>
      {state.error ? (
        <p role="alert" data-testid="credit-error" className="text-sm text-destructive">
          {state.error}
        </p>
      ) : null}
      <Button type="submit" disabled={!ready || busy} className="self-start">
        {busy ? "Working…" : "Set the credit against these bills"}
      </Button>
    </form>
  );
}

"use client";

import Decimal from "decimal.js";
import { useEffect, useRef, useState } from "react";
import { useFormAction, type FormAction } from "@/components/action-form";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { formatAmount } from "@/lib/money";

type Choice = { id: string; label: string };

const SELECT = "h-8 w-full min-w-0 rounded-lg border border-input bg-card px-2 text-sm";

export type ChargeFormProps = {
  action: FormAction;
  /** Bill lines charged to Goods in transit that are on no shipment yet; amounts arrive as text. */
  billLines: { billLineId: string; label: string; amount: string }[];
  classes: Choice[];
  bases: Choice[];
  depositAccounts: Choice[];
  expenseAccounts: Choice[];
};

/**
 * Puts a charge on a shipment: the bill line it was billed on, and what kind of charge it is.
 * A charge that is part of what the goods cost also says what it is spread by; a deposit or an
 * expense says which account it goes to. The server reads and checks everything again.
 */
export function ChargeForm({ action, billLines, classes, bases, depositAccounts, expenseAccounts }: ChargeFormProps) {
  const { state, ready, busy, run } = useFormAction(action);
  const [line, setLine] = useState("");
  const [kind, setKind] = useState("inventory");
  // The two lists keep their own value, so a choice made before this code was ready is not lost;
  // what follows from the choice is brought up to date as soon as it is.
  const lineSelect = useRef<HTMLSelectElement>(null);
  const kindSelect = useRef<HTMLSelectElement>(null);
  useEffect(() => {
    if (lineSelect.current) setLine(lineSelect.current.value);
    if (kindSelect.current) setKind(kindSelect.current.value);
  }, []);
  const chosen = billLines.find((row) => row.billLineId === line);
  const accounts = kind === "deposit" ? depositAccounts : kind === "expense" ? expenseAccounts : [];
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        run(new FormData(event.currentTarget));
      }}
      className="flex flex-col gap-4"
    >
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="billLineId">Bill line</Label>
        <select id="billLineId" name="billLineId" ref={lineSelect} defaultValue="" onChange={(event) => setLine(event.target.value)} required className={SELECT}>
          <option value="">Choose a bill line charged to Goods in transit</option>
          {billLines.map((row) => (
            <option key={row.billLineId} value={row.billLineId}>
              {row.label} ({formatAmount(new Decimal(row.amount))})
            </option>
          ))}
        </select>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="class">What kind of charge</Label>
          <select id="class" name="class" ref={kindSelect} defaultValue="inventory" onChange={(event) => setKind(event.target.value)} required className={SELECT}>
            {classes.map((row) => (
              <option key={row.id} value={row.id}>
                {row.label}
              </option>
            ))}
          </select>
        </div>
        {kind === "inventory" ? (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="basis">Spread over the goods</Label>
            <select id="basis" name="basis" defaultValue="value" required className={SELECT}>
              {bases.map((row) => (
                <option key={row.id} value={row.id}>
                  {row.label}
                </option>
              ))}
            </select>
          </div>
        ) : accounts.length > 0 || kind === "deposit" || kind === "expense" ? (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="accountId">{kind === "deposit" ? "Held in (asset account)" : "Goes to (expense account)"}</Label>
            <select id="accountId" name="accountId" defaultValue="" required className={SELECT} key={kind}>
              <option value="">Choose an account</option>
              {accounts.map((row) => (
                <option key={row.id} value={row.id}>
                  {row.label}
                </option>
              ))}
            </select>
          </div>
        ) : null}
      </div>
      {chosen ? (
        <p className="text-sm text-muted-foreground">
          The bill charged <span className="tabular-nums">{formatAmount(new Decimal(chosen.amount))}</span> to Goods in transit for this line. All of it goes on the shipment.
        </p>
      ) : null}
      {state.error ? (
        <p role="alert" data-testid="charge-error" className="text-sm text-destructive">
          {state.error}
        </p>
      ) : null}
      <Button type="submit" disabled={!ready || busy} className="self-start">
        {busy ? "Working…" : "Put the charge on the shipment"}
      </Button>
    </form>
  );
}

"use client";

import { useState } from "react";
import { Field } from "@/components/field";
import { Label } from "@/components/ui/label";
import { PLAN_KINDS, PLAN_KIND_LABELS, type PlanKind } from "@/modules/commissions/rules";

const SELECT = "h-8 w-full min-w-0 rounded-lg border border-input bg-card px-2 text-sm";
const ROWS = 6;

export type PlanInitial = {
  name: string;
  userId: string;
  kind: PlanKind;
  rate: string;
  target: string;
  multiplier: string;
  teamRate: string;
  from: string;
  to: string;
  categoryRates: { categoryId: string; rate: string }[];
  classRates: { customerClass: string; rate: string }[];
  tiers: { threshold: string; rate: string }[];
};

/** Rows typed so far, then empty rows up to ROWS. */
const fill = <T,>(rows: T[], empty: T): T[] => [...rows, ...Array.from({ length: Math.max(ROWS - rows.length, 1) }, () => empty)];

/**
 * The fields of a commission plan. The kind decides which rates are asked for; the rest of the
 * plan (target, multiplier, team rate, dates) is the same for every kind.
 */
export function PlanFields({ initial, people, categories, classes }: { initial: PlanInitial; people: { userId: string; label: string }[]; categories: { id: string; name: string }[]; classes: string[] }) {
  const [kind, setKind] = useState<PlanKind>(initial.kind);
  return (
    <div className="flex flex-col gap-5">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Name of the plan" name="name" defaultValue={initial.name} required maxLength={100} autoComplete="off" />
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="userId">Who it is for</Label>
          <select id="userId" name="userId" defaultValue={initial.userId} className={SELECT}>
            <option value="">Everyone without a plan of their own (the default plan)</option>
            {people.map((person) => (
              <option key={person.userId} value={person.userId}>
                {person.label}
              </option>
            ))}
          </select>
        </div>
        <Field label="From" name="from" type="date" defaultValue={initial.from} required />
        <Field label="Until (empty for no end)" name="to" type="date" defaultValue={initial.to} />
      </div>

      <div className="flex flex-col gap-1.5 sm:max-w-sm">
        <Label htmlFor="kind">How it pays</Label>
        <select id="kind" name="kind" value={kind} onChange={(event) => setKind(event.target.value as PlanKind)} className={SELECT}>
          {PLAN_KINDS.map((option) => (
            <option key={option} value={option}>
              {PLAN_KIND_LABELS[option]}
            </option>
          ))}
        </select>
      </div>

      {kind !== "tiered" ? (
        <Field
          label={kind === "per_unit" ? "Rupees for each unit sold" : kind === "flat" ? "Rate, % of sales before tax" : "Rate for anything not listed below, %"}
          name="rate"
          inputMode="decimal"
          defaultValue={initial.rate}
          required
          autoComplete="off"
          className="sm:max-w-xs"
        />
      ) : (
        <input type="hidden" name="rate" value="0" />
      )}

      {kind === "category" ? (
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-sm font-semibold">Rates by item category</legend>
          {fill(initial.categoryRates, { categoryId: "", rate: "" }).map((row, at) => (
            <div key={at} className="flex gap-2">
              <select name="categoryId" defaultValue={row.categoryId} aria-label={`Category ${at + 1}`} className={`${SELECT} max-w-xs`}>
                <option value="">Choose a category</option>
                {categories.map((category) => (
                  <option key={category.id} value={category.id}>
                    {category.name}
                  </option>
                ))}
              </select>
              <input name="categoryRate" defaultValue={row.rate} inputMode="decimal" aria-label={`Rate for category ${at + 1}, %`} placeholder="%" className={`${SELECT} max-w-24`} />
            </div>
          ))}
        </fieldset>
      ) : null}

      {kind === "customer_class" ? (
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-sm font-semibold">Rates by customer class</legend>
          <datalist id="customer-classes">
            {classes.map((name) => (
              <option key={name} value={name} />
            ))}
          </datalist>
          {fill(initial.classRates, { customerClass: "", rate: "" }).map((row, at) => (
            <div key={at} className="flex gap-2">
              <input name="customerClass" list="customer-classes" defaultValue={row.customerClass} aria-label={`Customer class ${at + 1}`} placeholder="Such as: Wholesaler" maxLength={40} className={`${SELECT} max-w-xs`} />
              <input name="classRate" defaultValue={row.rate} inputMode="decimal" aria-label={`Rate for class ${at + 1}, %`} placeholder="%" className={`${SELECT} max-w-24`} />
            </div>
          ))}
        </fieldset>
      ) : null}

      {kind === "tiered" ? (
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-sm font-semibold">Slabs on the salesperson&apos;s sales in the month</legend>
          {fill(initial.tiers, { threshold: "", rate: "" }).map((row, at) => (
            <div key={at} className="flex items-center gap-2 text-sm">
              <span className="text-muted-foreground">From</span>
              <input name="tierFrom" defaultValue={row.threshold} inputMode="decimal" aria-label={`Slab ${at + 1} starts at`} placeholder={at === 0 ? "0" : "Amount"} className={`${SELECT} max-w-40`} />
              <input name="tierRate" defaultValue={row.rate} inputMode="decimal" aria-label={`Slab ${at + 1} rate, %`} placeholder="%" className={`${SELECT} max-w-24`} />
            </div>
          ))}
        </fieldset>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="Monthly target (0 for none)" name="target" inputMode="decimal" defaultValue={initial.target} autoComplete="off" hint="From the sale that reaches it, commission is multiplied." />
        <Field label="Multiplier once reached" name="multiplier" inputMode="decimal" defaultValue={initial.multiplier} autoComplete="off" />
        <Field label="Team rate, % of the team's sales" name="teamRate" inputMode="decimal" defaultValue={initial.teamRate} autoComplete="off" hint="What a manager on this plan earns on sales by everyone under them." />
      </div>
    </div>
  );
}

import { readChallan, type ChallanDraft, type RawChallan } from "@/modules/supplier-payments/rules";

// A challan that pays more than the tax withheld on supplier bills: tax withheld on expenses
// too, and the income tax payroll runs deducted from pay. What is typed is a challan's
// (src/modules/supplier-payments/rules.ts) with two more lists of what was ticked. No I/O.

export type RawTaxChallan = RawChallan & { expenseEntryIds?: readonly unknown[]; runIds?: readonly unknown[] };
export type TaxChallanDraft = ChallanDraft & { expenseEntryIds: string[]; runIds: string[] };

const ids = (list: readonly unknown[] | undefined) => [...new Set((list ?? []).map((id) => (typeof id === "string" ? id.trim() : "")).filter((id) => id !== ""))];

/** Cleans what was typed for a challan and what was ticked for it, of every kind. */
export function readTaxChallan(raw: RawTaxChallan): { ok: true; challan: TaxChallanDraft } | { ok: false; reason: string } {
  const expenseEntryIds = ids(raw.expenseEntryIds);
  const runIds = ids(raw.runIds);
  const billEntryIds = ids(raw.entryIds);
  // The challan's own fields are read as a challan's always are; it asks for something ticked, of any of the three.
  const read = readChallan({ ...raw, entryIds: billEntryIds.length > 0 ? billEntryIds : [...expenseEntryIds, ...runIds].slice(0, 1) });
  if (!read.ok) return read;
  if (billEntryIds.length + expenseEntryIds.length + runIds.length > 500) return { ok: false, reason: "A challan can pay at most 500 amounts at once." };
  if (runIds.length > 0 && read.challan.kind !== "income_tax") return { ok: false, reason: "Tax deducted from salaries is income tax: choose Income tax for this challan, or untick the salaries." };
  return { ok: true, challan: { ...read.challan, entryIds: billEntryIds, expenseEntryIds, runIds } };
}

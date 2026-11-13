import Decimal from "decimal.js";
import { parseAmount } from "@/lib/money";
import { cleanText } from "@/lib/text";
import { isIsoDate } from "@/modules/currencies/rules";

// Pure rules for manual journals. No I/O.
//
// A manual journal is typed as a date, a reason and a list of lines, each a debit or a credit to
// one account. A draft may be unfinished: it need not balance. Whether the lines can be posted
// is the posting engine's question (ledger/rules.ts, checkJournalLines).

export const MANUAL_JOURNAL_STATUSES = ["draft", "posted", "reversed"] as const;
export type ManualJournalStatus = (typeof MANUAL_JOURNAL_STATUSES)[number];
export const STATUS_LABELS: Record<ManualJournalStatus, string> = { draft: "Draft", posted: "Posted", reversed: "Reversed" };

/** A draft can hold this many lines; the screen is for entries typed by hand. */
export const MAX_DRAFT_LINES = 200;

export type DraftLine = { accountId: string; description: string | null; debit: Decimal; credit: Decimal };
export type Draft = { date: string; memo: string; branchId: string | null; lines: DraftLine[] };

export type RawDraft = {
  date?: unknown;
  memo?: unknown;
  branchId?: unknown;
  /** One entry per row of the form, in order; rows left wholly empty are skipped and not counted. */
  lines?: readonly { accountId?: unknown; description?: unknown; debit?: unknown; credit?: unknown }[];
};

const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");

/** Cleans what was typed for a manual journal, or gives the first thing that is wrong in plain words. */
export function readDraft(raw: RawDraft): { ok: true; draft: Draft } | { ok: false; reason: string } {
  if (!isIsoDate(raw.date)) return { ok: false, reason: "Enter the date of the journal." };
  const memo = cleanText(raw.memo);
  if (memo === "") return { ok: false, reason: "Say what the journal is for." };
  if (memo.length > 500) return { ok: false, reason: "What the journal is for: use at most 500 characters." };
  const branchId = text(raw.branchId) === "" ? null : text(raw.branchId);

  const lines: DraftLine[] = [];
  for (const row of raw.lines ?? []) {
    const accountId = text(row.accountId);
    const description = cleanText(row.description);
    const debitText = text(row.debit);
    const creditText = text(row.credit);
    if (accountId === "" && description === "" && debitText === "" && creditText === "") continue;
    // Lines are numbered as they will be kept, empty rows left out; the form closes up the same way.
    const at = `Line ${lines.length + 1}`;
    if (accountId === "") return { ok: false, reason: `${at}: choose an account.` };
    if (description.length > 300) return { ok: false, reason: `${at}: use at most 300 characters for the description.` };
    let debit = new Decimal(0);
    let credit = new Decimal(0);
    if (debitText !== "") {
      const parsed = parseAmount(debitText);
      if (!parsed.ok) return { ok: false, reason: `${at}, debit: ${parsed.reason}` };
      debit = parsed.amount;
    }
    if (creditText !== "") {
      const parsed = parseAmount(creditText);
      if (!parsed.ok) return { ok: false, reason: `${at}, credit: ${parsed.reason}` };
      credit = parsed.amount;
    }
    if (debit.isZero() && credit.isZero()) return { ok: false, reason: `${at}: enter a debit or a credit.` };
    if (!debit.isZero() && !credit.isZero()) return { ok: false, reason: `${at}: enter a debit or a credit, not both.` };
    lines.push({ accountId, description: description === "" ? null : description, debit, credit });
  }
  if (lines.length > MAX_DRAFT_LINES) return { ok: false, reason: `A manual journal can have at most ${MAX_DRAFT_LINES} lines.` };
  return { ok: true, draft: { date: raw.date, memo, branchId, lines } };
}

/** The debit and credit totals of a set of lines, and what is still missing to balance them. */
export function draftTotals(lines: readonly Pick<DraftLine, "debit" | "credit">[]): { debit: Decimal; credit: Decimal; difference: Decimal } {
  const debit = lines.reduce((sum, line) => sum.plus(line.debit), new Decimal(0));
  const credit = lines.reduce((sum, line) => sum.plus(line.credit), new Decimal(0));
  return { debit, credit, difference: debit.minus(credit) };
}

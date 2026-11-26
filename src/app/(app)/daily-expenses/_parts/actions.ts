"use server";

import { randomUUID } from "node:crypto";
import { refresh } from "next/cache";
import { requireTenant } from "@/lib/auth/session";
import { UserError, logFailure } from "@/lib/errors";
import type { FormState } from "@/lib/form-state";
import { formatAmount } from "@/lib/money";
import { objectStore } from "@/lib/storage";
import Decimal from "decimal.js";
import { formatIsoDate } from "@/modules/currencies/rules";
import { listReceipts } from "@/modules/daily-expenses/queries";
import { attachReceipt, MAX_SHEET_BYTES, previewExpenseSheet, readExpenseSheetFile, readReceipt, recordDailyExpense, recordExpenseSheet } from "@/modules/daily-expenses/commands";
import type { SheetCells } from "@/modules/daily-expenses/rules";
import { FILE_MAX_BYTES } from "@/modules/files/rules";

// Daily expenses. The company always comes from the verified session, never from the form; ids
// arrive bound to the action or in the form and are checked again in the command and by the
// database.

async function requireCashBankModule() {
  const session = await requireTenant();
  if (!session.modules.cash_bank) throw new UserError("Cash and bank is switched off for this company.");
  return session;
}

function refusal(context: string, error: unknown): FormState {
  if (error instanceof UserError) return { error: error.message };
  logFailure(context, error);
  return { error: "That did not work. Please try again." };
}

const chosen = (value: FormDataEntryValue | null) => (value instanceof File && value.size > 0 ? value : null);
const TOO_LARGE = "The receipt must be 4 MB or smaller.";

/** Records one expense from the quick form, and keeps its receipt when one was chosen. */
export async function addDailyExpenseAction(_: FormState, formData: FormData): Promise<FormState> {
  const file = chosen(formData.get("receipt"));
  if (file && file.size > FILE_MAX_BYTES) return { error: TOO_LARGE };
  let number: string;
  let kept = "";
  try {
    const session = await requireCashBankModule();
    // A file that cannot be a receipt is refused before anything is recorded.
    const receipt = file ? { name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) } : null;
    if (receipt) readReceipt(receipt);
    const recorded = await recordDailyExpense(session, {
      date: formData.get("date"),
      whatForId: formData.get("whatForId"),
      amount: formData.get("amount"),
      paidFromId: formData.get("paidFromId"),
      paidTo: formData.get("paidTo"),
      note: formData.get("note"),
      branchId: formData.get("branchId"),
      clientKey: formData.get("clientKey"),
    });
    number = recorded.number;
    if (receipt) {
      // The expense is in the books whatever happens to its receipt: say so, and how to add it.
      try {
        // Sent again after an answer that never arrived: the receipt kept the first time is not kept twice.
        const already = (await listReceipts(session, recorded.id)).some((r) => r.sizeBytes === receipt.bytes.length);
        if (!already) await attachReceipt(session, await objectStore(), recorded.id, receipt);
        kept = " Its receipt is kept with it.";
      } catch (error) {
        if (!(error instanceof UserError)) logFailure("attach receipt to a new expense", error);
        kept = " Its receipt could not be kept: open the expense and add it there.";
      }
    }
  } catch (error) {
    return refusal("add daily expense", error);
  }
  refresh();
  return { ok: true, message: `Recorded as ${number}.${kept}` };
}

/** Keeps one more receipt with an expense. */
export async function attachReceiptAction(expenseId: string, _: FormState, formData: FormData): Promise<FormState> {
  const file = chosen(formData.get("receipt"));
  if (!file) return { error: "Choose the receipt: a PDF or a photo." };
  if (file.size > FILE_MAX_BYTES) return { error: TOO_LARGE };
  try {
    const session = await requireCashBankModule();
    await attachReceipt(session, await objectStore(), expenseId, { name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) });
  } catch (error) {
    return refusal("attach receipt", error);
  }
  refresh();
  return { ok: true, message: "Kept with this expense." };
}

/** One row of the preview: what was typed, what it was read as and matched to, and what is wrong with it. */
export type PreviewRow = SheetCells & { problems: string[]; whatForName: string | null; paidFromName: string | null; dateRead: string | null; amountRead: string | null };
export type SheetState = FormState & {
  /** The sheet as read, waiting to be entered: every row, and the key that makes it enter once. */
  preview?: { rows: PreviewRow[]; bad: number; total: string; clientKey: string; branchId: string };
  /** The key of the sheet that was entered, so its preview is not offered again. */
  enteredKey?: string;
  /** The key of the sheet an error is about, so it is not shown under another one. */
  refusedKey?: string;
};

/** Reads the sheet and shows what it would enter. Nothing is recorded. */
export async function previewSheetAction(_: SheetState, formData: FormData): Promise<SheetState> {
  const file = chosen(formData.get("sheet"));
  if (!file) return { error: "Choose the sheet: an Excel file (.xlsx) or a CSV file." };
  if (file.size > MAX_SHEET_BYTES) return { error: "The file is too large for a sheet of expenses. Enter at most 200 at a time." };
  try {
    const session = await requireCashBankModule();
    const read = await readExpenseSheetFile(session, new Uint8Array(await file.arrayBuffer()));
    if (!read.ok) return { error: read.reason };
    const branchId = typeof formData.get("branchId") === "string" ? (formData.get("branchId") as string) : "";
    const rows = await previewExpenseSheet(session, read.cells, branchId);
    const total = rows.reduce((sum, row) => (row.expense ? sum.plus(row.expense.amount) : sum), new Decimal(0));
    return {
      preview: {
        // The day and the amount are shown as they were read, so "11/5" read as the eleventh of May is seen before it is entered.
        rows: rows.map(({ row, date, whatFor, amount, paidFrom, paidTo, note, problems, whatForName, paidFromName, expense }) => ({
          row, date, whatFor, amount, paidFrom, paidTo, note, problems, whatForName, paidFromName,
          dateRead: expense ? formatIsoDate(expense.date) : null,
          amountRead: expense ? formatAmount(expense.amount) : null,
        })),
        bad: rows.filter((row) => row.problems.length > 0).length,
        total: formatAmount(total),
        clientKey: randomUUID(),
        branchId,
      },
    };
  } catch (error) {
    return refusal("preview expense sheet", error);
  }
}

const cellText = (value: unknown) => (typeof value === "string" ? value.slice(0, 400) : "");

/** Enters the sheet that was previewed: every row or none. The rows are read and checked again. */
export async function recordSheetAction(_: SheetState, formData: FormData): Promise<SheetState> {
  let outcome: { count: number; first: string; last: string; total: string };
  try {
    const session = await requireCashBankModule();
    let sent: unknown;
    try {
      sent = JSON.parse(String(formData.get("rows") ?? ""));
    } catch {
      throw new UserError("Upload the sheet again.");
    }
    if (!Array.isArray(sent) || sent.length === 0 || sent.length > 200) throw new UserError("Upload the sheet again.");
    const cells: SheetCells[] = sent.map((raw: Record<string, unknown>, index) => ({
      row: Number.isInteger(raw?.row) && (raw.row as number) > 0 && (raw.row as number) < 100_000 ? (raw.row as number) : index + 2,
      date: cellText(raw?.date),
      whatFor: cellText(raw?.whatFor),
      amount: cellText(raw?.amount),
      paidFrom: cellText(raw?.paidFrom),
      paidTo: cellText(raw?.paidTo),
      note: cellText(raw?.note),
    }));
    if (new Set(cells.map((c) => c.row)).size !== cells.length) throw new UserError("Upload the sheet again.");
    outcome = await recordExpenseSheet(session, { cells, branchId: formData.get("branchId"), clientKey: formData.get("clientKey") });
  } catch (error) {
    return { ...refusal("record expense sheet", error), refusedKey: String(formData.get("clientKey")) };
  }
  refresh();
  const numbers = outcome.count === 1 ? outcome.first : `${outcome.first} to ${outcome.last}`;
  return { ok: true, enteredKey: String(formData.get("clientKey")), message: `Entered ${outcome.count} ${outcome.count === 1 ? "expense" : "expenses"} (${numbers}), ${formatAmount(new Decimal(outcome.total))} in all.` };
}

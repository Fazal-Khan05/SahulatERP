"use server";

import { refresh } from "next/cache";
import { requireTenant } from "@/lib/auth/session";
import { UserError, logFailure } from "@/lib/errors";
import type { FormState } from "@/lib/form-state";
import { deleteStatement, importStatement, matchAutomatically, matchByHand, MAX_FILE_BYTES, unmatch } from "@/modules/bank-reconciliation/commands";

// Step 35. The company always comes from the verified session, never from the form; ids arrive
// bound to the action and are checked again in the command and by the database.

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

const plural = (n: number, one: string, many: string) => `${n.toLocaleString("en")} ${n === 1 ? one : many}`;

/** Imports a statement file, all or nothing, and matches what is sure at once. */
export async function importStatementAction(accountId: string, _: FormState, formData: FormData): Promise<FormState> {
  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) return { error: "Choose the bank's CSV or Excel file." };
  if (file.size > MAX_FILE_BYTES) return { error: "The file is too large. Import at most 5,000 lines at a time." };
  let message: string;
  try {
    const session = await requireCashBankModule();
    const column = (name: string) => formData.get(`column_${name}`);
    const outcome = await importStatement(session, accountId, { name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) }, formData.get("layout"), {
      date: column("date"),
      description: column("description"),
      reference: column("reference"),
      out: column("out"),
      in: column("in"),
      amount: column("amount"),
      balance: column("balance"),
    });
    if ("problems" in outcome) return { error: `Nothing was imported. ${outcome.problems.join(" ")}` };
    const skipped = outcome.lines - outcome.added;
    message = `Imported ${plural(outcome.added, "line", "lines")}${skipped > 0 ? ` (${plural(skipped, "line was", "lines were")} imported before)` : ""}; ${plural(outcome.matched, "was", "were")} matched with the books.`;
  } catch (error) {
    return refusal("import bank statement", error);
  }
  refresh();
  return { ok: true, message };
}

export async function matchAutomaticallyAction(accountId: string): Promise<FormState> {
  let matched: number;
  try {
    ({ matched } = await matchAutomatically(await requireCashBankModule(), accountId));
  } catch (error) {
    return refusal("match bank lines", error);
  }
  refresh();
  return { ok: true, message: matched === 0 ? "Nothing more could be matched for sure. Match the rest by hand." : `Matched ${plural(matched, "line", "lines")}.` };
}

/** Matches the statement lines and entries ticked: they must add up to the same money. */
export async function matchByHandAction(accountId: string, _: FormState, formData: FormData): Promise<FormState> {
  try {
    await matchByHand(await requireCashBankModule(), accountId, formData.getAll("bank"), formData.getAll("book"));
  } catch (error) {
    return refusal("match bank lines by hand", error);
  }
  refresh();
  return { ok: true, message: "Matched." };
}

export async function unmatchAction(matchId: string): Promise<FormState> {
  try {
    await unmatch(await requireCashBankModule(), matchId);
  } catch (error) {
    return refusal("unmatch bank lines", error);
  }
  refresh();
  return { ok: true, message: "Unmatched." };
}

export async function deleteStatementAction(statementId: string): Promise<FormState> {
  try {
    await deleteStatement(await requireCashBankModule(), statementId);
  } catch (error) {
    return refusal("remove bank statement", error);
  }
  refresh();
  return { ok: true, message: "Removed." };
}

"use server";

import { refresh } from "next/cache";
import { requireTenant } from "@/lib/auth/session";
import { UserError, logFailure } from "@/lib/errors";
import type { FormState } from "@/lib/form-state";
import {
  addOpenDocument,
  discardOpening,
  importOpeningLines,
  postOpening,
  removeOpeningLine,
  reverseOpening,
  setAccountBalance,
  setOpeningDate,
  startOpening,
} from "@/modules/opening/commands";
import { OPENING_IMPORT_MAX_BYTES, isOpeningKind, type ImportProblem, type PartyKind } from "@/modules/opening/rules";

// The company always comes from the verified session, never from the form. Ids and kinds arrive
// bound to the action and are checked again here or in the command.

async function run(context: string, work: (session: Awaited<ReturnType<typeof requireTenant>>) => Promise<void>, done: FormState): Promise<FormState> {
  const session = await requireTenant();
  try {
    await work(session);
  } catch (error) {
    if (error instanceof UserError) return { error: error.message };
    logFailure(context, error);
    return { error: "That did not work. Please try again." };
  }
  refresh();
  return done;
}

const isPartyKind = (kind: unknown): kind is PartyKind => kind === "receivable" || kind === "payable";

export async function startOpeningAction(_: FormState, formData: FormData): Promise<FormState> {
  return run("start opening balances", async (session) => void (await startOpening(session, { date: formData.get("date") })), {});
}

export async function setOpeningDateAction(loadedAt: string, _: FormState, formData: FormData): Promise<FormState> {
  return run("set opening date", (session) => setOpeningDate(session, { date: formData.get("date") }, loadedAt), { message: "Saved." });
}

export async function setAccountBalanceAction(loadedAt: string, _: FormState, formData: FormData): Promise<FormState> {
  return run("set opening account balance", (session) => setAccountBalance(session, { accountId: formData.get("accountId"), debit: formData.get("debit"), credit: formData.get("credit") }, loadedAt), { ok: true, message: "Saved." });
}

export async function addOpenDocumentAction(kind: PartyKind, loadedAt: string, _: FormState, formData: FormData): Promise<FormState> {
  if (!isPartyKind(kind)) return { error: "That did not work. Please try again." };
  return run(
    "add opening document",
    (session) => addOpenDocument(session, kind, { party: formData.get("party"), documentNumber: formData.get("documentNumber"), documentDate: formData.get("documentDate"), dueDate: formData.get("dueDate"), amount: formData.get("amount") }, loadedAt),
    { ok: true, message: "Added." },
  );
}

export async function removeOpeningLineAction(lineId: string, loadedAt: string): Promise<FormState> {
  return run("remove opening line", (session) => removeOpeningLine(session, lineId, loadedAt), {});
}

export async function postOpeningAction(loadedAt: string): Promise<FormState> {
  return run("post opening balances", async (session) => void (await postOpening(session, loadedAt)), {});
}

export async function discardOpeningAction(loadedAt: string): Promise<FormState> {
  return run("discard opening balances", (session) => discardOpening(session, loadedAt), {});
}

export async function reverseOpeningAction(loadedAt: string): Promise<FormState> {
  return run("reverse opening balances", (session) => reverseOpening(session, loadedAt), {});
}

export type OpeningImportState = FormState & { imported?: number; problems?: ImportProblem[] };

/** Imports a CSV file into the draft, all or nothing. Bad rows come back to be shown; nothing is kept. */
export async function importOpeningAction(kind: "account" | PartyKind, loadedAt: string, _: OpeningImportState, formData: FormData): Promise<OpeningImportState> {
  const session = await requireTenant();
  if (!isOpeningKind(kind)) return { error: "That did not work. Please try again." };
  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) return { error: "Choose a CSV file." };
  if (file.size > OPENING_IMPORT_MAX_BYTES) return { error: "The file is too large. Import at most 2,000 rows at a time." };
  try {
    const outcome = await importOpeningLines(session, kind, { name: file.name, text: await file.text() }, loadedAt);
    if ("problems" in outcome) return { problems: outcome.problems };
    refresh();
    return { ok: true, imported: outcome.imported };
  } catch (error) {
    if (error instanceof UserError) return { error: error.message };
    logFailure("import opening balances", error);
    return { error: "That did not work. Please try again." };
  }
}

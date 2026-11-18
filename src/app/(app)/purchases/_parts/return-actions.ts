"use server";

import { refresh } from "next/cache";
import { requireTenant } from "@/lib/auth/session";
import { UserError, logFailure } from "@/lib/errors";
import type { FormState } from "@/lib/form-state";
import { applyReturnCredit, discardReturn, postReturn, saveReturnDraft } from "@/modules/supplier-returns/commands";

// The company always comes from the verified session, never from the form. Ids arrive bound to
// the action and are checked again in the command.

function refusal(context: string, error: unknown): FormState {
  if (error instanceof UserError) return { error: error.message };
  logFailure(context, error);
  return { error: "That did not work. Please try again." };
}

/** One list of a form's repeated field, as text. */
const column = (formData: FormData, name: string) => formData.getAll(name).map((value) => (typeof value === "string" ? value : ""));

/**
 * Saves the return as a draft and, when asked, posts it. `id` is null for a new one. The draft
 * is saved first, in its own transaction, so nothing typed is lost if posting is refused. The
 * goods received note is chosen before the form is shown, and arrives bound to the action.
 */
export async function saveReturnAction(id: string | null, receiptId: string, loadedAt: string, _: FormState, formData: FormData): Promise<FormState> {
  const session = await requireTenant();
  const receiptLines = column(formData, "receiptLineId");
  const billLines = column(formData, "billLineId");
  const quantities = column(formData, "quantity");
  const raw = {
    date: formData.get("date"),
    receiptId,
    reason: formData.get("reason"),
    supplierReference: formData.get("supplierReference"),
    lines: receiptLines.map((receiptLineId, index) => ({ receiptLineId, billLineId: billLines[index], quantity: quantities[index] })),
  };
  let saved: { id: string; updatedAt: Date };
  try {
    saved = await saveReturnDraft(session, id, raw, loadedAt);
  } catch (error) {
    return refusal("save supplier return", error);
  }
  if (formData.get("intent") !== "post") return { location: `/purchases/returns/${saved.id}${id === null ? "" : "?saved=1"}` };
  try {
    await postReturn(session, saved.id, saved.updatedAt);
  } catch (error) {
    const refused = refusal("post supplier return", error);
    // A new return now exists as a draft: open it, so a second try does not make a second one.
    if (id === null) return { location: `/purchases/returns/${saved.id}?refused=1` };
    refresh();
    return { error: `Saved as a draft, but not posted. ${refused.error}` };
  }
  return { location: `/purchases/returns/${saved.id}` };
}

export async function discardReturnAction(id: string, loadedAt: string): Promise<FormState> {
  const session = await requireTenant();
  try {
    await discardReturn(session, id, loadedAt);
  } catch (error) {
    return refusal("discard supplier return", error);
  }
  return { location: "/purchases/returns" };
}

/** Sets what is left of a posted return's credit against bills of its supplier. */
export async function applyReturnCreditAction(id: string, loadedAt: string, _: FormState, formData: FormData): Promise<FormState> {
  const session = await requireTenant();
  const bills = column(formData, "billId");
  const amounts = column(formData, "billAmount");
  try {
    await applyReturnCredit(session, id, { date: formData.get("date"), allocations: bills.map((billId, index) => ({ billId, amount: amounts[index] })) }, loadedAt);
  } catch (error) {
    return refusal("apply supplier return credit", error);
  }
  return { location: `/purchases/returns/${id}` };
}

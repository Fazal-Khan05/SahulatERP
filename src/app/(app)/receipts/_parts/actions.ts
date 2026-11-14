"use server";

import { refresh } from "next/cache";
import { requireTenant } from "@/lib/auth/session";
import { UserError, logFailure } from "@/lib/errors";
import type { FormState } from "@/lib/form-state";
import { applyAdvance, bounceCheque, cancelReceipt, clearCheque, depositCheque, discardReceipt, postReceipt, saveReceiptDraft } from "@/modules/receipts/commands";

// The company always comes from the verified session, never from the form. Ids arrive bound to
// the action and are checked again in the command.

function refusal(context: string, error: unknown): FormState {
  if (error instanceof UserError) return { error: error.message };
  logFailure(context, error);
  return { error: "That did not work. Please try again." };
}

const column = (formData: FormData, name: string) => formData.getAll(name).map((value) => (typeof value === "string" ? value : ""));

/** The rows of the "what it pays" grid: each sends its invoice and what is set against it, so the lists line up. */
function readRows(formData: FormData) {
  const kinds = column(formData, "allocKind");
  const ids = column(formData, "allocId");
  const amounts = column(formData, "allocAmount");
  const labels = column(formData, "allocLabel");
  return ids.map((id, index) => ({ kind: kinds[index], id, amount: amounts[index], label: labels[index] }));
}

/**
 * Saves the receipt as a draft and, when asked, posts it. `id` is null for a new one. The draft
 * is saved first, in its own transaction, so nothing typed is lost if posting is refused.
 */
export async function saveReceiptAction(id: string | null, customerId: string, loadedAt: string, _: FormState, formData: FormData): Promise<FormState> {
  const session = await requireTenant();
  const raw = {
    date: formData.get("date"),
    customerId,
    method: formData.get("method"),
    accountId: formData.get("accountId"),
    amount: formData.get("amount"),
    bankCharges: formData.get("bankCharges"),
    reference: formData.get("reference"),
    note: formData.get("note"),
    branchId: formData.get("branchId"),
    chequeNumber: formData.get("chequeNumber"),
    chequeBank: formData.get("chequeBank"),
    chequeDate: formData.get("chequeDate"),
    allocations: readRows(formData),
  };
  let saved: { id: string; updatedAt: Date };
  try {
    saved = await saveReceiptDraft(session, id, raw, loadedAt);
  } catch (error) {
    return refusal("save receipt", error);
  }
  if (formData.get("intent") !== "post") {
    if (id === null) return { location: `/receipts/${saved.id}` };
    refresh();
    return { message: "Draft saved." };
  }
  try {
    await postReceipt(session, saved.id, saved.updatedAt);
  } catch (error) {
    const refused = refusal("post receipt", error);
    // A new receipt now exists as a draft: open it, so a second try does not make a second one.
    // Nothing is carried in the address but the fact; posting again from the draft says why.
    if (id === null) return { location: `/receipts/${saved.id}?refused=1` };
    refresh();
    return { error: `Saved as a draft, but not posted. ${refused.error}` };
  }
  if (id === null) return { location: `/receipts/${saved.id}` };
  refresh();
  return {};
}

export async function discardReceiptAction(id: string, loadedAt: string): Promise<FormState> {
  const session = await requireTenant();
  try {
    await discardReceipt(session, id, loadedAt);
  } catch (error) {
    return refusal("discard receipt", error);
  }
  return { location: "/receipts" };
}

export async function cancelReceiptAction(id: string, loadedAt: string, _: FormState, formData: FormData): Promise<FormState> {
  const session = await requireTenant();
  try {
    await cancelReceipt(session, id, { date: formData.get("date"), reason: formData.get("reason") }, loadedAt);
  } catch (error) {
    return refusal("cancel receipt", error);
  }
  refresh();
  return {};
}

export async function depositChequeAction(id: string, loadedAt: string, _: FormState, formData: FormData): Promise<FormState> {
  const session = await requireTenant();
  try {
    await depositCheque(session, id, { accountId: formData.get("accountId"), date: formData.get("date") }, loadedAt);
  } catch (error) {
    return refusal("deposit cheque", error);
  }
  refresh();
  return {};
}

export async function clearChequeAction(id: string, loadedAt: string, _: FormState, formData: FormData): Promise<FormState> {
  const session = await requireTenant();
  try {
    await clearCheque(session, id, { date: formData.get("date"), bankCharges: formData.get("bankCharges") }, loadedAt);
  } catch (error) {
    return refusal("clear cheque", error);
  }
  refresh();
  return {};
}

export async function bounceChequeAction(id: string, loadedAt: string, _: FormState, formData: FormData): Promise<FormState> {
  const session = await requireTenant();
  try {
    await bounceCheque(session, id, { date: formData.get("date"), reason: formData.get("reason") }, loadedAt);
  } catch (error) {
    return refusal("bounce cheque", error);
  }
  refresh();
  return {};
}

export async function applyAdvanceAction(id: string, loadedAt: string, _: FormState, formData: FormData): Promise<FormState> {
  const session = await requireTenant();
  try {
    await applyAdvance(session, id, { date: formData.get("date"), allocations: readRows(formData) }, loadedAt);
  } catch (error) {
    return refusal("apply advance", error);
  }
  refresh();
  return {};
}

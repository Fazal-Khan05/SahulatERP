"use server";

import { refresh } from "next/cache";
import { requireTenant } from "@/lib/auth/session";
import { UserError, logFailure } from "@/lib/errors";
import type { FormState } from "@/lib/form-state";
import { applyAdvance, cancelPayment, discardPayment, postPayment, savePaymentDraft } from "@/modules/supplier-payments/commands";
import { recordTaxChallan } from "@/modules/tax-paid-over/commands";

// The company always comes from the verified session, never from the form. Ids arrive bound to
// the action and are checked again in the command.

function refusal(context: string, error: unknown): FormState {
  if (error instanceof UserError) return { error: error.message };
  logFailure(context, error);
  return { error: "That did not work. Please try again." };
}

/** One list of a form's repeated field, as text. */
const column = (formData: FormData, name: string) => formData.getAll(name).map((value) => (typeof value === "string" ? value : ""));
const allocations = (formData: FormData) => {
  const bills = column(formData, "billId");
  const amounts = column(formData, "billAmount");
  return bills.map((billId, index) => ({ billId, amount: amounts[index] }));
};

/**
 * Saves the payment as a draft and, when asked, posts it. `id` is null for a new one. The draft
 * is saved first, in its own transaction, so nothing typed is lost if posting is refused. The
 * supplier and the branch are chosen before the form is shown, and arrive bound to the action.
 */
export async function savePaymentAction(id: string | null, supplierId: string, branchId: string, loadedAt: string, _: FormState, formData: FormData): Promise<FormState> {
  const session = await requireTenant();
  const raw = {
    date: formData.get("date"),
    supplierId,
    branchId,
    accountId: formData.get("accountId"),
    reference: formData.get("reference"),
    note: formData.get("note"),
    amount: formData.get("amount"),
    foreignCurrency: formData.get("foreignCurrency"),
    foreignAmount: formData.get("foreignAmount"),
    allocations: allocations(formData),
  };
  let saved: { id: string; updatedAt: Date };
  try {
    saved = await savePaymentDraft(session, id, raw, loadedAt);
  } catch (error) {
    return refusal("save supplier payment", error);
  }
  if (formData.get("intent") !== "post") return { location: `/purchases/payments/${saved.id}${id === null ? "" : "?saved=1"}` };
  try {
    await postPayment(session, saved.id, saved.updatedAt);
  } catch (error) {
    const refused = refusal("post supplier payment", error);
    // A new payment now exists as a draft: open it, so a second try does not make a second one.
    if (id === null) return { location: `/purchases/payments/${saved.id}?refused=1` };
    refresh();
    return { error: `Saved as a draft, but not posted. ${refused.error}` };
  }
  return { location: `/purchases/payments/${saved.id}` };
}

export async function discardPaymentAction(id: string, loadedAt: string): Promise<FormState> {
  const session = await requireTenant();
  try {
    await discardPayment(session, id, loadedAt);
  } catch (error) {
    return refusal("discard supplier payment", error);
  }
  return { location: "/purchases/payments" };
}

/** Sets what is left of a posted payment against bills of its supplier. */
export async function applyAdvanceAction(id: string, loadedAt: string, _: FormState, formData: FormData): Promise<FormState> {
  const session = await requireTenant();
  try {
    await applyAdvance(session, id, { date: formData.get("date"), allocations: allocations(formData) }, loadedAt);
  } catch (error) {
    return refusal("apply supplier advance", error);
  }
  return { location: `/purchases/payments/${id}` };
}

/** Takes back a payment entered by mistake, with a reason. */
export async function cancelPaymentAction(id: string, loadedAt: string, _: FormState, formData: FormData): Promise<FormState> {
  const session = await requireTenant();
  try {
    await cancelPayment(session, id, { date: formData.get("date"), reason: formData.get("reason") }, loadedAt);
  } catch (error) {
    return refusal("cancel supplier payment", error);
  }
  return { location: `/purchases/payments/${id}` };
}

/** Records a challan for the amounts withheld that were ticked. */
export async function recordChallanAction(_: FormState, formData: FormData): Promise<FormState> {
  const session = await requireTenant();
  try {
    await recordTaxChallan(session, {
      kind: formData.get("kind"), paidOn: formData.get("paidOn"), accountId: formData.get("accountId"), challanNo: formData.get("challanNo"), note: formData.get("note"),
      entryIds: column(formData, "entryId"), expenseEntryIds: column(formData, "expenseEntryId"), runIds: column(formData, "runId"),
    });
  } catch (error) {
    return refusal("record withholding challan", error);
  }
  return { location: "/purchases/withholding" };
}

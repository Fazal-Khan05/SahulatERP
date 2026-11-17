"use server";

import { refresh } from "next/cache";
import { requireTenant } from "@/lib/auth/session";
import { UserError, logFailure } from "@/lib/errors";
import type { FormState } from "@/lib/form-state";
import { discardBill, postBill, saveBillDraft, setWithholding } from "@/modules/supplier-bills/commands";

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
 * Saves the bill as a draft and, when asked, posts it. `id` is null for a new one. The draft is
 * saved first, in its own transaction, so nothing typed is lost if posting is refused. The
 * supplier and the branch are chosen before the form is shown, and arrive bound to the action.
 */
export async function saveBillAction(id: string | null, supplierId: string, branchId: string, loadedAt: string, _: FormState, formData: FormData): Promise<FormState> {
  const session = await requireTenant();
  const receiptLines = column(formData, "receiptLineId");
  const quantities = column(formData, "goodsQuantity");
  const prices = column(formData, "goodsPrice");
  const goodsTax = column(formData, "goodsTax");
  const accounts = column(formData, "accountId");
  const descriptions = column(formData, "expenseDescription");
  const amounts = column(formData, "expenseAmount");
  const expenseTax = column(formData, "expenseTax");
  const raw = {
    date: formData.get("date"),
    supplierId,
    branchId,
    supplierInvoiceNo: formData.get("supplierInvoiceNo"),
    dueDate: formData.get("dueDate"),
    note: formData.get("note"),
    incomeTaxCode: formData.get("incomeTaxCode"),
    salesTaxCode: formData.get("salesTaxCode"),
    provincialTaxCode: formData.get("provincialTaxCode"),
    goods: receiptLines.map((receiptLineId, index) => ({ receiptLineId, quantity: quantities[index], unitPrice: prices[index], taxCategoryId: goodsTax[index] })),
    expenses: accounts.map((accountId, index) => ({ accountId, description: descriptions[index], amount: amounts[index], taxCategoryId: expenseTax[index] })),
  };
  let saved: { id: string; updatedAt: Date };
  try {
    saved = await saveBillDraft(session, id, raw, loadedAt);
  } catch (error) {
    return refusal("save supplier bill", error);
  }
  if (formData.get("intent") !== "post") {
    // A saved draft is shown again from the database, with what posting it would do.
    return { location: `/purchases/bills/${saved.id}${id === null ? "" : "?saved=1"}` };
  }
  try {
    await postBill(session, saved.id, saved.updatedAt);
  } catch (error) {
    const refused = refusal("post supplier bill", error);
    // A new bill now exists as a draft: open it, so a second try does not make a second one.
    if (id === null) return { location: `/purchases/bills/${saved.id}?refused=1` };
    refresh();
    return { error: `Saved as a draft, but not posted. ${refused.error}` };
  }
  return { location: `/purchases/bills/${saved.id}` };
}

export async function discardBillAction(id: string, loadedAt: string): Promise<FormState> {
  const session = await requireTenant();
  try {
    await discardBill(session, id, loadedAt);
  } catch (error) {
    return refusal("discard supplier bill", error);
  }
  return { location: "/purchases/bills" };
}

/** Switches withholding tax from suppliers on or off for the company. */
export async function setWithholdingAction(on: boolean): Promise<FormState> {
  const session = await requireTenant();
  try {
    await setWithholding(session, on);
  } catch (error) {
    return refusal("set withholding", error);
  }
  return { location: "/purchases/withholding" };
}

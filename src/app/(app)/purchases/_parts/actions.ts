"use server";

import { refresh } from "next/cache";
import { requireTenant } from "@/lib/auth/session";
import { UserError, logFailure } from "@/lib/errors";
import type { FormState } from "@/lib/form-state";
import { cancelOrder, discardOrder, discardReceipt, postReceipt, saveOrderDraft, saveReceiptDraft, submitOrder } from "@/modules/purchasing/commands";

// The company always comes from the verified session, never from the form. Ids arrive bound to
// the action and are checked again in the command.

function refusal(context: string, error: unknown): FormState {
  if (error instanceof UserError) return { error: error.message };
  logFailure(context, error);
  return { error: "That did not work. Please try again." };
}

/** One list of a form's repeated field, as text. */
const column = (formData: FormData, name: string) => formData.getAll(name).map((value) => (typeof value === "string" ? value : ""));

// ── purchase orders ─────────────────────────────────────────────────────────────────────────────

/**
 * Saves the order as a draft and, when asked, submits it. `id` is null for a new one. The draft
 * is saved first, in its own transaction, so nothing typed is lost if submitting is refused.
 */
export async function saveOrderAction(id: string | null, loadedAt: string, _: FormState, formData: FormData): Promise<FormState> {
  const session = await requireTenant();
  const itemIds = column(formData, "itemId");
  const unitIds = column(formData, "unitId");
  const quantities = column(formData, "quantity");
  const costs = column(formData, "unitCost");
  const raw = {
    date: formData.get("date"),
    supplierId: formData.get("supplierId"),
    warehouseId: formData.get("warehouseId"),
    expectedOn: formData.get("expectedOn"),
    supplierReference: formData.get("supplierReference"),
    note: formData.get("note"),
    lines: itemIds.map((itemId, index) => ({ itemId, unitId: unitIds[index], quantity: quantities[index], unitCost: costs[index] })),
  };
  let saved: { id: string; updatedAt: Date };
  try {
    saved = await saveOrderDraft(session, id, raw, loadedAt);
  } catch (error) {
    return refusal("save purchase order", error);
  }
  if (formData.get("intent") !== "submit") {
    if (id === null) return { location: `/purchases/${saved.id}` };
    refresh();
    return { message: "Draft saved." };
  }
  try {
    await submitOrder(session, saved.id, saved.updatedAt);
  } catch (error) {
    const refused = refusal("submit purchase order", error);
    // A new order now exists as a draft: open it, so a second try does not make a second one.
    // Nothing is carried in the address but the fact; submitting again from the draft says why.
    if (id === null) return { location: `/purchases/${saved.id}?refused=1` };
    refresh();
    return { error: `Saved as a draft, but not submitted. ${refused.error}` };
  }
  return { location: `/purchases/${saved.id}` };
}

export async function discardOrderAction(id: string, loadedAt: string): Promise<FormState> {
  const session = await requireTenant();
  try {
    await discardOrder(session, id, loadedAt);
  } catch (error) {
    return refusal("discard purchase order", error);
  }
  return { location: "/purchases" };
}

/** Cancels a submitted order nothing has been received against. The reason is kept with it. */
export async function cancelOrderAction(id: string, loadedAt: string, _: FormState, formData: FormData): Promise<FormState> {
  const session = await requireTenant();
  try {
    await cancelOrder(session, id, formData.get("reason"), loadedAt);
  } catch (error) {
    return refusal("cancel purchase order", error);
  }
  return { location: `/purchases/${id}` };
}

// ── goods received ──────────────────────────────────────────────────────────────────────────────

/**
 * Saves goods received against an order as a draft and, when asked, posts it. `id` is null for
 * a new note. Saved first, in its own transaction, so nothing typed is lost if posting is refused.
 */
export async function saveReceiptAction(id: string | null, orderId: string, loadedAt: string, _: FormState, formData: FormData): Promise<FormState> {
  const session = await requireTenant();
  const lineIds = column(formData, "orderLineId");
  const quantities = column(formData, "quantity");
  const raw = {
    date: formData.get("date"),
    supplierDeliveryNote: formData.get("supplierDeliveryNote"),
    note: formData.get("note"),
    lines: lineIds.map((orderLineId, index) => ({ orderLineId, quantity: quantities[index] })),
  };
  let saved: { id: string; updatedAt: Date };
  try {
    saved = await saveReceiptDraft(session, id, orderId, raw, loadedAt);
  } catch (error) {
    return refusal("save goods received", error);
  }
  if (formData.get("intent") !== "post") {
    if (id === null) return { location: `/purchases/receipts/${saved.id}` };
    refresh();
    return { message: "Draft saved." };
  }
  try {
    await postReceipt(session, saved.id, saved.updatedAt);
  } catch (error) {
    const refused = refusal("post goods received", error);
    if (id === null) return { location: `/purchases/receipts/${saved.id}?refused=1` };
    refresh();
    return { error: `Saved as a draft, but not posted. ${refused.error}` };
  }
  return { location: `/purchases/receipts/${saved.id}` };
}

export async function discardReceiptAction(id: string, loadedAt: string): Promise<FormState> {
  const session = await requireTenant();
  try {
    await discardReceipt(session, id, loadedAt);
  } catch (error) {
    return refusal("discard goods received", error);
  }
  return { location: "/purchases/receive" };
}

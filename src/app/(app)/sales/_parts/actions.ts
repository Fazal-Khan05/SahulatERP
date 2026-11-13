"use server";

import { refresh } from "next/cache";
import { requireTenant } from "@/lib/auth/session";
import { UserError, logFailure } from "@/lib/errors";
import type { FormState } from "@/lib/form-state";
import { NeedsReason, cancelSalesDocument, discardSalesDraft, orderFromQuotation, releaseSalesHold, saveSalesDraft, submitSalesDocument } from "@/modules/sales/commands";
import type { RawDocument, SalesKind } from "@/modules/sales/rules";

// The company always comes from the verified session, never from the form. Ids arrive bound to
// the action and are checked again in the command.

/** What the sales form's action hands back: the usual, and whether the owner must now give a reason. */
export type SalesFormState = FormState & { needsReason?: boolean };

/** The signed-in member's session, refused when the company has switched Sales off. */
async function requireSales() {
  const session = await requireTenant();
  if (!session.modules.sales) throw new UserError("Sales is switched off for this company.");
  return session;
}

function refusal(context: string, error: unknown): SalesFormState {
  if (error instanceof NeedsReason) return { error: error.message, needsReason: true };
  if (error instanceof UserError) return { error: error.message };
  logFailure(context, error);
  return { error: "That did not work. Please try again." };
}

/** The form's rows, in order: each row sends every field, so the lists line up. */
function readForm(kind: SalesKind, formData: FormData): RawDocument {
  const itemIds = formData.getAll("itemId");
  const unitIds = formData.getAll("unitId");
  const quantities = formData.getAll("quantity");
  const unitPrices = formData.getAll("unitPrice");
  const discounts = formData.getAll("discountPercent");
  const shareUsers = formData.getAll("shareUserId");
  const sharePercents = formData.getAll("sharePercent");
  return {
    kind,
    date: formData.get("date"),
    validUntil: formData.get("validUntil") ?? "",
    customerId: formData.get("customerId"),
    warehouseId: formData.get("warehouseId"),
    customerReference: formData.get("customerReference"),
    notes: formData.get("notes"),
    furtherTaxExcluded: formData.get("furtherTaxExcluded"),
    lines: itemIds.map((itemId, index) => ({ itemId, unitId: unitIds[index], quantity: quantities[index], unitPrice: unitPrices[index], discountPercent: discounts[index] })),
    shares: shareUsers.map((userId, index) => ({ userId, percent: sharePercents[index] })),
  };
}

/**
 * Saves the document as a draft and, when asked, submits it. `id` is null for a new document.
 * The draft is saved first, in its own transaction, so nothing typed is lost if the submit is
 * refused.
 */
export async function saveSalesAction(id: string | null, kind: SalesKind, loadedAt: string, _: SalesFormState, formData: FormData): Promise<SalesFormState> {
  const submit = formData.get("intent") === "submit";
  let session: Awaited<ReturnType<typeof requireSales>>;
  let savedId: string;
  let savedAt: Date;
  try {
    session = await requireSales();
    ({ id: savedId, updatedAt: savedAt } = await saveSalesDraft(session, id, readForm(kind, formData), loadedAt));
  } catch (error) {
    return refusal("save sales document", error);
  }
  if (!submit) {
    if (id === null) return { location: `/sales/${savedId}` };
    refresh();
    return { message: "Draft saved." };
  }
  try {
    // What was just saved is what is submitted: a save by someone else in between is refused.
    await submitSalesDocument(session, savedId, savedAt, { reason: formData.get("reason") });
  } catch (error) {
    const refused = refusal("submit sales document", error);
    // A new document now exists as a draft: open it, so a second try does not make a second one.
    // The draft's own page works out again why it could not be submitted.
    if (id === null) return { location: `/sales/${savedId}?refused=1` };
    refresh();
    return { ...refused, error: refused.needsReason ? refused.error : `Saved as a draft, but not submitted. ${refused.error}` };
  }
  // Submitted, or put on hold for the owner: the document's page says which.
  if (id === null) return { location: `/sales/${savedId}` };
  refresh();
  return {};
}

export async function discardSalesAction(id: string, loadedAt: string): Promise<FormState> {
  try {
    const session = await requireSales();
    const { kind } = await discardSalesDraft(session, id, loadedAt);
    return { location: `/sales?kind=${kind}` };
  } catch (error) {
    return refusal("discard sales document", error);
  }
}

/** The owner's approval of an order that is waiting, with the reason. */
export async function approveSalesAction(id: string, loadedAt: string, _: FormState, formData: FormData): Promise<FormState> {
  try {
    const session = await requireSales();
    await submitSalesDocument(session, id, loadedAt, { reason: formData.get("reason") });
  } catch (error) {
    const { error: message } = refusal("approve sales order", error);
    return { error: message };
  }
  refresh();
  return {};
}

export async function releaseSalesAction(id: string, loadedAt: string): Promise<FormState> {
  try {
    const session = await requireSales();
    await releaseSalesHold(session, id, loadedAt);
  } catch (error) {
    return refusal("release sales order", error);
  }
  refresh();
  return {};
}

export async function cancelSalesAction(id: string, loadedAt: string, _: FormState, formData: FormData): Promise<FormState> {
  try {
    const session = await requireSales();
    await cancelSalesDocument(session, id, { reason: formData.get("reason") }, loadedAt);
  } catch (error) {
    return refusal("cancel sales document", error);
  }
  refresh();
  return {};
}

export async function orderFromQuotationAction(id: string, loadedAt: string): Promise<FormState> {
  try {
    const session = await requireSales();
    const order = await orderFromQuotation(session, id, loadedAt);
    return { location: `/sales/${order.id}` };
  } catch (error) {
    return refusal("order from quotation", error);
  }
}

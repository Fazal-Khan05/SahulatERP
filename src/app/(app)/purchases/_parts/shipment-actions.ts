"use server";

import { requireTenant } from "@/lib/auth/session";
import { UserError, logFailure } from "@/lib/errors";
import type { FormState } from "@/lib/form-state";
import { addShipmentCharge, addShipmentReceipt, allocateShipment, cancelShipment, openShipment, removeShipmentCharge, removeShipmentReceipt, updateShipment } from "@/modules/shipments/commands";

// The company always comes from the verified session, never from the form. Ids arrive bound to
// the action and are checked again in the command.

function refusal(context: string, error: unknown): FormState {
  if (error instanceof UserError) return { error: error.message };
  logFailure(context, error);
  return { error: "That did not work. Please try again." };
}

const details = (formData: FormData) => ({
  stage: formData.get("stage"),
  origin: formData.get("origin"),
  port: formData.get("port"),
  containerNo: formData.get("containerNo"),
  blNumber: formData.get("blNumber"),
  lcNumber: formData.get("lcNumber"),
  gdNumber: formData.get("gdNumber"),
  gdDate: formData.get("gdDate"),
  customsValue: formData.get("customsValue"),
  expectedOn: formData.get("expectedOn"),
  note: formData.get("note"),
});

/** Opens a shipment and goes to its page. */
export async function openShipmentAction(_: FormState, formData: FormData): Promise<FormState> {
  const session = await requireTenant();
  try {
    const { id } = await openShipment(session, { openedOn: formData.get("openedOn"), supplierId: formData.get("supplierId"), branchId: formData.get("branchId"), ...details(formData) });
    return { location: `/purchases/shipments/${id}` };
  } catch (error) {
    return refusal("open shipment", error);
  }
}

export async function updateShipmentAction(id: string, loadedAt: string, _: FormState, formData: FormData): Promise<FormState> {
  const session = await requireTenant();
  try {
    await updateShipment(session, id, details(formData), loadedAt);
  } catch (error) {
    return refusal("update shipment", error);
  }
  return { location: `/purchases/shipments/${id}` };
}

export async function addShipmentReceiptAction(id: string, loadedAt: string, _: FormState, formData: FormData): Promise<FormState> {
  const session = await requireTenant();
  try {
    await addShipmentReceipt(session, id, formData.get("receiptId"), loadedAt);
  } catch (error) {
    return refusal("add shipment goods", error);
  }
  return { location: `/purchases/shipments/${id}` };
}

export async function removeShipmentReceiptAction(id: string, rowId: string, loadedAt: string): Promise<FormState> {
  const session = await requireTenant();
  try {
    await removeShipmentReceipt(session, id, rowId, loadedAt);
  } catch (error) {
    return refusal("remove shipment goods", error);
  }
  return { location: `/purchases/shipments/${id}` };
}

export async function addShipmentChargeAction(id: string, loadedAt: string, _: FormState, formData: FormData): Promise<FormState> {
  const session = await requireTenant();
  try {
    await addShipmentCharge(session, id, { billLineId: formData.get("billLineId"), class: formData.get("class"), basis: formData.get("basis"), accountId: formData.get("accountId") }, loadedAt);
  } catch (error) {
    return refusal("add shipment charge", error);
  }
  return { location: `/purchases/shipments/${id}` };
}

export async function removeShipmentChargeAction(id: string, chargeId: string, loadedAt: string): Promise<FormState> {
  const session = await requireTenant();
  try {
    await removeShipmentCharge(session, id, chargeId, loadedAt);
  } catch (error) {
    return refusal("remove shipment charge", error);
  }
  return { location: `/purchases/shipments/${id}` };
}

/** Spreads the charges that are waiting over the shipment's goods, and closes it. */
export async function allocateShipmentAction(id: string, loadedAt: string, _: FormState, formData: FormData): Promise<FormState> {
  const session = await requireTenant();
  try {
    await allocateShipment(session, id, { date: formData.get("date") }, loadedAt);
  } catch (error) {
    return refusal("allocate shipment", error);
  }
  return { location: `/purchases/shipments/${id}` };
}

export async function cancelShipmentAction(id: string, loadedAt: string, _: FormState, formData: FormData): Promise<FormState> {
  const session = await requireTenant();
  try {
    await cancelShipment(session, id, { reason: formData.get("reason") }, loadedAt);
  } catch (error) {
    return refusal("cancel shipment", error);
  }
  return { location: `/purchases/shipments/${id}` };
}

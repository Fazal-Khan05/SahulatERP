"use server";

import { refresh } from "next/cache";
import { requireTenant } from "@/lib/auth/session";
import { UserError, logFailure } from "@/lib/errors";
import type { FormState } from "@/lib/form-state";
import {
  addCountItem,
  discardAdjustment,
  discardCount,
  discardTransfer,
  importOpeningStock,
  postAdjustment,
  postCount,
  postTransfer,
  rebookCount,
  returnCount,
  saveAdjustmentDraft,
  saveCounts,
  saveTransferDraft,
  startCount,
  submitCount,
} from "@/modules/inventory/commands";
import { MAX_OPENING_ROWS, type AdjustmentKind, type OpeningProblem } from "@/modules/inventory/rules";

// The company always comes from the verified session, never from the form. Ids arrive bound to
// the action and are checked again in the command.

function refusal(context: string, error: unknown): FormState {
  if (error instanceof UserError) return { error: error.message };
  logFailure(context, error);
  return { error: "That did not work. Please try again." };
}

/** One list of a form's repeated field, as text. */
const column = (formData: FormData, name: string) => formData.getAll(name).map((value) => (typeof value === "string" ? value : ""));

// ── transfers ───────────────────────────────────────────────────────────────────────────────────

/**
 * Saves the transfer as a draft and, when asked, posts it. `id` is null for a new one. The
 * draft is saved first, in its own transaction, so nothing typed is lost if posting is refused.
 */
export async function saveTransferAction(id: string | null, loadedAt: string, _: FormState, formData: FormData): Promise<FormState> {
  const session = await requireTenant();
  const codes = column(formData, "itemCode");
  const quantities = column(formData, "quantity");
  const raw = {
    date: formData.get("date"),
    fromWarehouseId: formData.get("fromWarehouseId"),
    toWarehouseId: formData.get("toWarehouseId"),
    note: formData.get("note"),
    lines: codes.map((itemCode, index) => ({ itemCode, quantity: quantities[index] })),
  };
  let saved: { id: string; updatedAt: Date };
  try {
    saved = await saveTransferDraft(session, id, raw, loadedAt);
  } catch (error) {
    return refusal("save stock transfer", error);
  }
  if (formData.get("intent") !== "post") {
    if (id === null) return { location: `/stock/transfers/${saved.id}` };
    refresh();
    return { message: "Draft saved." };
  }
  try {
    await postTransfer(session, saved.id, saved.updatedAt);
  } catch (error) {
    const refused = refusal("post stock transfer", error);
    // A new transfer now exists as a draft: open it, so a second try does not make a second one.
    // Nothing is carried in the address but the fact; posting again from the draft says why.
    if (id === null) return { location: `/stock/transfers/${saved.id}?refused=1` };
    refresh();
    return { error: `Saved as a draft, but not posted. ${refused.error}` };
  }
  if (id === null) return { location: `/stock/transfers/${saved.id}` };
  refresh();
  return {};
}

export async function discardTransferAction(id: string, loadedAt: string): Promise<FormState> {
  const session = await requireTenant();
  try {
    await discardTransfer(session, id, loadedAt);
  } catch (error) {
    return refusal("discard stock transfer", error);
  }
  return { location: "/stock/transfers" };
}

// ── adjustments and opening stock ───────────────────────────────────────────────────────────────

export async function saveAdjustmentAction(kind: AdjustmentKind, id: string | null, loadedAt: string, _: FormState, formData: FormData): Promise<FormState> {
  const session = await requireTenant();
  const codes = column(formData, "itemCode");
  const directions = column(formData, "direction");
  const quantities = column(formData, "quantity");
  const costs = column(formData, "unitCost");
  const raw = {
    date: formData.get("date"),
    warehouseId: formData.get("warehouseId"),
    reason: formData.get("reason"),
    note: formData.get("note"),
    lines: codes.map((itemCode, index) => ({ itemCode, direction: directions[index], quantity: quantities[index], unitCost: costs[index] })),
  };
  let saved: { id: string; updatedAt: Date };
  try {
    saved = await saveAdjustmentDraft(session, kind, id, raw, loadedAt);
  } catch (error) {
    return refusal("save stock adjustment", error);
  }
  if (formData.get("intent") !== "post") {
    if (id === null) return { location: `/stock/adjustments/${saved.id}` };
    refresh();
    return { message: "Draft saved." };
  }
  try {
    await postAdjustment(session, saved.id, saved.updatedAt);
  } catch (error) {
    const refused = refusal("post stock adjustment", error);
    if (id === null) return { location: `/stock/adjustments/${saved.id}?refused=1` };
    refresh();
    return { error: `Saved as a draft, but not posted. ${refused.error}` };
  }
  if (id === null) return { location: `/stock/adjustments/${saved.id}` };
  refresh();
  return {};
}

export async function discardAdjustmentAction(id: string, loadedAt: string): Promise<FormState> {
  const session = await requireTenant();
  try {
    await discardAdjustment(session, id, loadedAt);
  } catch (error) {
    return refusal("discard stock adjustment", error);
  }
  return { location: "/stock/adjustments" };
}

export type OpeningImportState = FormState & { problems?: OpeningProblem[] };

/** A file of this size holds far more than the most rows one import takes. */
const OPENING_MAX_BYTES = 512 * 1024;

/** Reads a CSV file of opening stock into a new draft for one warehouse, and opens the draft. */
export async function importOpeningAction(_: OpeningImportState, formData: FormData): Promise<OpeningImportState> {
  const session = await requireTenant();
  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) return { error: "Choose a CSV file." };
  if (file.size > OPENING_MAX_BYTES) return { error: `The file is too large. Import at most ${MAX_OPENING_ROWS} rows at a time.` };
  try {
    const csv = new TextDecoder("utf-8").decode(await file.arrayBuffer());
    const result = await importOpeningStock(session, { date: formData.get("date"), warehouseId: formData.get("warehouseId"), note: formData.get("note"), csv });
    if (result.ok) return { location: `/stock/adjustments/${result.id}` };
    return result.problems ? { problems: result.problems } : { error: result.reason };
  } catch (error) {
    return refusal("import opening stock", error);
  }
}

// ── counts ──────────────────────────────────────────────────────────────────────────────────────

export async function startCountAction(_: FormState, formData: FormData): Promise<FormState> {
  const session = await requireTenant();
  try {
    const { id } = await startCount(session, { date: formData.get("date"), warehouseId: formData.get("warehouseId"), note: formData.get("note") });
    return { location: `/stock/counts/${id}` };
  } catch (error) {
    return refusal("start stock count", error);
  }
}

/** Saves what has been counted so far and, when asked, marks the count finished. */
export async function saveCountAction(id: string, loadedAt: string, _: FormState, formData: FormData): Promise<FormState> {
  const session = await requireTenant();
  const lineIds = column(formData, "lineId");
  const counted = column(formData, "counted");
  const labels = column(formData, "label");
  let updatedAt: Date;
  try {
    ({ updatedAt } = await saveCounts(session, id, { date: formData.get("date"), note: formData.get("note"), lines: lineIds.map((lineId, index) => ({ lineId, counted: counted[index], label: labels[index] })) }, loadedAt));
  } catch (error) {
    return refusal("save stock count", error);
  }
  if (formData.get("intent") === "finish") {
    try {
      await submitCount(session, id, updatedAt);
    } catch (error) {
      refresh();
      return { error: `Saved, but not marked finished. ${refusal("finish stock count", error).error}` };
    }
    refresh();
    return {};
  }
  refresh();
  return { message: "Saved." };
}

export async function addCountItemAction(id: string, loadedAt: string, _: FormState, formData: FormData): Promise<FormState> {
  const session = await requireTenant();
  try {
    await addCountItem(session, id, { itemCode: formData.get("itemCode") }, loadedAt);
  } catch (error) {
    return refusal("add item to stock count", error);
  }
  refresh();
  return { ok: true };
}

/** Sends a finished count back, brings a sheet's book quantities up to date, or throws a sheet away. */
export async function countStepAction(step: "return" | "rebook" | "discard", id: string, loadedAt: string): Promise<FormState> {
  const session = await requireTenant();
  try {
    if (step === "return") await returnCount(session, id, loadedAt);
    else if (step === "rebook") await rebookCount(session, id, loadedAt);
    else await discardCount(session, id, loadedAt);
  } catch (error) {
    return refusal(`${step} stock count`, error);
  }
  if (step === "discard") return { location: "/stock/counts" };
  refresh();
  return {};
}

/** Posts a finished count. `countedFirst` says the shelves were counted before stock moved. */
export async function postCountAction(id: string, loadedAt: string, countedFirst: boolean): Promise<FormState> {
  const session = await requireTenant();
  try {
    await postCount(session, id, loadedAt, countedFirst);
  } catch (error) {
    const refused = refusal("post stock count", error);
    // The sheet on screen may be out of date: what moved is shown again from the database.
    refresh();
    return refused;
  }
  refresh();
  return {};
}

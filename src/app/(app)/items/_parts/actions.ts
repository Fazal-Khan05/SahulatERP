"use server";

import { refresh } from "next/cache";
import { requireTenant } from "@/lib/auth/session";
import { UserError, logFailure } from "@/lib/errors";
import type { FormState } from "@/lib/form-state";
import { addItemCategory, addUnit, createItem, importItems, removeItemUnit, setItemArchived, setItemUnit, updateItem } from "@/modules/items/commands";
import { ITEM_COLUMNS, ITEM_IMPORT_MAX_BYTES, type RawItem } from "@/modules/items/rules";
import type { ImportState } from "../../_parties/actions";

// The company always comes from the verified session, never from the form. An item's id arrives
// bound to the action and is checked again in the command.

function refusal(context: string, error: unknown): FormState {
  if (error instanceof UserError) return { error: error.message };
  logFailure(context, error);
  return { error: "That did not work. Please try again." };
}

/** The session, or a refusal when Stock is switched off: a module that is off is closed, not just hidden. */
async function open(): Promise<{ session: Awaited<ReturnType<typeof requireTenant>> } | { closed: FormState }> {
  const session = await requireTenant();
  return session.modules.inventory ? { session } : { closed: { error: "Stock is switched off for this company." } };
}

export async function saveItemAction(id: string | null, _: FormState, formData: FormData): Promise<FormState> {
  const gate = await open();
  if ("closed" in gate) return gate.closed;
  const raw: RawItem = Object.fromEntries(ITEM_COLUMNS.map(({ key }) => [key, formData.get(key)]));
  try {
    const saved = id === null ? await createItem(gate.session, raw) : await updateItem(gate.session, id, raw, formData.get("loadedAt"));
    // A full page load: the screen that opens shows what the database now holds.
    return { location: `/items/${saved.id}` };
  } catch (error) {
    return refusal("save item", error);
  }
}

export async function archiveItemAction(id: string, archived: boolean): Promise<FormState> {
  const gate = await open();
  if ("closed" in gate) return gate.closed;
  try {
    await setItemArchived(gate.session, id, archived === true);
  } catch (error) {
    return refusal("archive item", error);
  }
  refresh();
  return {};
}

export async function setItemUnitAction(id: string, _: FormState, formData: FormData): Promise<FormState> {
  const gate = await open();
  if ("closed" in gate) return gate.closed;
  try {
    await setItemUnit(gate.session, id, { unit: formData.get("unit"), factor: formData.get("factor") });
  } catch (error) {
    return refusal("set item unit", error);
  }
  refresh();
  return { ok: true, message: "Saved." };
}

export async function removeItemUnitAction(id: string, unitId: string): Promise<FormState> {
  const gate = await open();
  if ("closed" in gate) return gate.closed;
  try {
    await removeItemUnit(gate.session, id, unitId);
  } catch (error) {
    return refusal("remove item unit", error);
  }
  refresh();
  return {};
}

export async function addUnitAction(_: FormState, formData: FormData): Promise<FormState> {
  const gate = await open();
  if ("closed" in gate) return gate.closed;
  try {
    await addUnit(gate.session, { code: formData.get("code"), name: formData.get("name") });
  } catch (error) {
    return refusal("add unit", error);
  }
  refresh();
  return { ok: true, message: "Added." };
}

export async function addItemCategoryAction(_: FormState, formData: FormData): Promise<FormState> {
  const gate = await open();
  if ("closed" in gate) return gate.closed;
  try {
    await addItemCategory(gate.session, formData.get("name"));
  } catch (error) {
    return refusal("add item category", error);
  }
  refresh();
  return { ok: true, message: "Added." };
}

/** Imports a CSV file of items, all or nothing. Bad rows come back to be shown; nothing is kept. */
export async function importItemsAction(_: ImportState, formData: FormData): Promise<ImportState> {
  const gate = await open();
  if ("closed" in gate) return gate.closed;
  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) return { error: "Choose a CSV file." };
  if (file.size > ITEM_IMPORT_MAX_BYTES) return { error: "The file is too large. Import at most 2,000 rows at a time." };
  try {
    const outcome = await importItems(gate.session, { name: file.name, text: await file.text() });
    if ("problems" in outcome) return { problems: outcome.problems };
    return { ok: true, imported: outcome.imported };
  } catch (error) {
    return refusal("import items", error);
  }
}

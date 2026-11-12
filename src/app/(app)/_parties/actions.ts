"use server";

import { refresh } from "next/cache";
import { requireTenant } from "@/lib/auth/session";
import { UserError, logFailure } from "@/lib/errors";
import type { FormState } from "@/lib/form-state";
import { createParty, importParties, setPartyArchived, updateParty } from "@/modules/parties/commands";
import { IMPORT_MAX_BYTES, PARTY_KINDS, PARTY_MODULE, PARTY_WORDS, importColumns, type ImportProblem, type PartyKind, type RawParty } from "@/modules/parties/rules";
import { MODULE_INFO, type ModuleState } from "@/modules/tenant/rules";

// The company always comes from the verified session, never from the form. The kind of party and
// its id arrive bound to the action; both are checked again here and in the command.

function refusal(context: string, error: unknown): FormState {
  if (error instanceof UserError) return { error: error.message };
  logFailure(context, error);
  return { error: "That did not work. Please try again." };
}

const isKind = (value: unknown): value is PartyKind => PARTY_KINDS.includes(value as PartyKind);

/** A module that is off is closed, not just hidden: its actions refuse as its screens do. */
function moduleOff(session: { modules: ModuleState }, kind: PartyKind): FormState | null {
  const owning = PARTY_MODULE[kind];
  return session.modules[owning] ? null : { error: `${MODULE_INFO[owning].label} is switched off for this company.` };
}

/** Adds a party, or changes the one with this id, then shows it. */
export async function savePartyAction(kind: PartyKind, id: string | null, _: FormState, formData: FormData): Promise<FormState> {
  const session = await requireTenant();
  if (!isKind(kind)) return { error: "That did not work. Please try again." };
  const off = moduleOff(session, kind);
  if (off) return off;
  const raw: RawParty = Object.fromEntries(importColumns(kind).map(({ key }) => [key, formData.get(key)]));
  raw.priceListId = formData.get("priceListId");
  try {
    const saved = id === null ? await createParty(session, kind, raw) : await updateParty(session, kind, id, raw, formData.get("loadedAt"));
    // A full page load: the screen that opens shows what the database now holds.
    return { location: `${PARTY_WORDS[kind].path}/${saved.id}` };
  } catch (error) {
    return refusal(`save ${kind}`, error);
  }
}

/** Archives or restores a party. The form sends nothing of its own: all three values are bound. */
export async function archivePartyAction(kind: PartyKind, id: string, archived: boolean): Promise<FormState> {
  const session = await requireTenant();
  if (!isKind(kind)) return { error: "That did not work. Please try again." };
  const off = moduleOff(session, kind);
  if (off) return off;
  try {
    await setPartyArchived(session, kind, id, archived === true);
  } catch (error) {
    return refusal(`archive ${kind}`, error);
  }
  refresh();
  return {};
}

export type ImportState = FormState & { imported?: number; problems?: ImportProblem[] };

/** Imports a CSV file, all or nothing. Bad rows come back to be shown; nothing is kept. */
export async function importPartiesAction(kind: PartyKind, _: ImportState, formData: FormData): Promise<ImportState> {
  const session = await requireTenant();
  if (!isKind(kind)) return { error: "That did not work. Please try again." };
  const off = moduleOff(session, kind);
  if (off) return off;
  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) return { error: "Choose a CSV file." };
  if (file.size > IMPORT_MAX_BYTES) return { error: "The file is too large. Import at most 2,000 rows at a time." };
  try {
    const outcome = await importParties(session, kind, { name: file.name, text: await file.text() });
    if ("problems" in outcome) return { problems: outcome.problems };
    return { ok: true, imported: outcome.imported };
  } catch (error) {
    return refusal(`import ${kind}`, error);
  }
}

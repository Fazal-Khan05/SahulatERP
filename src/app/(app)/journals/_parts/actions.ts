"use server";

import { refresh } from "next/cache";
import { requireTenant } from "@/lib/auth/session";
import { UserError, logFailure } from "@/lib/errors";
import type { FormState } from "@/lib/form-state";
import { discardDraft, postManualJournal, reverseManualJournal, saveDraft } from "@/modules/manual-journals/commands";
import type { RawDraft } from "@/modules/manual-journals/rules";

// The company always comes from the verified session, never from the form. Ids arrive bound to
// the action and are checked again in the command.

function refusal(context: string, error: unknown): FormState {
  if (error instanceof UserError) return { error: error.message };
  logFailure(context, error);
  return { error: "That did not work. Please try again." };
}

/** The form's rows, in order: each row sends all four fields, so the lists line up. */
function readForm(formData: FormData): RawDraft {
  const accountIds = formData.getAll("accountId");
  const descriptions = formData.getAll("description");
  const debits = formData.getAll("debit");
  const credits = formData.getAll("credit");
  return {
    date: formData.get("date"),
    memo: formData.get("memo"),
    branchId: formData.get("branchId"),
    lines: accountIds.map((accountId, index) => ({ accountId, description: descriptions[index], debit: debits[index], credit: credits[index] })),
  };
}

/**
 * Saves the journal as a draft and, when asked, posts it. `id` is null for a new journal. The
 * draft is saved first, in its own transaction, so nothing typed is lost if posting is refused.
 */
export async function saveJournalAction(id: string | null, loadedAt: string, _: FormState, formData: FormData): Promise<FormState> {
  const session = await requireTenant();
  const post = formData.get("intent") === "post";
  let savedId: string;
  let savedAt: Date;
  try {
    ({ id: savedId, updatedAt: savedAt } = await saveDraft(session, id, readForm(formData), loadedAt));
  } catch (error) {
    return refusal("save journal", error);
  }
  if (!post) {
    if (id === null) return { location: `/journals/${savedId}` };
    refresh();
    return { message: "Draft saved." };
  }
  try {
    // What was just saved is what is posted: a save by someone else in between is refused.
    await postManualJournal(session, savedId, savedAt);
  } catch (error) {
    const refused = refusal("post journal", error);
    // A new journal now exists as a draft: open it, so a second try does not make a second one.
    // The draft's own page works out again why it could not be posted; nothing is carried in the address.
    if (id === null) return { location: `/journals/${savedId}?refused=1` };
    refresh();
    return { error: `Saved as a draft, but not posted. ${refused.error}` };
  }
  if (id === null) return { location: `/journals/${savedId}` };
  refresh();
  return {};
}

export async function discardJournalAction(id: string, loadedAt: string): Promise<FormState> {
  const session = await requireTenant();
  try {
    await discardDraft(session, id, loadedAt);
  } catch (error) {
    return refusal("discard journal", error);
  }
  return { location: "/journals" };
}

export async function reverseJournalAction(id: string, loadedAt: string, _: FormState, formData: FormData): Promise<FormState> {
  const session = await requireTenant();
  try {
    await reverseManualJournal(session, id, { date: formData.get("date") }, loadedAt);
  } catch (error) {
    return refusal("reverse journal", error);
  }
  refresh();
  return {};
}

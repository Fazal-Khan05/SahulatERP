"use server";

import { refresh } from "next/cache";
import { requireTenant } from "@/lib/auth/session";
import { UserError, logFailure } from "@/lib/errors";
import type { FormState } from "@/lib/form-state";
import { applyCredit, postCreditNote, saveCreditNoteDraft, startCreditNote } from "@/modules/credit-notes/commands";

// Credit notes and sales returns. The company always comes from the verified session, never
// from the form. Ids arrive bound to the action and are checked again in the command.

/** The signed-in member's session, refused when the company has switched Sales off. */
async function requireSales() {
  const session = await requireTenant();
  if (!session.modules.sales) throw new UserError("Sales is switched off for this company.");
  return session;
}

function refusal(context: string, error: unknown): FormState {
  if (error instanceof UserError) return { error: error.message };
  logFailure(context, error);
  return { error: "That did not work. Please try again." };
}

/** Starts a credit note for a posted sales invoice (or opens the draft it already has). */
export async function startCreditNoteAction(invoiceId: string): Promise<FormState> {
  try {
    const session = await requireSales();
    const creditNote = await startCreditNote(session, invoiceId);
    return { location: `/sales/${creditNote.id}` };
  } catch (error) {
    return refusal("start credit note", error);
  }
}

/**
 * Saves a draft credit note and, when asked, posts it. The draft is saved first, in its own
 * transaction, so what was typed is kept if posting is refused.
 */
export async function saveCreditNoteAction(id: string, loadedAt: string, _: FormState, formData: FormData): Promise<FormState> {
  const post = formData.get("intent") === "post";
  const sourceLineIds = formData.getAll("sourceLineId");
  const quantities = formData.getAll("quantity");
  const damaged = formData.getAll("damaged");
  let session: Awaited<ReturnType<typeof requireSales>>;
  let savedAt: Date;
  let changed: boolean;
  try {
    session = await requireSales();
    ({ updatedAt: savedAt, changed } = await saveCreditNoteDraft(
      session,
      id,
      { date: formData.get("date"), notes: formData.get("notes"), reference: formData.get("reference"), lines: sourceLineIds.map((sourceLineId, index) => ({ sourceLineId, quantity: quantities[index], damaged: damaged[index] })) },
      loadedAt,
    ));
  } catch (error) {
    return refusal("save credit note", error);
  }
  if (!post) {
    refresh();
    return { message: "Draft saved." };
  }
  // A credit note cannot be taken back once posted, so it is posted only as the page showed it.
  // If saving changed the date, a quantity or a figure, the new figures are shown first.
  if (changed) {
    refresh();
    return { message: "Saved, not posted yet: the figures below have changed. Check them, then post the credit note." };
  }
  try {
    await postCreditNote(session, id, savedAt);
  } catch (error) {
    const refused = refusal("post credit note", error);
    refresh();
    return { error: `Saved as a draft, but not posted. ${refused.error}` };
  }
  refresh();
  return {};
}

/** Sets credit a posted credit note left with the customer against the customer's unpaid invoices. */
export async function applyCreditAction(id: string, _: FormState, formData: FormData): Promise<FormState> {
  const kinds = formData.getAll("allocKind");
  const ids = formData.getAll("allocId");
  const amounts = formData.getAll("allocAmount");
  const labels = formData.getAll("allocLabel");
  try {
    const session = await requireSales();
    await applyCredit(session, id, {
      date: formData.get("date"),
      allocations: ids.map((allocId, index) => ({ kind: kinds[index], id: allocId, amount: amounts[index], label: typeof labels[index] === "string" && labels[index] !== "" ? (labels[index] as string) : undefined })),
    });
  } catch (error) {
    return refusal("apply credit", error);
  }
  refresh();
  return {};
}

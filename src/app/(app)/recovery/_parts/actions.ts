"use server";

import { refresh } from "next/cache";
import { requireTenant } from "@/lib/auth/session";
import { UserError, logFailure } from "@/lib/errors";
import { todayIso } from "@/lib/format";
import type { FormState } from "@/lib/form-state";
import { addFollowUp, addPromise } from "@/modules/recovery/commands";

// Step 33: recording follow-ups and promises. The company comes from the verified session; the
// customer's id arrives bound to the action and is checked again by the database.

async function requireCollections() {
  const session = await requireTenant();
  if (!session.modules.collections) throw new UserError("Collections is switched off for this company.");
  return session;
}

function refusal(context: string, error: unknown): FormState {
  if (error instanceof UserError) return { error: error.message };
  logFailure(context, error);
  return { error: "That did not work. Please try again." };
}

export async function addFollowUpAction(customerId: string, _: FormState, formData: FormData): Promise<FormState> {
  try {
    const session = await requireCollections();
    await addFollowUp(session, customerId, { note: formData.get("note"), nextOn: formData.get("nextOn") }, todayIso(new Date()));
    refresh();
    return { ok: true, message: "Follow-up saved." };
  } catch (error) {
    return refusal("add follow-up", error);
  }
}

export async function addPromiseAction(customerId: string, _: FormState, formData: FormData): Promise<FormState> {
  try {
    const session = await requireCollections();
    await addPromise(session, customerId, { amount: formData.get("amount"), promisedOn: formData.get("promisedOn"), note: formData.get("note") }, todayIso(new Date()));
    refresh();
    return { ok: true, message: "Promise saved." };
  } catch (error) {
    return refusal("add promise", error);
  }
}

"use server";

import { refresh } from "next/cache";
import { requireTenant } from "@/lib/auth/session";
import { UserError, logFailure } from "@/lib/errors";
import type { FormState } from "@/lib/form-state";
import { createBranch, inviteMember } from "@/modules/tenant/commands";

// The company always comes from the verified session, never from the form.

function refusal(context: string, error: unknown): FormState {
  if (error instanceof UserError) return { error: error.message };
  logFailure(context, error);
  return { error: "That did not work. Please try again." };
}

export async function createBranchAction(_: FormState, formData: FormData): Promise<FormState> {
  const session = await requireTenant();
  try {
    await createBranch(session, formData.get("name"));
  } catch (error) {
    return refusal("create branch", error);
  }
  refresh();
  return { ok: true };
}

export async function inviteMemberAction(_: FormState, formData: FormData): Promise<FormState> {
  const session = await requireTenant();
  try {
    await inviteMember(session, {
      email: formData.get("email"),
      role: formData.get("role"),
      branchIds: formData.get("scope") === "all" ? null : formData.getAll("branchIds"),
    });
  } catch (error) {
    return refusal("invite member", error);
  }
  refresh();
  return { ok: true, message: "Invitation recorded. It is sent the next time invitations are sent out." };
}

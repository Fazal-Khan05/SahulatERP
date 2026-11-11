"use server";

import { refresh } from "next/cache";
import { requireTenant } from "@/lib/auth/session";
import { UserError, logFailure } from "@/lib/errors";
import type { FormState } from "@/lib/form-state";
import { createBranch, inviteMember, setModuleEnabled, updateBranding } from "@/modules/tenant/commands";
import { LOGO_MAX_BYTES } from "@/modules/tenant/rules";

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

export async function updateBrandingAction(_: FormState, formData: FormData): Promise<FormState> {
  const session = await requireTenant();
  const file = formData.get("logo");
  let logo: Uint8Array | null | undefined;
  if (formData.get("removeLogo") === "on") {
    logo = null;
  } else if (file instanceof File && file.size > 0) {
    if (file.size > LOGO_MAX_BYTES) return { error: "The logo must be 256 KB or smaller." };
    logo = new Uint8Array(await file.arrayBuffer());
  }
  try {
    await updateBranding(session, { productName: formData.get("productName"), logo });
  } catch (error) {
    return refusal("update settings", error);
  }
  refresh();
  return { ok: true, message: "Saved." };
}

export async function setModuleAction(_: FormState, formData: FormData): Promise<FormState> {
  const session = await requireTenant();
  try {
    await setModuleEnabled(session, formData.get("module"), formData.get("enabled") === "true");
  } catch (error) {
    return refusal("switch module", error);
  }
  refresh();
  return {};
}

"use server";

import { refresh } from "next/cache";
import { requireTenant } from "@/lib/auth/session";
import { UserError, logFailure } from "@/lib/errors";
import type { FormState } from "@/lib/form-state";
import { setReturnProvince } from "@/modules/tax-return/queries";

// The company always comes from the verified session, never from the form.

/** Sets the province the company supplies from, which Annex-C asks for. */
export async function setProvinceAction(_: FormState, formData: FormData): Promise<FormState> {
  const session = await requireTenant();
  try {
    await setReturnProvince(session, formData.get("province"));
  } catch (error) {
    if (error instanceof UserError) return { error: error.message };
    logFailure("set the return's province", error);
    return { error: "That did not work. Please try again." };
  }
  refresh();
  return { message: "Saved." };
}

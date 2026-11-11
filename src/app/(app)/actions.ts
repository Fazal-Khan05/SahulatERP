"use server";

import { cookies } from "next/headers";
import { ACTIVE_TENANT_COOKIE, activeTenantCookieOptions, requireUser } from "@/lib/auth/session";
import { logFailure } from "@/lib/errors";
import type { FormState } from "@/lib/form-state";
import { listMyMemberships } from "@/modules/tenant/queries";

/**
 * Switches the company the user is working in. The id comes from the browser, so it is honoured
 * only if the user is an active member of that company; anything else is ignored.
 */
export async function switchTenantAction(_: FormState, formData: FormData): Promise<FormState> {
  const user = await requireUser();
  const tenantId = formData.get("tenantId");
  try {
    const memberships = await listMyMemberships(user.id);
    if (typeof tenantId === "string" && memberships.some((m) => m.tenantId === tenantId)) {
      (await cookies()).set(ACTIVE_TENANT_COOKIE, tenantId, activeTenantCookieOptions);
    }
  } catch (error) {
    logFailure("switch company", error);
    return { error: "Could not switch. Try again." };
  }
  return { location: "/" };
}

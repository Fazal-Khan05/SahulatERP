"use server";

import { cookies } from "next/headers";
import { ACTIVE_TENANT_COOKIE, activeTenantCookieOptions, requireUser } from "@/lib/auth/session";
import { UserError, logFailure } from "@/lib/errors";
import type { FormState } from "@/lib/form-state";
import { createCompany } from "@/modules/tenant/commands";

export async function createCompanyAction(_: FormState, formData: FormData): Promise<FormState> {
  const user = await requireUser();
  if (!user.canCreateCompany) return { error: "Your account cannot create a company. Ask the owner to invite you." };

  let tenantId: string;
  try {
    tenantId = await createCompany(user, formData.get("name"));
  } catch (error) {
    if (error instanceof UserError) return { error: error.message };
    logFailure("create company", error);
    return { error: "We could not create the company. Please try again." };
  }
  (await cookies()).set(ACTIVE_TENANT_COOKIE, tenantId, activeTenantCookieOptions);
  return { location: "/" };
}

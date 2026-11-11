import "server-only";
import { cache } from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { loadWorkspace, type Branding } from "@/modules/tenant/queries";
import type { MembershipSummary, ModuleState, TenantContext } from "@/modules/tenant/rules";

export const ACTIVE_TENANT_COOKIE = "active_tenant";

export const activeTenantCookieOptions = {
  httpOnly: true,
  sameSite: "lax",
  secure: process.env.NODE_ENV === "production",
  path: "/",
  maxAge: 60 * 60 * 24 * 365,
} as const;

export type SessionUser = {
  id: string;
  email: string;
  /** Set on the account by `npm run owner:create`; members invited into a company do not have it. */
  canCreateCompany: boolean;
};

/**
 * The signed-in user, from the session token after its signature is verified. Never from
 * anything the browser can edit. Null when nobody is signed in.
 */
export const getSessionUser = cache(async (): Promise<SessionUser | null> => {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.getClaims();
  const claims = data?.claims;
  if (error || !claims?.sub) return null;
  const appMetadata = (claims.app_metadata ?? {}) as Record<string, unknown>;
  return {
    id: claims.sub,
    email: typeof claims.email === "string" ? claims.email : "",
    canCreateCompany: appMetadata.can_create_company === true,
  };
});

export async function requireUser(): Promise<SessionUser> {
  const user = await getSessionUser();
  if (!user) redirect("/sign-in");
  return user;
}

export type TenantSession = TenantContext & {
  /** Every company the user is an active member of, for the switcher. */
  memberships: MembershipSummary[];
  canCreateCompany: boolean;
  /** What this company calls the product, and its logo. */
  branding: Branding;
  /** Which modules this company has switched on. */
  modules: ModuleState;
};

/**
 * The company this request runs in. The cookie only states a preference: it is honoured when the
 * user is an active member of that company and ignored otherwise, and the database checks the
 * membership again on every query.
 */
export const getTenantSession = cache(async (): Promise<TenantSession | null> => {
  const user = await requireUser();
  const preferred = (await cookies()).get(ACTIVE_TENANT_COOKIE)?.value;
  const { memberships, active } = await loadWorkspace(user.id, preferred);
  if (!active) return null;
  return {
    userId: user.id,
    email: user.email,
    tenantId: active.tenantId,
    tenantName: active.tenantName,
    role: active.role,
    branchIds: active.branchIds,
    memberships,
    canCreateCompany: user.canCreateCompany,
    branding: active.branding,
    modules: active.modules,
  };
});

export async function requireTenant(): Promise<TenantSession> {
  const session = await getTenantSession();
  if (!session) redirect("/create-company");
  return session;
}

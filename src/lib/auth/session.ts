import "server-only";
import { cache } from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import {
  proofsOf,
  sessionTooOld,
  twoStepGate,
  twoStepRequiredFor,
  twoStepRequiredOfCreator,
  type ProofEntry,
  type TwoStepGate,
} from "./rules";
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

/** The signed-in account as the verified token states it, before any two-step check. */
export type SignedInAccount = SessionUser & {
  /** `aal2` once an authenticator code was given in this session. */
  level: string | undefined;
  proofs: ProofEntry[];
  /** Whether the account has an authenticator app; asked of Supabase Auth only when it matters. */
  hasFactor: boolean;
  gate: TwoStepGate;
};

/**
 * The signed-in account, from the session token after its signature is verified. Never from
 * anything the browser can edit. Null when nobody is signed in or the session has run its full
 * length (src/proxy.ts also ends it; this is the check that does not depend on the proxy).
 *
 * A session without a code (`aal1`) asks Supabase Auth whether the account has an authenticator
 * app: the token does not say, and the cookie's copy of the account is the browser's to edit.
 * That asking also refuses a session ended elsewhere. A session with a code needs no asking.
 */
export const getSignedInAccount = cache(async (): Promise<SignedInAccount | null> => {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.getClaims();
  const claims = data?.claims;
  if (error || !claims?.sub) return null;
  const proofs = proofsOf(claims.amr);
  if (sessionTooOld(proofs)) return null;
  const appMetadata = (claims.app_metadata ?? {}) as Record<string, unknown>;
  const user: SessionUser = {
    id: claims.sub,
    email: typeof claims.email === "string" ? claims.email : "",
    canCreateCompany: appMetadata.can_create_company === true,
  };
  const level = typeof claims.aal === "string" ? claims.aal : undefined;
  let hasFactor = false;
  if (level !== "aal2") {
    const { data: factors, error: factorError } = await supabase.auth.mfa.listFactors();
    // Supabase Auth could not say: the session may have been ended elsewhere. Not signed in.
    if (factorError || !factors) return null;
    hasFactor = factors.totp.length > 0;
  }
  // Whoever may create a company is about to be its owner, so is held to the owner's rule.
  const gate = twoStepGate({ level, hasFactor, required: twoStepRequiredOfCreator(user.canCreateCompany) });
  return { ...user, level, proofs, hasFactor, gate };
});

/**
 * The signed-in user, once any two-step code asked of them is given. Null otherwise. What a
 * member's role in a company asks for besides is checked by getTenantSession().
 */
export const getSessionUser = cache(async (): Promise<SessionUser | null> => {
  const account = await getSignedInAccount();
  if (!account || account.gate !== "ok") return null;
  return { id: account.id, email: account.email, canCreateCompany: account.canCreateCompany };
});

/**
 * Whether the account has an authenticator app now, asked of Supabase Auth. The token's `aal2`
 * says a code was given in this session, which stays true after the app is removed.
 */
export const hasAuthenticator = cache(async (): Promise<boolean> => {
  const supabase = await createSupabaseServerClient();
  const { data } = await supabase.auth.mfa.listFactors();
  return (data?.totp.length ?? 0) > 0;
});

/**
 * True when this member's role in the company needs two-step sign-in and this session has not
 * given a code. For the few addresses that name a company without going through
 * getTenantSession() (the logo).
 */
export async function needsCodeFor(userId: string, tenantId: string): Promise<boolean> {
  if ((await getSignedInAccount())?.level === "aal2") return false;
  const { memberships } = await loadWorkspace(userId, null);
  return memberships.some((m) => m.tenantId === tenantId && m.active && twoStepRequiredFor(m.role));
}

export async function requireUser(): Promise<SessionUser> {
  const account = await getSignedInAccount();
  if (!account) redirect("/sign-in");
  if (account.gate === "code") redirect("/two-step");
  if (account.gate === "setup") redirect("/two-step/setup");
  return { id: account.id, email: account.email, canCreateCompany: account.canCreateCompany };
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
  // An owner or accountant works in this company only once two-step sign-in is on and its code
  // was given in this session. requireUser() has already sent anyone with an app to give the code.
  if (twoStepRequiredFor(active.role) && (await getSignedInAccount())?.level !== "aal2") redirect("/two-step/setup");
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

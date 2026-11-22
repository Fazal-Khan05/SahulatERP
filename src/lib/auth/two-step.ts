"use server";

// Two-step sign-in with an authenticator app (Step 47). The app's secret and the check of each
// code are Supabase Auth's (its TOTP factors): the secret never reaches this app's database, and
// a session that has given a code carries `aal2` in its signed token.

import { logFailure } from "@/lib/errors";
import type { FormState } from "@/lib/form-state";
import { createSupabaseEmailClient, createSupabaseServerClient } from "@/lib/supabase/server";
import { recordAuthEvent } from "@/modules/tenant/commands";
import { loadWorkspace } from "@/modules/tenant/queries";
import { DEFAULT_PRODUCT_NAME } from "@/modules/tenant/rules";
import { requestDetail } from "./request";
import { cleanCode, provedRecently, twoStepRequiredFor } from "./rules";
import { getSignedInAccount } from "./session";

const NOT_RIGHT = "That code is not right. Check the time on your phone and try the newest code.";
const TOO_MANY = "Too many tries. Wait a few minutes, then try again.";
const TRY_AGAIN = "We could not check the code just now. Please try again.";
const ENTER_CODE = "Enter the six-digit code from your authenticator app.";

/** Only these pages may be gone on to after a code; anything else goes home. */
function nextFrom(formData: FormData): string {
  return formData.get("next") === "/reset-password" ? "/reset-password" : "/";
}

function refusalFor(code: string | undefined): string {
  if (code === "over_request_rate_limit" || code === "too_many_requests") return TOO_MANY;
  if (code === "mfa_verification_failed" || code === "mfa_challenge_expired") return NOT_RIGHT;
  return TRY_AGAIN;
}

/** The code asked for after the password, from an account that already has an app. */
export async function giveCodeAction(_: FormState, formData: FormData): Promise<FormState> {
  const account = await getSignedInAccount();
  if (!account) return { location: "/sign-in" };
  if (account.gate !== "code") return { location: nextFrom(formData) };
  const code = cleanCode(formData.get("code"));
  if (!code) return { error: ENTER_CODE };

  const supabase = await createSupabaseServerClient();
  const { data: factors, error: listError } = await supabase.auth.mfa.listFactors();
  const factor = factors?.totp[0];
  if (listError || !factor) return { location: "/sign-in" };

  const detail = await requestDetail();
  const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId: factor.id, code });
  if (error) {
    try {
      await recordAuthEvent(account.id, "auth.two_step_failed", detail);
    } catch (failure) {
      logFailure("two-step failure audit", failure);
    }
    if (refusalFor(error.code) === TRY_AGAIN) logFailure(`two-step code (${error.code ?? "unknown"})`, error);
    return { error: refusalFor(error.code) };
  }

  try {
    await recordAuthEvent(account.id, "auth.two_step_passed", detail);
  } catch (failure) {
    // No sign-in without its audit row.
    logFailure("two-step audit", failure);
    await supabase.auth.signOut({ scope: "local" });
    return { error: "We could not sign you in just now. Please try again.", location: "/sign-in" };
  }
  return { location: nextFrom(formData) };
}

export type SetupState = FormState & {
  /** The factor being set up, shown as a QR code and as text for typing in by hand. */
  factorId?: string;
  qr?: string;
  secret?: string;
};

/** A data URL an <img> can show, from the QR code Supabase Auth returns (an SVG). */
function qrImage(qr: string): string {
  const svg = qr.replace(/^data:image\/svg\+xml;(utf-8|charset=utf-8),/, "");
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/**
 * Starts setting up an authenticator app: a new secret, shown once, not yet in force. A session
 * whose password or email link is more than a few minutes old must give the current password:
 * whoever holds an old session of a member without an app could otherwise set up their own.
 */
export async function startSetupAction(_: SetupState, formData: FormData): Promise<SetupState> {
  const account = await getSignedInAccount();
  if (!account) return { location: "/sign-in" };
  if (account.gate === "code") return { location: "/two-step" };
  if (!provedRecently(account.proofs)) {
    const current = formData.get("current");
    if (typeof current !== "string" || !current) return { error: "Enter your current password." };
    if (!(await passwordIsRight(account.email, current))) return { error: "The current password is not right." };
  }

  const supabase = await createSupabaseServerClient();
  const { data: factors, error: listError } = await supabase.auth.mfa.listFactors();
  if (listError || !factors) return { error: TRY_AGAIN };
  if (factors.totp.length > 0) return { error: "Two-step sign-in is already on for your account." };
  // A setup started and left unfinished: its secret was shown once and is put away.
  for (const stale of factors.all.filter((f) => f.factor_type === "totp" && f.status === "unverified")) {
    const { error } = await supabase.auth.mfa.unenroll({ factorId: stale.id });
    if (error) logFailure(`two-step stale setup (${error.code ?? "unknown"})`, error);
  }

  const { data, error } = await supabase.auth.mfa.enroll({
    factorType: "totp",
    friendlyName: `Authenticator app ${Date.now()}`,
    issuer: DEFAULT_PRODUCT_NAME,
  });
  if (error || !data) {
    logFailure(`two-step setup (${error?.code ?? "unknown"})`, error);
    return { error: "We could not start the setup just now. Please try again." };
  }
  return { factorId: data.id, qr: qrImage(data.totp.qr_code), secret: data.totp.secret };
}

/**
 * Finishes the setup with the first code the app shows; two-step sign-in is then on. Only for
 * the factor this account has just started setting up: a code for an app already in use is given
 * on the code page, where a wrong one is recorded.
 */
export async function finishSetupAction(_: FormState, formData: FormData): Promise<FormState> {
  const account = await getSignedInAccount();
  if (!account) return { location: "/sign-in" };
  if (account.gate === "code") return { location: "/two-step" };
  const factorId = formData.get("factorId");
  if (typeof factorId !== "string" || !factorId) return { error: "Start the setup again." };
  const code = cleanCode(formData.get("code"));
  if (!code) return { error: ENTER_CODE };

  const supabase = await createSupabaseServerClient();
  const { data: factors, error: listError } = await supabase.auth.mfa.listFactors();
  if (listError || !factors) return { error: TRY_AGAIN };
  const pending = factors.all.some((f) => f.id === factorId && f.factor_type === "totp" && f.status === "unverified");
  if (!pending) return { error: "Start the setup again." };

  const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId, code });
  if (error) {
    if (refusalFor(error.code) === TRY_AGAIN) logFailure(`two-step setup code (${error.code ?? "unknown"})`, error);
    return { error: refusalFor(error.code) };
  }
  try {
    await recordAuthEvent(account.id, "auth.two_step_on", await requestDetail());
  } catch (failure) {
    // It is on already; the history misses one row, as with a password change.
    logFailure("two-step on audit", failure);
  }
  return { location: "/" };
}

/** Checks a password without keeping the session the check makes. */
async function passwordIsRight(email: string, password: string): Promise<boolean> {
  const check = createSupabaseEmailClient();
  const { error } = await check.auth.signInWithPassword({ email, password });
  if (error) return false;
  await check.auth.signOut({ scope: "local" });
  return true;
}

/**
 * Turns two-step sign-in off, for a member whose roles do not ask for it. Supabase Auth itself
 * refuses unless this session has given a code.
 */
export async function removeTwoStepAction(): Promise<FormState> {
  const account = await getSignedInAccount();
  if (!account || account.gate !== "ok") return { location: "/sign-in" };

  const { memberships } = await loadWorkspace(account.id, null);
  if (account.canCreateCompany || memberships.some((m) => m.active && twoStepRequiredFor(m.role))) {
    return { error: "Your role needs two-step sign-in, so it stays on." };
  }

  const supabase = await createSupabaseServerClient();
  const { data: factors, error: listError } = await supabase.auth.mfa.listFactors();
  if (listError || !factors) return { error: TRY_AGAIN };
  if (factors.totp.length === 0) return { error: "Two-step sign-in is not on for your account." };
  for (const factor of factors.all.filter((f) => f.factor_type === "totp")) {
    const { error } = await supabase.auth.mfa.unenroll({ factorId: factor.id });
    if (error) {
      logFailure(`two-step off (${error.code ?? "unknown"})`, error);
      return { error: "We could not turn it off just now. Please try again." };
    }
  }
  try {
    await recordAuthEvent(account.id, "auth.two_step_off", await requestDetail());
  } catch (failure) {
    logFailure("two-step off audit", failure);
  }
  return { location: "/account" };
}

/** Ends every session of this account, on every device. */
export async function signOutEverywhereAction(): Promise<FormState> {
  const account = await getSignedInAccount();
  if (!account || account.gate !== "ok") return { location: "/sign-in" };
  try {
    await recordAuthEvent(account.id, "auth.sign_out_everywhere", await requestDetail());
  } catch (failure) {
    logFailure("sign-out everywhere audit", failure);
  }
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.auth.signOut({ scope: "global" });
  if (error) {
    logFailure(`sign-out everywhere (${error.code ?? "unknown"})`, error);
    return { error: "We could not sign out the other devices just now. Please try again." };
  }
  return { location: "/sign-in" };
}

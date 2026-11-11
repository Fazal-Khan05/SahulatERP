"use server";

import { appUrl } from "@/lib/app-url";
import { getSessionUser } from "@/lib/auth/session";
import { logFailure } from "@/lib/errors";
import type { FormState } from "@/lib/form-state";
import { createSupabaseEmailClient, createSupabaseServerClient } from "@/lib/supabase/server";
import { recordAuthEvent } from "@/modules/tenant/commands";
import { emailSchema, firstIssue, newPasswordSchema, signInSchema } from "@/modules/tenant/rules";

const TRY_AGAIN = "We could not sign you in just now. Please try again.";

export async function signInAction(_: FormState, formData: FormData): Promise<FormState> {
  const input = signInSchema.safeParse({ email: formData.get("email"), password: formData.get("password") });
  if (!input.success) return { error: firstIssue(input.error) };

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.signInWithPassword(input.data);
  if (error || !data.user) return { error: "The email or password is not right." };

  let companies: number;
  try {
    companies = (await recordAuthEvent(data.user.id, "auth.sign_in", { method: "password" })).length;
  } catch (failure) {
    // No sign-in without its audit row.
    logFailure("sign-in audit", failure);
    await supabase.auth.signOut({ scope: "local" });
    return { error: TRY_AGAIN };
  }
  return { location: companies > 0 ? "/" : "/create-company" };
}

export async function forgotPasswordAction(_: FormState, formData: FormData): Promise<FormState> {
  const email = emailSchema.safeParse(formData.get("email"));
  if (!email.success) return { error: firstIssue(email.error) };

  const { error } = await createSupabaseEmailClient().auth.resetPasswordForEmail(email.data, {
    redirectTo: `${appUrl()}/auth/confirm`,
  });
  if (error) logFailure(`password reset request (${error.code ?? "unknown"})`, error);
  // The same answer whether or not the address has an account.
  return { ok: true, message: "If that address has an account, a link to choose a new password is on its way." };
}

const LINK_EXPIRED = "This link has expired or was already used. Ask for a new one.";
const LINK_INVALID = "This link is not valid. Ask for a new one.";

export type LinkState = FormState & { email?: string };

function linkTokens(formData: FormData): { accessToken: string; refreshToken: string } | null {
  const accessToken = formData.get("access_token");
  const refreshToken = formData.get("refresh_token");
  if (typeof accessToken !== "string" || !accessToken || typeof refreshToken !== "string" || !refreshToken) return null;
  return { accessToken, refreshToken };
}

// Invite and password-reset links. Supabase Auth checks the one-time token in the email link
// itself and sends the browser to /auth/confirm with a session in the address fragment. That
// session is not accepted on sight: anyone can build such a link around their own account and
// send it to someone else. So the page first asks whose account it is and shows that, and only
// stores the session once the reader presses Continue.

/** Step one: check the session the link carries and say whose account it is. Stores nothing. */
export async function inspectLinkAction(_: LinkState, formData: FormData): Promise<LinkState> {
  const tokens = linkTokens(formData);
  if (!tokens) return { error: formData.get("error_code") ? LINK_EXPIRED : LINK_INVALID };

  const { data, error } = await createSupabaseEmailClient().auth.getUser(tokens.accessToken);
  if (error || !data.user?.email) return { error: LINK_EXPIRED };
  return { email: data.user.email };
}

/** Step two, after Continue: verify the session with Supabase Auth again and store it in cookies. */
export async function confirmSessionAction(_: FormState, formData: FormData): Promise<FormState> {
  const tokens = linkTokens(formData);
  if (!tokens) return { error: LINK_INVALID };

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.setSession({
    access_token: tokens.accessToken,
    refresh_token: tokens.refreshToken,
  });
  if (error || !data.user) return { error: LINK_EXPIRED };

  try {
    await recordAuthEvent(data.user.id, "auth.sign_in", {
      method: formData.get("type") === "invite" ? "invite" : "recovery",
    });
  } catch (failure) {
    logFailure("link sign-in audit", failure);
    await supabase.auth.signOut({ scope: "local" });
    return { error: TRY_AGAIN };
  }
  return { location: "/reset-password" };
}

export async function setPasswordAction(_: FormState, formData: FormData): Promise<FormState> {
  const input = newPasswordSchema.safeParse({ password: formData.get("password"), confirm: formData.get("confirm") });
  if (!input.success) return { error: firstIssue(input.error) };

  const user = await getSessionUser();
  if (!user) return { error: "Your link has expired. Ask for a new one." };

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.auth.updateUser({ password: input.data.password });
  if (error) {
    if (error.code === "same_password") return { error: "Choose a password you have not used here before." };
    if (error.code === "weak_password") return { error: "That password is too easy to guess. Choose a longer one." };
    logFailure(`set password (${error.code ?? "unknown"})`, error);
    return { error: "We could not save the password. Please try again." };
  }

  try {
    await recordAuthEvent(user.id, "auth.password_set");
  } catch (failure) {
    logFailure("password audit", failure);
  }
  return { location: "/" };
}

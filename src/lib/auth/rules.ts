// Rules of signing in (Step 47), kept free of Next.js and Supabase so they can be tested alone.
// The numbers are decisions for the founder to confirm (docs/later/step-47.md).

import type { MemberRole as Role } from "@/modules/tenant/rules";

/** A session nobody has used for this long is ended. */
export const IDLE_MINUTES = 60;
/** However busy, a session ends this long after the password was entered; then sign in again. */
export const MAX_SESSION_HOURS = 12;
/** Changing the password needs a sign-in at most this old, or the current password. */
export const RECENT_SIGN_IN_MINUTES = 10;

/** The roles that may not use the app until two-step sign-in is on. */
const TWO_STEP_ROLES: ReadonlySet<Role> = new Set<Role>(["owner", "accountant"]);

export function twoStepRequiredFor(role: Role): boolean {
  return TWO_STEP_ROLES.has(role);
}

/** One way the session was proven, as the token lists it, with when (seconds since 1970). */
export type ProofEntry = { method: string; timestamp: number };

/** The token's `amr` claim, read defensively: anything malformed is left out. */
export function proofsOf(amr: unknown): ProofEntry[] {
  if (!Array.isArray(amr)) return [];
  return amr.flatMap((entry) =>
    entry && typeof entry === "object" && typeof entry.method === "string" && typeof entry.timestamp === "number"
      ? [{ method: entry.method, timestamp: entry.timestamp }]
      : [],
  );
}

/**
 * When this session began: the earliest proof it carries. A token refreshed keeps its proofs, so
 * this does not move while the session lasts. Null when the token carries none.
 */
export function sessionStartedAt(proofs: ProofEntry[]): number | null {
  if (proofs.length === 0) return null;
  return Math.min(...proofs.map((p) => p.timestamp));
}

/**
 * When the member last proved who they are in this session with something only they should know
 * or receive: a password or an email link. An authenticator code does not count: whoever holds an
 * old session of a member without an app could set up an app of their own and give its code.
 */
export function lastProvedAt(proofs: ProofEntry[]): number | null {
  const first = proofs.filter((p) => p.method !== "totp" && !p.method.startsWith("mfa"));
  if (first.length === 0) return null;
  return Math.max(...first.map((p) => p.timestamp));
}

/** Seconds since 1970. */
export const nowInSeconds = () => Math.floor(Date.now() / 1000);

/** True when the session has run its full length. A token with no proofs is taken as too old. */
export function sessionTooOld(proofs: ProofEntry[], now = nowInSeconds()): boolean {
  const started = sessionStartedAt(proofs);
  return started === null || now - started > MAX_SESSION_HOURS * 3600;
}

/** True when the member proved who they are recently enough to change the password. */
export function provedRecently(proofs: ProofEntry[], now = nowInSeconds()): boolean {
  const last = lastProvedAt(proofs);
  return last !== null && now - last <= RECENT_SIGN_IN_MINUTES * 60;
}

/** How long a signed-in session may go without its idle-time cookie (src/lib/auth/activity-cookie.ts). */
export const FRESH_SIGN_IN_SECONDS = 120;

/**
 * True when the session counts as idle: its last use is longer ago than the idle limit, or there
 * is no trustworthy record of it (the cookie missing, forged, or for another session) and the
 * member did not sign in just now. A session cannot be kept alive by leaving the cookie out.
 */
export function idleTooLong(lastActive: number | null, proofs: ProofEntry[], now = nowInSeconds()): boolean {
  if (lastActive !== null) return now - lastActive > IDLE_MINUTES * 60;
  const last = lastProvedAt(proofs);
  return last === null || now - last > FRESH_SIGN_IN_SECONDS;
}

/**
 * Where a signed-in member stands with two-step sign-in:
 * - `code`: they have an authenticator app and have not given its code in this session;
 * - `setup`: they must set one up before going on;
 * - `ok`: nothing is asked.
 */
export type TwoStepGate = "ok" | "code" | "setup";

export function twoStepGate(input: { level: string | undefined; hasFactor: boolean; required: boolean }): TwoStepGate {
  if (input.level === "aal2") return "ok";
  if (input.hasFactor) return "code";
  return input.required ? "setup" : "ok";
}

/** A six-digit code from an authenticator app, with any spaces taken out. */
export function cleanCode(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const code = value.replace(/\s+/g, "");
  return /^\d{6}$/.test(code) ? code : null;
}

/** "Chrome on Windows" from a browser's user agent; a short, coarse summary for the sign-in history. */
export function deviceOf(userAgent: string | null | undefined): string {
  const ua = userAgent ?? "";
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /OPR\/|Opera/.test(ua)
      ? "Opera"
      : /Firefox\//.test(ua)
        ? "Firefox"
        : /Chrome\//.test(ua)
          ? "Chrome"
          : /Safari\//.test(ua)
            ? "Safari"
            : null;
  const system = /Android/.test(ua)
    ? "Android"
    : /iPhone|iPad|iPod/.test(ua)
      ? "iOS"
      : /Windows/.test(ua)
        ? "Windows"
        : /Mac OS X|Macintosh/.test(ua)
          ? "Mac"
          : /Linux/.test(ua)
            ? "Linux"
            : null;
  if (browser && system) return `${browser} on ${system}`;
  return browser ?? system ?? "Unknown device";
}

/** The first address in X-Forwarded-For, if it looks like an IP address; else null. */
export function clientAddressOf(forwardedFor: string | null | undefined): string | null {
  const first = (forwardedFor ?? "").split(",")[0]?.trim() ?? "";
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(first)) return first;
  if (/^[0-9a-fA-F:]{2,39}$/.test(first) && first.includes(":")) return first;
  return null;
}

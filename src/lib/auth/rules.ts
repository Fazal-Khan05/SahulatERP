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

/** When the member last proved who they are in this session (a password, a code, an email link). */
export function lastProvedAt(proofs: ProofEntry[]): number | null {
  if (proofs.length === 0) return null;
  return Math.max(...proofs.map((p) => p.timestamp));
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

/** The idle-time cookie's value, or null when it is missing or not a time. */
export function lastActiveFrom(value: string | undefined): number | null {
  if (!value || !/^\d{1,12}$/.test(value)) return null;
  return Number(value);
}

/** True when the browser has not been used for longer than the idle limit. */
export function idleTooLong(lastActive: number | null, now = nowInSeconds()): boolean {
  return lastActive !== null && now - lastActive > IDLE_MINUTES * 60;
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

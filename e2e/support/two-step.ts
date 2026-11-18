import type { BrowserContext } from "@playwright/test";
import * as OTPAuth from "otpauth";

// Test support only: the codes an authenticator app would show for a synthetic account's key.
// The keys are made by Supabase Auth for accounts that exist only while the tests run, and are
// kept in memory, never written anywhere.

const PERIOD_MS = 30_000;
const lastStep = new Map<string, number>();

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A code for this key that has not been given before in this run. A code is good for its
 * thirty seconds; when this key's code for the present thirty seconds was already given, or the
 * thirty seconds are nearly over, this waits for the next.
 */
export async function freshCode(secret: string): Promise<string> {
  const totp = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(secret), digits: 6, period: 30, algorithm: "SHA1" });
  let now = Date.now();
  let step = Math.floor(now / PERIOD_MS);
  if (lastStep.get(secret) === step || now % PERIOD_MS > PERIOD_MS - 3000) {
    await sleep((step + 1) * PERIOD_MS - now + 250);
    now = Date.now();
    step = Math.floor(now / PERIOD_MS);
  }
  lastStep.set(secret, step);
  return totp.generate({ timestamp: now });
}

/** A key read from the setup page, as the member would type it into an app. */
export function keyFromPage(text: string): string {
  return text.replace(/\s+/g, "");
}

/**
 * The id of the Supabase session this browser holds, read from its session cookie (which
 * @supabase/ssr may split into numbered pieces and writes as "base64-" and the session's JSON).
 */
export async function sessionIdOf(context: BrowserContext): Promise<string> {
  const pieces = (await context.cookies())
    .filter((c) => /^sb-.*-auth-token(\.\d+)?$/.test(c.name))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  const raw = pieces.map((c) => c.value).join("");
  const json = raw.startsWith("base64-") ? Buffer.from(raw.slice("base64-".length), "base64url").toString("utf8") : raw;
  const token = (JSON.parse(json) as { access_token: string }).access_token;
  const claims = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8")) as { session_id: string };
  return claims.session_id;
}

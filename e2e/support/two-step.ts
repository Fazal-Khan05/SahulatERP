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

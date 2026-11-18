import { createHmac, timingSafeEqual } from "node:crypto";

// The idle-time cookie (Step 47): when this browser last used the app, signed so that only the
// server can write it and tied to one session, so it cannot be left out, moved forward or
// carried to another session. Its key is derived from IDENTITY_SIGNING_SECRET for this use alone.
// A deployment without that secret (a local or second development database) signs nothing and
// takes the time as written; the hosted app has the secret.

/** A time this far ahead of the server's clock is taken as forged. */
const CLOCK_SLACK_SECONDS = 60;

function keyFrom(secret: string | undefined): Buffer | null {
  if (!secret || !/^[0-9a-f]{64}$/.test(secret)) return null;
  return createHmac("sha256", Buffer.from(secret, "hex")).update("sahulaterp last-active cookie v1").digest();
}

function signature(key: Buffer, sessionId: string, time: number): string {
  return createHmac("sha256", key).update(`${sessionId}.${time}`).digest("hex");
}

export function signLastActive(time: number, sessionId: string, secret = process.env.IDENTITY_SIGNING_SECRET): string {
  const key = keyFrom(secret);
  return key ? `${time}.${signature(key, sessionId, time)}` : String(time);
}

/**
 * The time in the cookie, or null when it is missing, malformed, signed for another session, or
 * in the future.
 */
export function readLastActive(
  value: string | undefined,
  sessionId: string,
  now: number,
  secret = process.env.IDENTITY_SIGNING_SECRET,
): number | null {
  if (!value) return null;
  const key = keyFrom(secret);
  const match = key ? /^(\d{1,12})\.([0-9a-f]{64})$/.exec(value) : /^(\d{1,12})$/.exec(value);
  if (!match) return null;
  const time = Number(match[1]);
  if (time > now + CLOCK_SLACK_SECONDS) return null;
  if (key) {
    const expected = Buffer.from(signature(key, sessionId, time), "hex");
    const given = Buffer.from(match[2], "hex");
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  }
  return time;
}

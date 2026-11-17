import { createHmac } from "node:crypto";

// The proof of who is signed in that app.enter() checks (drizzle/0030_identity_proof.sql). The
// database does not take the app's word for it: it wants a signature made with a secret that
// only the web app and the database hold, over the user, the company and a time after which the
// proof is no longer good.
//
// No "server-only" marker here, because the tests sign with it too; it reads a secret, so it is
// only ever imported by src/db/with-tenant.ts and by test support.

/**
 * How long a proof is good for, in seconds. It is checked once, when the transaction opens, so
 * this only has to cover the two clocks disagreeing. The database refuses a proof that claims
 * more than ten minutes.
 */
const LIFETIME_SECONDS = 300;

const SECRET = /^[0-9a-f]{64}$/;

export type IdentityProof = { expires: number; signature: string };

/** The exact text that is signed. The database builds the same text from what it is given. */
export function identityMessage(userId: string, tenantId: string | null, expires: number): string {
  return `sahulaterp-identity-v1|${userId.toLowerCase()}|${tenantId?.toLowerCase() ?? ""}|${expires}`;
}

/**
 * The proof for one user in one company (or in none), good from now. Without
 * IDENTITY_SIGNING_SECRET it is empty: a database with no key installed accepts that (a
 * development database), and one with a key refuses it, so a deployment that has lost its
 * secret shows nothing rather than everything.
 */
export function identityProof(userId: string, tenantId: string | null, nowMs: number = Date.now()): IdentityProof {
  const secret = process.env.IDENTITY_SIGNING_SECRET;
  if (!secret) return { expires: 0, signature: "" };
  if (!SECRET.test(secret)) {
    throw new Error("IDENTITY_SIGNING_SECRET must be 64 lower-case hexadecimal characters (32 bytes); see .env.example");
  }
  const expires = Math.floor(nowMs / 1000) + LIFETIME_SECONDS;
  const signature = createHmac("sha256", Buffer.from(secret, "hex")).update(identityMessage(userId, tenantId, expires)).digest("hex");
  return { expires, signature };
}

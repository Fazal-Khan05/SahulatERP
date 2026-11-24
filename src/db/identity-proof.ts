import { createHmac, createPrivateKey, createSign, type KeyObject } from "node:crypto";

// The proof of who is signed in that app.enter() checks (drizzle/0031_identity_proof.sql and the
// security clean-up after Step 47). The database does not take the app's word for it: it wants
// a signature over the user, the company and a time after which the proof is no longer good.
//
// The signature is made in one of two ways, by what the app has been given:
//
//   IDENTITY_SIGNING_KEY     a private key. The database holds only its public half, so nothing
//                            that can be read in the database is of use to someone who wants to
//                            say they are somebody else. This is the way to be on.
//   IDENTITY_SIGNING_SECRET  a secret the app and the database both hold (how it began). Whoever
//                            can read every table of the database can read it there.
//
// With both set, the key is used. With neither, the proof is empty and every database refuses
// it: a deployment that has lost its settings shows nothing rather than everything.
//
// No "server-only" marker here, because the tests sign with it too; it reads a secret, so it is
// only ever imported by src/db/with-tenant.ts and by test support.

/**
 * How long a proof is good for, in seconds. It is checked when the transaction opens, so this
 * only has to cover the two clocks disagreeing and the minute a proof is shown again (below).
 * The database refuses a proof that claims more than ten minutes.
 */
const LIFETIME_SECONDS = 300;

/**
 * How long one proof made with the private key is shown again for the same user and company,
 * in milliseconds. Signing with a private key takes a couple of milliseconds, and the database
 * does not work out again a proof it has just checked on the same connection.
 */
const SHOWN_AGAIN_MS = 60_000;

const SECRET = /^[0-9a-f]{64}$/;
const KEY = /^[A-Za-z0-9+/]{100,}={0,2}$/;

export type IdentityProof = { expires: number; signature: string };

/** The exact text that is signed. The database builds the same text from what it is given. */
export function identityMessage(userId: string, tenantId: string | null, expires: number, version: 1 | 2 = 1): string {
  return `sahulaterp-identity-v${version}|${userId.toLowerCase()}|${tenantId?.toLowerCase() ?? ""}|${expires}`;
}

let loaded: { from: string; key: KeyObject } | null = null;

/** The private key, read once. It must be an RSA key of 2048, 3072 or 4096 bits with the usual exponent: what the database can check. */
function privateKey(encoded: string): KeyObject {
  if (loaded?.from === encoded) return loaded.key;
  const wrong = "IDENTITY_SIGNING_KEY is not a key this app can sign with; make one with: npm run db:identity -- generate-key";
  if (!KEY.test(encoded)) throw new Error(wrong);
  let key: KeyObject;
  try {
    key = createPrivateKey({ key: Buffer.from(encoded, "base64"), format: "der", type: "pkcs8" });
  } catch {
    throw new Error(wrong);
  }
  const details = key.asymmetricKeyDetails;
  if (key.asymmetricKeyType !== "rsa" || ![2048, 3072, 4096].includes(details?.modulusLength ?? 0) || details?.publicExponent !== BigInt(65537)) throw new Error(wrong);
  loaded = { from: encoded, key };
  return key;
}

const shown = new Map<string, { proof: IdentityProof; madeAt: number; from: string }>();

/**
 * The proof for one user in one company (or in none), good from now. Empty when the app has
 * been given nothing to sign with: every database refuses that.
 */
export function identityProof(userId: string, tenantId: string | null, nowMs: number = Date.now()): IdentityProof {
  const encoded = process.env.IDENTITY_SIGNING_KEY;
  if (encoded) {
    const key = privateKey(encoded);
    const who = `${userId.toLowerCase()}|${tenantId?.toLowerCase() ?? ""}`;
    const last = shown.get(who);
    if (last && last.from === encoded && nowMs >= last.madeAt && nowMs - last.madeAt < SHOWN_AGAIN_MS) return last.proof;
    const expires = Math.floor(nowMs / 1000) + LIFETIME_SECONDS;
    const signature = createSign("RSA-SHA256").update(identityMessage(userId, tenantId, expires, 2)).sign(key).toString("hex");
    // Never more than a few thousand people are signed in to one process at once; past that, start again.
    if (shown.size > 5000) shown.clear();
    const proof = { expires, signature };
    shown.set(who, { proof, madeAt: nowMs, from: encoded });
    return proof;
  }
  const secret = process.env.IDENTITY_SIGNING_SECRET;
  if (!secret) return { expires: 0, signature: "" };
  if (!SECRET.test(secret)) {
    throw new Error("IDENTITY_SIGNING_SECRET must be 64 lower-case hexadecimal characters (32 bytes); see .env.example");
  }
  const expires = Math.floor(nowMs / 1000) + LIFETIME_SECONDS;
  const signature = createHmac("sha256", Buffer.from(secret, "hex")).update(identityMessage(userId, tenantId, expires)).digest("hex");
  return { expires, signature };
}

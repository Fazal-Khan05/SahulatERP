import { createHmac, createPublicKey, createVerify, generateKeyPairSync } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { identityMessage, identityProof } from "./identity-proof";
import { enterTenant, type Tx } from "./with-tenant";

// The proof of who is signed in, as the web app makes it. What the database does with it is in
// src/modules/tenant/policies.test.ts and src/modules/ledger/accounts.test.ts.

const SECRET = "0f".repeat(32);
const USER = "11111111-1111-4111-8111-111111111111";
const TENANT = "22222222-2222-4222-8222-222222222222";
const before = process.env.IDENTITY_SIGNING_SECRET;
const beforeKey = process.env.IDENTITY_SIGNING_KEY;
const newKey = (bits = 2048) => generateKeyPairSync("rsa", { modulusLength: bits, publicExponent: 65537 }).privateKey;
const encoded = (key: ReturnType<typeof newKey>) => key.export({ format: "der", type: "pkcs8" }).toString("base64");

afterEach(() => {
  if (before === undefined) delete process.env.IDENTITY_SIGNING_SECRET;
  else process.env.IDENTITY_SIGNING_SECRET = before;
  if (beforeKey === undefined) delete process.env.IDENTITY_SIGNING_KEY;
  else process.env.IDENTITY_SIGNING_KEY = beforeKey;
});

describe("the proof of who is signed in", () => {
  it("signs the user, the company and the time it is good until", () => {
    delete process.env.IDENTITY_SIGNING_KEY;
    process.env.IDENTITY_SIGNING_SECRET = SECRET;
    const proof = identityProof(USER, TENANT, 1_800_000_000_000);
    expect(proof.expires).toBe(1_800_000_300);
    expect(identityMessage(USER, TENANT, proof.expires)).toBe(`sahulaterp-identity-v1|${USER}|${TENANT}|1800000300`);
    expect(proof.signature).toBe(createHmac("sha256", Buffer.from(SECRET, "hex")).update(`sahulaterp-identity-v1|${USER}|${TENANT}|1800000300`).digest("hex"));
    expect(proof.signature).toMatch(/^[0-9a-f]{64}$/);
  });

  it("signs a different thing for another user, another company, no company and another time", () => {
    delete process.env.IDENTITY_SIGNING_KEY;
    process.env.IDENTITY_SIGNING_SECRET = SECRET;
    const at = 1_800_000_000_000;
    const signatures = [
      identityProof(USER, TENANT, at),
      identityProof(TENANT, USER, at),
      identityProof(USER, null, at),
      identityProof(USER, TENANT, at + 1000),
    ].map((proof) => proof.signature);
    expect(new Set(signatures).size).toBe(4);
    expect(identityMessage(USER, null, 5)).toBe(`sahulaterp-identity-v1|${USER}||5`);
    // The database writes ids in lower case, so the app signs them that way however they arrive.
    expect(identityProof(USER.toUpperCase(), TENANT.toUpperCase(), at)).toEqual(identityProof(USER, TENANT, at));
  });

  it("is empty without a secret, and refuses a secret of the wrong shape", () => {
    delete process.env.IDENTITY_SIGNING_SECRET;
    delete process.env.IDENTITY_SIGNING_KEY;
    expect(identityProof(USER, TENANT)).toEqual({ expires: 0, signature: "" });
    for (const bad of ["short", "0F".repeat(32), "zz".repeat(32), SECRET + "00"]) {
      process.env.IDENTITY_SIGNING_SECRET = bad;
      expect(() => identityProof(USER, TENANT), bad).toThrow("IDENTITY_SIGNING_SECRET must be 64 lower-case hexadecimal characters");
    }
  });

  it("signs with the private key when it has one, over a text of its own, and shows one proof for a minute", () => {
    const key = newKey();
    process.env.IDENTITY_SIGNING_SECRET = SECRET;
    process.env.IDENTITY_SIGNING_KEY = encoded(key);
    const at = 1_800_000_000_000;
    const proof = identityProof(USER, TENANT, at);
    expect(proof.expires).toBe(1_800_000_300);
    // 256 bytes for a key of 2048 bits, in lower-case hexadecimal: how the database tells it from the secret's 32.
    expect(proof.signature).toMatch(/^[0-9a-f]{512}$/);
    expect(identityMessage(USER, TENANT, proof.expires, 2)).toBe(`sahulaterp-identity-v2|${USER}|${TENANT}|1800000300`);
    const checks = (text: string) => createVerify("RSA-SHA256").update(text).verify(createPublicKey(key), Buffer.from(proof.signature, "hex"));
    expect([checks(identityMessage(USER, TENANT, proof.expires, 2)), checks(identityMessage(USER, TENANT, proof.expires, 1)), checks(identityMessage(USER, null, proof.expires, 2))]).toEqual([true, false, false]);
    // The same proof for the same user and company for a minute; a new one after, and for anyone else at once.
    expect(identityProof(USER, TENANT, at + 59_000)).toBe(proof);
    expect(identityProof(USER.toUpperCase(), TENANT.toUpperCase(), at + 1_000)).toBe(proof);
    const later = identityProof(USER, TENANT, at + 61_000);
    expect([later.expires, later.signature === proof.signature]).toEqual([1_800_000_361, false]);
    expect(identityProof(USER, null, at + 1_000).signature).not.toBe(proof.signature);
    expect(identityProof(TENANT, USER, at + 1_000).signature).not.toBe(proof.signature);
    // A clock that went back does not bring back an old proof with a later end.
    expect(identityProof(USER, TENANT, at - 5_000).expires).toBe(1_800_000_295);
    // Another key signs afresh, at once.
    process.env.IDENTITY_SIGNING_KEY = encoded(newKey());
    expect(identityProof(USER, TENANT, at - 4_000).signature).not.toBe(identityProof(USER, TENANT, at - 5_000).signature);
  });

  it("refuses a key it cannot sign with, and says nothing of what it was", () => {
    delete process.env.IDENTITY_SIGNING_SECRET;
    const small = generateKeyPairSync("rsa", { modulusLength: 1024, publicExponent: 65537 }).privateKey;
    const odd = generateKeyPairSync("rsa", { modulusLength: 2048, publicExponent: 3 }).privateKey;
    const curve = generateKeyPairSync("ed25519").privateKey;
    for (const bad of ["short", "not base64 !!".repeat(20), "A".repeat(400), encoded(small), encoded(odd), curve.export({ format: "der", type: "pkcs8" }).toString("base64").repeat(3)]) {
      process.env.IDENTITY_SIGNING_KEY = bad;
      let message = "";
      try {
        identityProof(USER, TENANT);
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message, bad.slice(0, 12)).toBe("IDENTITY_SIGNING_KEY is not a key this app can sign with; make one with: npm run db:identity -- generate-key");
    }
  });

  it("keeps the signature out of the error when the database refuses it", async () => {
    delete process.env.IDENTITY_SIGNING_KEY;
    process.env.IDENTITY_SIGNING_SECRET = SECRET;
    // Drizzle's error for a failed statement, as it comes: the parameters are in its message.
    let sent: unknown[] = [];
    const tx = {
      execute: async (statement: { queryChunks: unknown[] }) => {
        sent = statement.queryChunks.filter((chunk) => typeof chunk === "string" || typeof chunk === "number");
        throw Object.assign(new Error(`Failed query: select app.enter($1::uuid, $2::uuid, $3::bigint, $4::text)\nparams: ${sent.join(",")}`), {
          cause: Object.assign(new Error("the proof of who is signed in is out of date"), { code: "42501" }),
        });
      },
    } as unknown as Tx;
    const error = await enterTenant(tx, USER, TENANT).then(
      () => null,
      (e: Error & { code?: string }) => e,
    );
    const signature = sent.find((value) => typeof value === "string" && /^[0-9a-f]{64}$/.test(value)) as string;
    expect(signature).toMatch(/^[0-9a-f]{64}$/);
    expect(error?.message).toBe("The database did not accept who is signed in: the proof of who is signed in is out of date");
    expect(error?.code).toBe("42501");
    expect(JSON.stringify({ message: error?.message, stack: error?.stack, cause: (error as { cause?: unknown } | null)?.cause ?? null })).not.toContain(signature);
    // An error with no cause to quote says nothing of the statement either.
    const bare = { execute: async () => { throw new Error(`Failed query\nparams: ${signature}`); } } as unknown as Tx;
    expect(await enterTenant(bare, USER, TENANT).then(() => null, (e: Error) => e.message)).toBe("The database did not accept who is signed in.");
  });

  it("is the only way the code says who a transaction is", () => {
    // Writing the two settings by hand means nothing to a database with a key installed, so a
    // test or a script that did it would pass on a development database and fail, or prove
    // nothing, on a real one. The files allowed to are the two tests that show the settings are
    // ignored, and the checker's own rule and tests about them.
    const allowed = new Set([
      "src/modules/tenant/policies.test.ts",
      "src/modules/ledger/accounts.test.ts",
      "src/db/identity-proof.test.ts",
      "src/db/migration-rules.test.ts",
      "scripts/lib/migration-rules.mjs",
    ]);
    const setting = /set_config\(\s*['"`]app\.(?:user_id|tenant_id)/;
    const found: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.(ts|tsx|mjs|js)$/.test(name) && !allowed.has(path) && setting.test(readFileSync(path, "utf8"))) found.push(path);
      }
    };
    for (const dir of ["src", "e2e", "tests", "scripts"]) walk(dir);
    expect(found).toEqual([]);
  });
});

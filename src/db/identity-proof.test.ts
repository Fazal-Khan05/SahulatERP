import { createHmac } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { identityMessage, identityProof } from "./identity-proof";

// The proof of who is signed in, as the web app makes it. What the database does with it is in
// src/modules/tenant/policies.test.ts and src/modules/ledger/accounts.test.ts.

const SECRET = "0f".repeat(32);
const USER = "11111111-1111-4111-8111-111111111111";
const TENANT = "22222222-2222-4222-8222-222222222222";
const before = process.env.IDENTITY_SIGNING_SECRET;

afterEach(() => {
  if (before === undefined) delete process.env.IDENTITY_SIGNING_SECRET;
  else process.env.IDENTITY_SIGNING_SECRET = before;
});

describe("the proof of who is signed in", () => {
  it("signs the user, the company and the time it is good until", () => {
    process.env.IDENTITY_SIGNING_SECRET = SECRET;
    const proof = identityProof(USER, TENANT, 1_800_000_000_000);
    expect(proof.expires).toBe(1_800_000_300);
    expect(identityMessage(USER, TENANT, proof.expires)).toBe(`sahulaterp-identity-v1|${USER}|${TENANT}|1800000300`);
    expect(proof.signature).toBe(createHmac("sha256", Buffer.from(SECRET, "hex")).update(`sahulaterp-identity-v1|${USER}|${TENANT}|1800000300`).digest("hex"));
    expect(proof.signature).toMatch(/^[0-9a-f]{64}$/);
  });

  it("signs a different thing for another user, another company, no company and another time", () => {
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
    expect(identityProof(USER, TENANT)).toEqual({ expires: 0, signature: "" });
    for (const bad of ["short", "0F".repeat(32), "zz".repeat(32), SECRET + "00"]) {
      process.env.IDENTITY_SIGNING_SECRET = bad;
      expect(() => identityProof(USER, TENANT), bad).toThrow("IDENTITY_SIGNING_SECRET must be 64 lower-case hexadecimal characters");
    }
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

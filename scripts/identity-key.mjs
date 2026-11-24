// npm run db:identity -- status
// npm run db:identity -- generate-key [file]   a private key for the app (default file .env.local)
// npm run db:identity -- generate [file]       a shared secret, the older way
// npm run db:identity -- install               puts what this working copy signs with into the database:
//                                              the public half of the key if it has one, else the secret
// npm run db:identity -- install --with-secret   the secret as well as the key (only to go back)
// npm run db:identity -- retire-secret --yes   removes the shared secret from the database
// npm run db:identity -- remove <slot> --yes        removes one shared secret
// npm run db:identity -- remove-key <slot> --yes    removes one public key
//
// What is behind the proof of who is signed in (drizzle/0031_identity_proof.sql and the security
// clean-up after Step 47). The web app signs every transaction's "this is user U in company T";
// the database checks the signature and believes nothing else. A database with nothing installed
// shows nothing to anyone.
//
// Two ways to sign, and a database can accept both at once:
//
//   IDENTITY_SIGNING_KEY     a private key, held by the app only. The database gets its public
//                            half (app.identity_public_keys), which is no secret: whoever reads
//                            the database can check a proof and cannot make one.
//   IDENTITY_SIGNING_SECRET  a secret held by both (app.identity_keys). Whoever can read every
//                            table of the database can read it there and sign with it.
//
// Moving a deployed site from the secret to the key, with no moment in which it shows nothing:
//   1. generate-key, then install            (the database now accepts both)
//   2. give the deployed app IDENTITY_SIGNING_KEY and redeploy; check the site
//   3. retire-secret --yes                   (the database now accepts the key only)
//   4. take IDENTITY_SIGNING_SECRET out of the deployed app's settings and out of .env.local
//
// Taking a key or a secret out ends, from the very next statement, whatever was believed by it:
// every transaction remembers which key its proof was checked against, and the database asks
// each time whether that key is still installed.
//
// Nothing here ever prints a secret or a private key. The database is the one named by
// MIGRATION_DATABASE_URL.
import { createHmac, createPrivateKey, createPublicKey, createSign, generateKeyPairSync, randomBytes } from "node:crypto";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import postgres from "postgres";

const SECRET_NAME = "IDENTITY_SIGNING_SECRET";
const KEY_NAME = "IDENTITY_SIGNING_KEY";
const SECRET = /^[0-9a-f]{64}$/;
const [action, ...rest] = process.argv.slice(2);

function fail(message) {
  console.error(message);
  process.exit(1);
}

/** The two halves HMAC-SHA256 hashes with: the key, filled to 64 bytes, XOR 0x36 and XOR 0x5c. */
function halves(secretHex) {
  const padded = Buffer.concat([Buffer.from(secretHex, "hex"), Buffer.alloc(32)]);
  return { inner: Buffer.from(padded.map((b) => b ^ 0x36)), outer: Buffer.from(padded.map((b) => b ^ 0x5c)) };
}

function secretFromEnv() {
  const secret = process.env[SECRET_NAME];
  if (!secret) return null;
  if (!SECRET.test(secret)) fail(`${SECRET_NAME} must be 64 lower-case hexadecimal characters (32 bytes).`);
  return secret;
}

/** The private key of this working copy, with the public half as the database keeps it: the modulus as a whole number, and its length. */
function keyFromEnv() {
  const encoded = process.env[KEY_NAME];
  if (!encoded) return null;
  let key;
  try {
    key = createPrivateKey({ key: Buffer.from(encoded, "base64"), format: "der", type: "pkcs8" });
  } catch {
    fail(`${KEY_NAME} is not a private key. Make one with: npm run db:identity -- generate-key`);
  }
  const details = key.asymmetricKeyDetails;
  if (key.asymmetricKeyType !== "rsa" || ![2048, 3072, 4096].includes(details?.modulusLength) || details?.publicExponent !== 65537n) {
    fail(`${KEY_NAME} must be an RSA key of 2048, 3072 or 4096 bits with the exponent 65537. Make one with: npm run db:identity -- generate-key`);
  }
  const modulus = Buffer.from(createPublicKey(key).export({ format: "jwk" }).n, "base64url");
  return { key, bytes: modulus.length, modulus: BigInt(`0x${modulus.toString("hex")}`).toString(10) };
}

function database() {
  const url = process.env.MIGRATION_DATABASE_URL;
  if (!url) fail("MIGRATION_DATABASE_URL is not set; see .env.example");
  const { hostname, username, pathname } = new URL(url);
  const name = username.split(".")[1] ?? `${hostname}${pathname}`;
  return { sql: postgres(url, { max: 1, onnotice: () => {} }), name };
}

/** Appends NAME=value to a settings file that does not have it yet. The value is never shown. */
function writeSetting(file, name, make) {
  const before = existsSync(file) ? readFileSync(file, "utf8") : "";
  if (before.split("\n").some((line) => line.startsWith(`${name}=`) && line.length > name.length + 1)) {
    console.log(`${file} already has ${name}; left as it is.`);
    return;
  }
  appendFileSync(file, `${before === "" || before.endsWith("\n") ? "" : "\n"}${name}=${make()}\n`, { mode: 0o600 });
  console.log(`A new ${name} was written to ${file}. It was not shown and is not in Git.`);
}

const sameSecret = (row, mine) => Buffer.compare(row.inner_key, mine.inner) === 0 && Buffer.compare(row.outer_key, mine.outer) === 0;

if (action === "generate") {
  writeSetting(rest[0] ?? ".env.local", SECRET_NAME, () => randomBytes(32).toString("hex"));
} else if (action === "generate-key") {
  writeSetting(rest[0] ?? ".env.local", KEY_NAME, () =>
    generateKeyPairSync("rsa", { modulusLength: 2048, publicExponent: 65537 }).privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"),
  );
} else if (action === "status") {
  const { sql, name } = database();
  const secrets = await sql`select slot, inner_key, outer_key from app.identity_keys order by slot`;
  const keys = await sql`select slot, modulus::text as modulus, bytes from app.identity_public_keys order by slot`;
  await sql.end();
  const secret = secretFromEnv();
  const mine = keyFromEnv();
  console.log(`Database: ${name}`);
  console.log(keys.length === 0 ? "No public key installed." : `Public key installed (slot ${keys.map((k) => k.slot).join(" and ")}): nothing secret about it.`);
  console.log(secrets.length === 0 ? "No shared secret installed." : `Shared secret installed (slot ${secrets.map((k) => k.slot).join(" and ")}): whoever can read every table of this database can read it.`);
  if (keys.length === 0 && secrets.length === 0) console.log("With nothing installed, this database shows nothing to anyone. Run install.");
  if (mine) console.log(keys.some((k) => k.modulus === mine.modulus) ? `${KEY_NAME} here matches a public key in the database.` : `${KEY_NAME} here does NOT match any public key in the database.`);
  else console.log(`${KEY_NAME} is not set here.`);
  if (secret) console.log(secrets.some((k) => sameSecret(k, halves(secret))) ? `${SECRET_NAME} here matches a shared secret in the database.` : `${SECRET_NAME} here does NOT match any shared secret in the database.`);
  else console.log(`${SECRET_NAME} is not set here.`);
  const works = (mine && keys.some((k) => k.modulus === mine.modulus)) || (!mine && secret && secrets.some((k) => sameSecret(k, halves(secret))));
  console.log(works ? "An app started with these settings is believed by this database." : "An app started with these settings would be shown nothing by this database.");
} else if (action === "install") {
  const secret = secretFromEnv();
  const mine = keyFromEnv();
  if (!secret && !mine) fail(`Neither ${KEY_NAME} nor ${SECRET_NAME} is set. Run "npm run db:identity -- generate-key" first.`);
  const { sql, name } = database();
  const freeSlot = (rows) => [1, 2].find((n) => !rows.some((k) => k.slot === n));
  if (mine) {
    // The database must accept what Node signs with this key and refuse the same signature of
    // another text, or nothing the app signs would be accepted, or anything would.
    const probe = "sahulaterp-identity-v2|probe";
    const signature = createSign("RSA-SHA256").update(probe).sign(mine.key);
    const [{ good, bad }] = await sql`
      select app.identity_signature_valid(${mine.modulus}::numeric, ${mine.bytes}::int, convert_to(${probe}, 'UTF8'), ${signature}::bytea) as good,
             app.identity_signature_valid(${mine.modulus}::numeric, ${mine.bytes}::int, convert_to(${probe + "x"}, 'UTF8'), ${signature}::bytea) as bad`;
    if (!good || bad) {
      await sql.end();
      fail("The database does not check this key's signatures as this program makes them; nothing was installed.");
    }
    const keys = await sql`select slot, modulus::text as modulus from app.identity_public_keys order by slot`;
    if (keys.some((k) => k.modulus === mine.modulus)) {
      console.log(`Database ${name}: this public key is already installed.`);
    } else {
      const slot = freeSlot(keys);
      if (!slot) {
        await sql.end();
        fail(`Database ${name}: both slots hold other public keys. Remove the old one first ("npm run db:identity -- remove-key <slot> --yes").`);
      }
      await sql`insert into app.identity_public_keys (slot, modulus, bytes) values (${slot}, ${mine.modulus}::numeric, ${mine.bytes})`;
      console.log(`Database ${name}: public key installed in slot ${slot}.`);
    }
  }
  // The secret is not put in (or put back, after it was retired) unless asked, where a key is
  // in play: in a working copy that has a key, or in a database that holds a public key and no
  // secret. A working copy whose .env.local still has the old line must not undo the retirement.
  const keyOnly = secret && !rest.includes("--with-secret") && (await sql`select (select count(*) from app.identity_public_keys)::int as keys, (select count(*) from app.identity_keys)::int as secrets`).some((row) => row.keys > 0 && row.secrets === 0);
  if (secret && mine && !rest.includes("--with-secret")) {
    console.log(`Database ${name}: ${SECRET_NAME} is also set here and was left out: the key is what this working copy signs with. (install --with-secret puts the secret in as well.)`);
  } else if (keyOnly) {
    await sql.end();
    fail(`Database ${name} holds a public key and no shared secret: its secret was retired, and ${SECRET_NAME} was NOT put back. This working copy needs the key (${KEY_NAME}) to be believed there. (install --with-secret puts a secret in all the same.)`);
  } else if (secret) {
    const halved = halves(secret);
    // The halves must give what Node's own HMAC gives, or nothing the app signs would be accepted.
    const probe = "sahulaterp-identity-v1|probe";
    const [{ ok }] = await sql`select encode(sha256(${halved.outer}::bytea || sha256(${halved.inner}::bytea || convert_to(${probe}, 'UTF8'))), 'hex') = ${createHmac("sha256", Buffer.from(secret, "hex")).update(probe).digest("hex")} as ok`;
    if (!ok) {
      await sql.end();
      fail("The database does not compute the same signature as this program; the shared secret was not installed.");
    }
    const secrets = await sql`select slot, inner_key, outer_key from app.identity_keys order by slot`;
    if (secrets.some((k) => sameSecret(k, halved))) {
      console.log(`Database ${name}: this shared secret is already installed.`);
    } else {
      const slot = freeSlot(secrets);
      if (!slot) {
        await sql.end();
        fail(`Database ${name}: both slots hold other shared secrets. Remove the old one first ("npm run db:identity -- remove <slot> --yes").`);
      }
      await sql`insert into app.identity_keys (slot, inner_key, outer_key) values (${slot}, ${halved.inner}, ${halved.outer})`;
      console.log(`Database ${name}: shared secret installed in slot ${slot}.`);
    }
  }
  await sql.end();
} else if (action === "retire-secret") {
  if (!rest.includes("--yes")) fail("Usage: npm run db:identity -- retire-secret --yes   (removes every shared secret; the app must already be signing with its private key)");
  const mine = keyFromEnv() ?? fail(`${KEY_NAME} is not set here: with the shared secret gone and no key, nothing would be believed.`);
  const { sql, name } = database();
  const keys = await sql`select modulus::text as modulus from app.identity_public_keys`;
  if (!keys.some((k) => k.modulus === mine.modulus)) {
    await sql.end();
    fail(`Database ${name}: ${KEY_NAME} here does not match a public key in the database. Run install first; nothing was removed.`);
  }
  const gone = await sql`delete from app.identity_keys returning slot`;
  await sql.end();
  console.log(gone.length === 0 ? `Database ${name}: no shared secret was installed.` : `Database ${name}: the shared secret is removed (${gone.length} slot${gone.length === 1 ? "" : "s"}). From this moment only a proof signed with the private key is believed, in transactions already open as well. Take ${SECRET_NAME} out of the deployed app's settings and out of every .env.local.`);
} else if (action === "remove" || action === "remove-key") {
  const slot = Number(rest[0]);
  if (![1, 2].includes(slot) || !rest.includes("--yes")) fail(`Usage: npm run db:identity -- ${action} <1|2> --yes   (with nothing left installed, the database shows nothing to anyone)`);
  const { sql, name } = database();
  const gone = action === "remove" ? await sql`delete from app.identity_keys where slot = ${slot} returning slot` : await sql`delete from app.identity_public_keys where slot = ${slot} returning slot`;
  const [{ left }] = await sql`select (select count(*) from app.identity_keys)::int + (select count(*) from app.identity_public_keys)::int as left`;
  await sql.end();
  const what = action === "remove" ? "shared secret" : "public key";
  console.log(gone.length === 0 ? `Database ${name}: slot ${slot} held no ${what}.` : `Database ${name}: ${what} removed from slot ${slot}. Nothing is believed by it any more, in transactions already open as well.${left === 0 ? " Nothing is left installed: this database now shows nothing to anyone." : ""}`);
} else {
  fail("Usage: npm run db:identity -- status | generate-key [file] | generate [file] | install [--with-secret] | retire-secret --yes | remove <slot> --yes | remove-key <slot> --yes");
}

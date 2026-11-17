// npm run db:identity -- status
// npm run db:identity -- generate [file]     (default .env.local)
// npm run db:identity -- install
// npm run db:identity -- remove <slot> --yes
//
// The secret behind the proof of who is signed in (drizzle/0031_identity_proof.sql). The web app
// signs with IDENTITY_SIGNING_SECRET; the database checks with the same secret, kept in
// app.identity_keys where the app's role cannot read it. Until a key is installed in a database,
// that database takes the app's word, as it did before.
//
// The order on a deployed site: generate the secret, give it to the deployed app and redeploy,
// and only then install it in the database. The other way round, the deployed app has no proof
// to show and every page comes back empty.
//
// Nothing here ever prints the secret. The database is the one named by MIGRATION_DATABASE_URL.
import { createHmac, randomBytes } from "node:crypto";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import postgres from "postgres";

const NAME = "IDENTITY_SIGNING_SECRET";
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
  const secret = process.env[NAME];
  if (!secret) return null;
  if (!SECRET.test(secret)) fail(`${NAME} must be 64 lower-case hexadecimal characters (32 bytes).`);
  return secret;
}

function database() {
  const url = process.env.MIGRATION_DATABASE_URL;
  if (!url) fail("MIGRATION_DATABASE_URL is not set; see .env.example");
  const { hostname, username, pathname } = new URL(url);
  const name = username.split(".")[1] ?? `${hostname}${pathname}`;
  return { sql: postgres(url, { max: 1, onnotice: () => {} }), name };
}

if (action === "generate") {
  const file = rest[0] ?? ".env.local";
  const has = existsSync(file) && readFileSync(file, "utf8").split("\n").some((line) => line.startsWith(`${NAME}=`));
  if (has) {
    console.log(`${file} already has ${NAME}; left as it is.`);
  } else {
    const before = existsSync(file) ? readFileSync(file, "utf8") : "";
    appendFileSync(file, `${before === "" || before.endsWith("\n") ? "" : "\n"}${NAME}=${randomBytes(32).toString("hex")}\n`, { mode: 0o600 });
    console.log(`A new ${NAME} was written to ${file}. It was not shown and is not in Git.`);
  }
} else if (action === "status") {
  const { sql, name } = database();
  const keys = await sql`select slot, inner_key, outer_key, created_at from app.identity_keys order by slot`;
  const [{ flag }] = await sql`select last_value::int as flag from app.identity_proof_flag`;
  await sql.end();
  const secret = secretFromEnv();
  console.log(`Database: ${name}`);
  if ((flag > 1) !== (keys.length > 0)) console.log(`WARNING: the flag says a proof is ${flag > 1 ? "wanted" : "not wanted"}, but ${keys.length} key(s) are installed. Run install (or remove) again to put the two in step.`);
  console.log(keys.length === 0 ? "No key installed: this database takes the app's word for who is signed in." : `Key installed (slot ${keys.map((k) => k.slot).join(" and ")}): this database wants the proof.`);
  if (!secret) {
    console.log(`${NAME} is not set here${keys.length ? ": an app started with these settings would be shown nothing." : "."}`);
  } else {
    const mine = halves(secret);
    const match = keys.some((k) => Buffer.compare(k.inner_key, mine.inner) === 0 && Buffer.compare(k.outer_key, mine.outer) === 0);
    console.log(keys.length === 0 ? `${NAME} is set here, and not installed in the database.` : match ? `${NAME} here matches a key in the database.` : `${NAME} here does NOT match any key in the database.`);
  }
} else if (action === "install") {
  const secret = secretFromEnv() ?? fail(`${NAME} is not set. Run "npm run db:identity -- generate" first.`);
  const mine = halves(secret);
  // The halves must give what Node's own HMAC gives, or nothing the app signs would be accepted.
  const { sql, name } = database();
  const probe = "sahulaterp-identity-v1|probe";
  const [{ ok }] = await sql`select encode(sha256(${mine.outer}::bytea || sha256(${mine.inner}::bytea || convert_to(${probe}, 'UTF8'))), 'hex') = ${createHmac("sha256", Buffer.from(secret, "hex")).update(probe).digest("hex")} as ok`;
  if (!ok) {
    await sql.end();
    fail("The database does not compute the same signature as this program; nothing was installed.");
  }
  const keys = await sql`select slot, inner_key, outer_key from app.identity_keys order by slot`;
  if (keys.some((k) => Buffer.compare(k.inner_key, mine.inner) === 0 && Buffer.compare(k.outer_key, mine.outer) === 0)) {
    await sql`select setval('app.identity_proof_flag', 2)`;
    console.log(`Database ${name}: this key is already installed. Nothing changed.`);
  } else {
    const slot = [1, 2].find((n) => !keys.some((k) => k.slot === n));
    if (!slot) {
      await sql.end();
      fail(`Database ${name}: both slots hold other keys. Remove the old one first ("npm run db:identity -- remove <slot> --yes").`);
    }
    await sql`insert into app.identity_keys (slot, inner_key, outer_key) values (${slot}, ${mine.inner}, ${mine.outer})`;
    // The flag every transaction sees at once, also one that was open before the key went in.
    await sql`select setval('app.identity_proof_flag', 2)`;
    console.log(`Database ${name}: key installed in slot ${slot}. From now on this database wants the proof of who is signed in.`);
  }
  await sql.end();
} else if (action === "remove") {
  const slot = Number(rest[0]);
  if (![1, 2].includes(slot) || !rest.includes("--yes")) fail('Usage: npm run db:identity -- remove <1|2> --yes   (with no key left, the database takes the app\'s word again)');
  const { sql, name } = database();
  const gone = await sql`delete from app.identity_keys where slot = ${slot} returning slot`;
  const [{ left }] = await sql`select count(*)::int as left from app.identity_keys`;
  if (left === 0) await sql`select setval('app.identity_proof_flag', 1)`;
  await sql.end();
  console.log(gone.length === 0 ? `Database ${name}: slot ${slot} was empty.` : `Database ${name}: key removed from slot ${slot}. ${left === 0 ? "No key is left: this database takes the app's word again." : "One key is still installed."}`);
} else {
  fail("Usage: npm run db:identity -- status | generate [file] | install | remove <slot> --yes");
}

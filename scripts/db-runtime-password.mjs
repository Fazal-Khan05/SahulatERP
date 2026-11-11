// npm run db:runtime-password
//
// Gives the app_runtime database role a new random password and writes the matching DATABASE_URL
// into .env.local. Run it once after the first migration and again whenever the password must be
// rotated; afterwards update DATABASE_URL on Vercel from .env.local. The password is never printed.
import { createHash, createHmac, pbkdf2Sync, randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import postgres from "postgres";

const ENV_FILE = ".env.local";
const migrationUrl = process.env.MIGRATION_DATABASE_URL;
if (!migrationUrl) {
  console.error("MIGRATION_DATABASE_URL is not set. Fill it in .env.local (see .env.example).");
  process.exit(1);
}

// Postgres stores a SCRAM-SHA-256 verifier, not the password. Sending the verifier means the
// password itself never reaches the server or its statement log.
function scramVerifier(password) {
  const salt = randomBytes(16);
  const iterations = 4096;
  const salted = pbkdf2Sync(password, salt, iterations, 32, "sha256");
  const clientKey = createHmac("sha256", salted).update("Client Key").digest();
  const storedKey = createHash("sha256").update(clientKey).digest();
  const serverKey = createHmac("sha256", salted).update("Server Key").digest();
  return `SCRAM-SHA-256$${iterations}:${salt.toString("base64")}$${storedKey.toString("base64")}:${serverKey.toString("base64")}`;
}

// base64url: no character needs escaping in a URL or in SQL.
const password = randomBytes(32).toString("base64url");
const verifier = scramVerifier(password);

// Same host and database as the migration connection, as app_runtime. On Supabase the pooler
// user is "<role>.<project ref>" and the transaction pooler listens on 6543.
const runtimeUrl = new URL(migrationUrl);
if (/^db\.[a-z0-9]+\.supabase\.co$/.test(runtimeUrl.hostname)) {
  console.error(
    "MIGRATION_DATABASE_URL points at Supabase's direct database host, which Vercel cannot reach.\n" +
      "Use the session pooler URL (…pooler.supabase.com:5432) in .env.local and run this again.",
  );
  process.exit(1);
}
const [, ...projectRef] = decodeURIComponent(runtimeUrl.username).split(".");
runtimeUrl.username = ["app_runtime", ...projectRef].join(".");
runtimeUrl.password = password;
if (runtimeUrl.hostname.endsWith(".pooler.supabase.com")) runtimeUrl.port = "6543";

const admin = postgres(migrationUrl, { max: 1, onnotice: () => {} });
try {
  const [role] = await admin`select rolbypassrls or rolsuper as privileged from pg_roles where rolname = 'app_runtime'`;
  if (!role) throw new Error("The app_runtime role does not exist yet. Run `npm run db:migrate` first.");
  if (role.privileged) throw new Error("app_runtime can bypass row-level security. Refusing to continue.");
  // The verifier is base64 plus "$" and ":"; it cannot contain a quote.
  await admin.unsafe(`alter role app_runtime with password '${verifier}'`);
} finally {
  await admin.end();
}

// The pooler can take a little while to see a new password.
let connected = false;
for (let attempt = 1; attempt <= 12 && !connected; attempt += 1) {
  const runtime = postgres(runtimeUrl.href, { max: 1, prepare: false, connect_timeout: 10, onnotice: () => {} });
  try {
    const [who] = await runtime`select current_user as name`;
    connected = who.name === "app_runtime";
  } catch {
    await new Promise((resolve) => setTimeout(resolve, 5000));
  } finally {
    await runtime.end({ timeout: 2 });
  }
}

const line = `DATABASE_URL=${runtimeUrl.href}`;
const current = existsSync(ENV_FILE) ? readFileSync(ENV_FILE, "utf8") : "";
const next = /^DATABASE_URL=.*$/m.test(current)
  ? current.replace(/^DATABASE_URL=.*$/m, line)
  : `${current}${current.endsWith("\n") || current === "" ? "" : "\n"}${line}\n`;
writeFileSync(ENV_FILE, next, { mode: 0o600 });

console.log(`app_runtime has a new password (ends …${password.slice(-4)}). DATABASE_URL in ${ENV_FILE} now uses it.`);
if (!connected) {
  console.error("Could not connect as app_runtime yet. Wait a minute and run `npm run check`; if it still fails, run this again.");
  process.exit(1);
}
console.log("Connected as app_runtime through the new URL. Update DATABASE_URL on Vercel to match.");

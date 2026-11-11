// Shared by the operator scripts in scripts/. These run on the founder's machine (later, in the
// worker) with the two credentials the web app never holds: the Supabase service-role key and the
// postgres connection. Neither is ever printed.
import { createClient } from "@supabase/supabase-js";
import postgres from "postgres";

function need(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`${name} is not set. Fill it in .env.local (see .env.example).`);
    process.exit(1);
  }
  return value;
}

/** Supabase Auth admin client (service-role key). */
export function supabaseAdmin() {
  return createClient(need("NEXT_PUBLIC_SUPABASE_URL"), need("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/** Database connection as postgres, which bypasses row-level security. */
export function adminSql() {
  return postgres(need("MIGRATION_DATABASE_URL"), { max: 1, onnotice: () => {} });
}

/**
 * Where the link in the email opens. It is always stated on the command line: the invite link
 * works once, so one that opened this Mac's localhost on the customer's phone would be wasted.
 */
export function emailLinkBase(args) {
  const flag = args.find((arg) => arg.startsWith("--url="));
  const base = flag?.slice("--url=".length).replace(/\/+$/, "");
  if (!base || !/^https?:\/\/[^/\s]+$/.test(base)) {
    console.error(
      "Say where the link in the email should open, for example --url=https://sahulaterp.vercel.app\n" +
        "(or --url=http://localhost:3000 when you are testing on this machine).",
    );
    process.exit(1);
  }
  return base;
}

/** a…@example.com, for terminal output. */
export function maskEmail(email) {
  const [name, domain] = email.split("@");
  return `${name.slice(0, 1)}…@${domain}`;
}

export const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

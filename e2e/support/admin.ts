import { randomBytes } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { adminSql, deleteTenants } from "../../tests/support/admin-db";

// Test support only. Everything here works on synthetic accounts whose address ends in
// @sahulaterp.test (a reserved domain that can never receive mail) and on the companies those
// accounts created. No email is ever sent: accounts are created confirmed, and invite and reset
// links are generated instead of mailed.

const DOMAIN = "sahulaterp.test";

export const emailFor = (name: string) => `e2e-${name}@${DOMAIN}`;

export type TestUser = { id: string; email: string; password: string };

export function hasE2EEnv(): boolean {
  return Boolean(
    process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY && process.env.MIGRATION_DATABASE_URL,
  );
}

function supabaseAdmin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Supabase URL or service-role key is not set; see .env.example");
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

export function randomPassword(): string {
  return `${randomBytes(18).toString("base64url")}aA1`;
}

export async function createUser(name: string, options: { canCreateCompany: boolean }): Promise<TestUser> {
  const email = emailFor(name);
  const password = randomPassword();
  const { data, error } = await supabaseAdmin().auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    app_metadata: options.canCreateCompany ? { can_create_company: true } : {},
  });
  if (error || !data.user) throw new Error(`could not create ${email}: ${error?.message}`);
  return { id: data.user.id, email, password };
}

/**
 * The link an invite or reset email would carry, without sending the email: Supabase Auth's own
 * verify URL, which checks the one-time token and sends the browser on to /auth/confirm.
 */
export async function emailLink(
  type: "invite" | "recovery",
  email: string,
  appUrl: string,
): Promise<{ userId: string; url: string }> {
  const { data, error } = await supabaseAdmin().auth.admin.generateLink({
    type,
    email,
    options: { redirectTo: `${appUrl}/auth/confirm` },
  });
  if (error || !data.user) throw new Error(`could not generate a ${type} link: ${error?.message}`);
  return { userId: data.user.id, url: data.properties.action_link };
}

/** Removes every synthetic account and the companies they created. */
export async function removeE2EData(): Promise<void> {
  const sql = adminSql();
  try {
    const users = await sql<{ id: string }[]>`select id from auth.users where email like ${"e2e-%@" + DOMAIN}`;
    const userIds = users.map((u) => u.id);
    if (userIds.length === 0) return;
    const tenants = await sql<{ id: string }[]>`select id from public.tenants where created_by = any(${userIds})`;
    const tenantIds = tenants.map((t) => t.id);
    const supabase = supabaseAdmin();
    // The bytes of any files those companies stored, then the rows.
    const stored = await sql<{ storage_key: string }[]>`select storage_key from public.files where tenant_id = any(${tenantIds})`;
    if (stored.length > 0) {
      const { error } = await supabase.storage.from("files").remove(stored.map((f) => f.storage_key));
      if (error) throw new Error(`could not remove synthetic files: ${error.message}`);
    }
    await deleteTenants(sql, tenantIds);
    for (const id of userIds) {
      const { error } = await supabase.auth.admin.deleteUser(id);
      if (error) throw new Error(`could not delete a synthetic account: ${error.message}`);
    }
  } finally {
    await sql.end();
  }
}

/**
 * A Supabase client signed in as a test user, talking to Supabase directly rather than through
 * the app. Used to check that Supabase Storage itself refuses what the app would never ask for.
 */
export async function directClient(user: Pick<TestUser, "email" | "password">) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) throw new Error("Supabase URL or publishable key is not set; see .env.example");
  const client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const { error } = await client.auth.signInWithPassword({ email: user.email, password: user.password });
  if (error) throw new Error(`could not sign in directly as ${user.email}: ${error.message}`);
  return client;
}

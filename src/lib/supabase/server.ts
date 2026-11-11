import "server-only";
import { createServerClient } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";
import { connection } from "next/server";
import { sessionCookieOptions } from "./cookie-options";

/**
 * Supabase client for the signed-in user, used only for Supabase Auth (sign-in, session cookies,
 * password reset). Application tables are never read through it; they go through withTenant().
 * A new client per request: it carries that request's cookies.
 */
export async function createSupabaseServerClient() {
  const cookieStore = await cookies();
  // Checking a session compares its expiry with the clock, so everything after this is
  // request-time work and is never prerendered or prefetched.
  await connection();
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) throw new Error("Supabase URL or publishable key is not set; see .env.example");
  return createServerClient(url, key, {
    cookieOptions: sessionCookieOptions,
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll: (cookiesToSet) => {
        try {
          for (const { name, value, options } of cookiesToSet) cookieStore.set(name, value, options);
        } catch {
          // Server Components cannot write cookies. src/proxy.ts refreshes the session on every
          // request, so there is nothing to lose here.
        }
      },
    },
  });
}

/**
 * A client with no session, used only to ask Supabase Auth to send a password-reset email.
 * It asks for the plain link style, so the link works in any browser or device, the same way
 * invite links do; the session client above would tie the link to the browser that asked.
 */
export function createSupabaseEmailClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) throw new Error("Supabase URL or publishable key is not set; see .env.example");
  return createClient(url, key, {
    auth: { flowType: "implicit", persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

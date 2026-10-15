import 'server-only';
import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';

// The session lives only in cookies the server writes: page scripts cannot read them (HttpOnly), they never
// travel over plain HTTP in production (Secure), and cross-site posts do not carry them (SameSite=Lax).
// Sign-in, password reset and sign-out therefore run in the /auth/* route handlers, never in the browser.
const SESSION_COOKIE_OPTIONS = { path: '/', sameSite: 'lax', httpOnly: true, secure: process.env.NODE_ENV === 'production' } as const;

export async function createServerSupabase() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) throw new Error('Supabase server configuration is missing.');
  const cookieStore = await cookies();
  return createServerClient(url, key, {
    cookieOptions: SESSION_COOKIE_OPTIONS,
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll: values => {
        try { values.forEach(({ name, value, options }) => cookieStore.set(name, value, options)); }
        catch { /* Server Components cannot set cookies; Route Handlers persist auth changes. */ }
      },
    },
  });
}

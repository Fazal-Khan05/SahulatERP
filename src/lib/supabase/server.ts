import 'server-only';
import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';

import { SESSION_COOKIE_OPTIONS } from './cookie-options';

// Sign-in, password reset and sign-out run in the /auth/* route handlers, never in the browser (HttpOnly session).
// Server Components cannot write cookies; src/proxy.ts refreshes an expiring session before they render (D-77).

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

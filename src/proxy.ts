import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';
import { SESSION_COOKIE_OPTIONS } from './lib/supabase/cookie-options';

/**
 * Keeps the Supabase session fresh (D-77). Server Components cannot write cookies, so without this a page render
 * after the access token expires refreshes the session but drops the new tokens; the next request then reuses the
 * spent refresh token, Supabase revokes the session and the member is signed out after about an hour. Here the
 * refresh happens once, before rendering, and the new cookies go both to the request being rendered and to the
 * browser. Authorisation still happens downstream with getUser() (memberContext / requireMember).
 */
export async function proxy(request: NextRequest) {
  let response = NextResponse.next({ request });
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  // No session cookie means nothing to refresh (sign-in page, anonymous requests).
  if (!url || !key || !request.cookies.getAll().some(c => /^sb-.+-auth-token(\.\d+)?$/.test(c.name))) return response;
  const supabase = createServerClient(url, key, {
    cookieOptions: SESSION_COOKIE_OPTIONS,
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: values => {
        values.forEach(({ name, value }) => request.cookies.set(name, value));
        response = NextResponse.next({ request });
        values.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
      },
    },
  });
  // getSession() refreshes only when the access token is expired or about to be, and makes no network call otherwise.
  await supabase.auth.getSession();
  return response;
}

export const config = {
  // Everything except Next's static assets and images.
  matcher: ['/((?!_next/static|_next/image|favicon\\.ico|favicon\\.svg|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)'],
};

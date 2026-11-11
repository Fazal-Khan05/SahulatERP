import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { sessionCookieOptions } from "@/lib/supabase/cookie-options";

// Runs before every page request. It refreshes the Supabase session cookie when the access token
// has expired (Server Components cannot write cookies) and sends signed-out visitors to the
// sign-in page. This is a convenience, not the security boundary: every page, action and query
// checks the session and the membership again.

const SIGNED_OUT_ONLY = new Set(["/sign-in", "/forgot-password"]);
const OPEN_TO_ALL = new Set(["/auth/confirm"]);

export async function proxy(request: NextRequest) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) return NextResponse.next({ request });

  let response = NextResponse.next({ request });
  const supabase = createServerClient(url, key, {
    cookieOptions: sessionCookieOptions,
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (cookiesToSet, headers) => {
        for (const { name, value } of cookiesToSet) request.cookies.set(name, value);
        response = NextResponse.next({ request });
        for (const { name, value, options } of cookiesToSet) response.cookies.set(name, value, options);
        for (const [name, value] of Object.entries(headers)) response.headers.set(name, value);
      },
    },
  });

  // Verifies the token's signature and refreshes it if it has expired.
  const { data } = await supabase.auth.getClaims();
  const signedIn = Boolean(data?.claims?.sub);
  const path = request.nextUrl.pathname;

  let destination: string | null = null;
  if (!signedIn && !SIGNED_OUT_ONLY.has(path) && !OPEN_TO_ALL.has(path)) destination = "/sign-in";
  if (signedIn && SIGNED_OUT_ONLY.has(path)) destination = "/";
  if (!destination) return response;

  const redirect = NextResponse.redirect(new URL(destination, request.url));
  // Keep any refreshed session cookies on the redirect.
  for (const cookie of response.cookies.getAll()) redirect.cookies.set(cookie);
  return redirect;
}

export const config = {
  // Everything except Next.js internals and static files.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|css|js|map|txt)$).*)"],
};

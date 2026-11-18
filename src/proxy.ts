import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { readLastActive, signLastActive } from "@/lib/auth/activity-cookie";
import { idleTooLong, nowInSeconds, proofsOf, sessionTooOld } from "@/lib/auth/rules";
import { LAST_ACTIVE_COOKIE, sessionCookieOptions } from "@/lib/supabase/cookie-options";

// Runs before every page request. It refreshes the Supabase session cookie when the access token
// has expired (Server Components cannot write cookies) and sends signed-out visitors to the
// sign-in page. This is a convenience, not the security boundary: every page, action and query
// checks the session and the membership again.
//
// It also ends a session that has been left idle, or has run its full length (Step 47). The idle
// time is kept in a cookie the server signs for this session (src/lib/auth/activity-cookie.ts);
// one missing or forged counts as idle. The full length is read from the verified token.

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
  let signedIn = Boolean(data?.claims?.sub);
  const path = request.nextUrl.pathname;
  const now = nowInSeconds();

  const proofs = proofsOf(data?.claims?.amr);
  const sessionId = typeof data?.claims?.session_id === "string" ? data.claims.session_id : "";
  const lastActive = sessionId ? readLastActive(request.cookies.get(LAST_ACTIVE_COOKIE)?.value, sessionId, now) : null;

  let ended: "idle" | "limit" | null = null;
  if (signedIn) {
    if (sessionTooOld(proofs, now)) ended = "limit";
    else if (idleTooLong(lastActive, proofs, now)) ended = "idle";
  }
  if (ended) {
    // Ends this browser's session (other devices keep theirs) and clears its cookies.
    await supabase.auth.signOut({ scope: "local" });
    signedIn = false;
  }

  let destination: string | null = null;
  if (ended) destination = `/sign-in?ended=${ended}`;
  else if (!signedIn && !SIGNED_OUT_ONLY.has(path) && !OPEN_TO_ALL.has(path)) destination = "/sign-in";
  else if (signedIn && SIGNED_OUT_ONLY.has(path)) destination = "/";

  const reply = destination ? NextResponse.redirect(new URL(destination, request.url)) : response;
  if (destination) {
    // Keep any refreshed (or, when the session ended, cleared) session cookies on the redirect.
    for (const cookie of response.cookies.getAll()) reply.cookies.set(cookie);
  }
  // The time is written at most once a minute, and never on a server action's reply: a cookie
  // set there makes Next.js draw the page again inside the reply, which drops what the form was
  // told to do next (go to another page, say). A page is always loaded around the actions.
  const isAction = request.headers.has("next-action");
  if (signedIn && sessionId && !isAction && (lastActive === null || now - lastActive >= 60)) {
    // Kept as long as the session's own cookies, so closing the browser does not lose it.
    reply.cookies.set(LAST_ACTIVE_COOKIE, signLastActive(now, sessionId), { ...sessionCookieOptions, maxAge: 400 * 24 * 3600 });
  } else if (!signedIn && request.cookies.has(LAST_ACTIVE_COOKIE)) reply.cookies.delete(LAST_ACTIVE_COOKIE);
  return reply;
}

export const config = {
  // Everything except Next.js internals and static files.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|css|js|map|txt)$).*)"],
};

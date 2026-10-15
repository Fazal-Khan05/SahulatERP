import { NextResponse } from 'next/server';
import { createServerSupabase } from '@/lib/supabase/server';

/**
 * Resolves `next` against the app's own origin and keeps it only if it stays there. The URL parser
 * applies the browser's rules (backslashes read as slashes, tabs and newlines dropped), so variants
 * such as `/\evil.com`, `//evil.com` or `/\t/evil.com` resolve off-site and fall back to `/`.
 */
function sameOriginTarget(next: string | null, origin: string) {
  if (next) {
    try {
      const target = new URL(next, origin);
      if (target.origin === origin) return target;
    } catch { /* not a URL: fall through to the home page */ }
  }
  return new URL('/', origin);
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  // An expired or reused link simply leaves no session; the destination page (e.g. /account/reset) explains that.
  if (code) await (await createServerSupabase()).auth.exchangeCodeForSession(code).catch(() => undefined);
  return NextResponse.redirect(sameOriginTarget(url.searchParams.get('next'), url.origin));
}

import { NextResponse } from 'next/server';
import { createServerSupabase } from '@/lib/supabase/server';

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const next = url.searchParams.get('next');
  // An expired or reused link simply leaves no session; the destination page (e.g. /account/reset) explains that.
  if (code) await (await createServerSupabase()).auth.exchangeCodeForSession(code).catch(() => undefined);
  const safeNext = next?.startsWith('/') && !next.startsWith('//') ? next : '/';
  return NextResponse.redirect(new URL(safeNext, url.origin));
}

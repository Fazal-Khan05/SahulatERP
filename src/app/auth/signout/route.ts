import { NextResponse } from 'next/server';
import { createServerSupabase } from '@/lib/supabase/server';

export async function POST(request: Request) {
  await (await createServerSupabase()).auth.signOut();
  return NextResponse.redirect(new URL('/', request.url), { status: 303 });
}

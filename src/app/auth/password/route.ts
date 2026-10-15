import { readJson, reply, unavailable } from '@/lib/supabase/request';
import { createServerSupabase } from '@/lib/supabase/server';

const EXPIRED = 'This reset link has expired or was already used. Request a new one from the sign-in page.';

// Whether this browser holds the session that /auth/callback created from an emailed reset link.
export async function GET() {
  const { data } = await (await createServerSupabase()).auth.getUser();
  return Response.json({ ready: Boolean(data.user) }, { headers: { 'cache-control': 'no-store' } });
}

// Sets the new password for the signed-in (recovery) session.
export async function POST(request: Request) {
  const { password = '' } = await readJson(request);
  if (password.length < 8) return reply(400, 'Use at least 8 characters.');
  const supabase = await createServerSupabase();
  const { data } = await supabase.auth.getUser();
  if (!data.user) return reply(401, EXPIRED);
  const { error } = await supabase.auth.updateUser({ password });
  if (!error) return reply(200);
  if (unavailable(error)) return reply(503, 'Could not change the password right now. Try again in a moment.');
  if (error.status === 401 || error.status === 403) return reply(401, EXPIRED);
  // The account holder is signed in here, so Supabase's own reason (too weak, same as before) is safe to show.
  return reply(400, error.message);
}

import { readJson, reply, unavailable } from '@/lib/supabase/request';
import { createServerSupabase } from '@/lib/supabase/server';

// Starts a password reset. The PKCE verifier is stored as an HttpOnly cookie in this browser, so only this
// browser can complete the emailed link at /auth/callback.
export async function POST(request: Request) {
  const { email = '' } = await readJson(request);
  if (!email.trim()) return reply(400, 'Enter your email address first.');
  const redirectTo = new URL('/auth/callback?next=/account/reset', request.url).toString();
  const { error } = await (await createServerSupabase()).auth.resetPasswordForEmail(email.trim(), { redirectTo });
  if (error && unavailable(error)) return reply(503, 'Could not send reset instructions right now. Try again in a moment.');
  // Unknown addresses and per-address limits get the same answer as success, so it never reveals which accounts exist.
  return reply(200);
}

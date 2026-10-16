import { readJson, reply, unavailable } from '@/lib/supabase/request';
import { createServerSupabase } from '@/lib/supabase/server';

// Signs in on the server, which stores the session as HttpOnly cookies; the browser never holds the tokens.
export async function POST(request: Request) {
  const { email = '', password = '' } = await readJson(request);
  if (!email.trim() || !password) return reply(400, 'Enter your email address and password.');
  const { error } = await (await createServerSupabase()).auth.signInWithPassword({ email: email.trim(), password });
  if (!error) return reply(200);
  if (error.status === 429) return reply(429, 'Too many sign-in attempts. Wait a few minutes and try again.');
  if (unavailable(error)) return reply(503, 'Sign-in is unavailable right now. Try again in a moment.');
  // One message for a wrong password and an unknown address, so the answer never reveals which accounts exist.
  return reply(401, 'Invalid login credentials');
}

import 'server-only';
import { createClient } from '@supabase/supabase-js';

// In-memory throttle: 5 failed attempts per user per 15 minutes. Good enough for a single
// server; move to a table when there is more than one instance.
const attempts = new Map<string, { count: number; resetAt: number }>();
const LIMIT = 5;
const WINDOW_MS = 15 * 60 * 1000;

/**
 * Re-verifies the signed-in user's own password before a sensitive change (e.g. hiding a module).
 * Uses a throw-away client so the caller's cookie session is untouched; the returned session is discarded.
 * The password is never logged or stored.
 */
export async function verifyPassword(userId: string, email: string, password: string): Promise<{ ok: true } | { ok: false; message: string }> {
  const now = Date.now();
  const state = attempts.get(userId);
  if (state && state.resetAt > now && state.count >= LIMIT) return { ok: false, message: 'Too many attempts. Try again in a few minutes.' };
  if (state && state.resetAt <= now) attempts.delete(userId);
  if (!password) return { ok: false, message: 'Enter your password to confirm.' };
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) throw new Error('Supabase configuration is missing.');
  const client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error || data.user?.id !== userId) {
    const current = attempts.get(userId) ?? { count: 0, resetAt: now + WINDOW_MS };
    attempts.set(userId, { count: current.count + 1, resetAt: current.resetAt });
    return { ok: false, message: 'Password incorrect.' };
  }
  attempts.delete(userId);
  await client.auth.signOut({ scope: 'local' }).catch(() => undefined);
  return { ok: true };
}

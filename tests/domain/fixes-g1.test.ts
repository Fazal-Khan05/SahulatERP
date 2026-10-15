/**
 * Regression tests for the G1 (auth) fixes. The /auth/* route handlers run unchanged against a faked Supabase
 * server client; the cookie test runs the real server client with only next/headers and Supabase's HTTP faked.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

type AuthError = { message: string; status?: number; code?: string };
const S = vi.hoisted(() => ({
  user: null as null | { id: string },
  calls: [] as [string, ...unknown[]][],
  error: null as null | { message: string; status?: number; code?: string },
}));
const jar = vi.hoisted(() => new Map<string, { value: string; options: Record<string, unknown> }>());

vi.mock('server-only', () => ({}));
vi.mock('next/headers', () => ({ cookies: async () => ({ getAll: () => [...jar].map(([name, c]) => ({ name, value: c.value })), set: (name: string, value: string, options: Record<string, unknown>) => jar.set(name, { value, options }) }) }));
vi.mock('@/lib/supabase/request', () => import('../../src/lib/supabase/request'));
vi.mock('@/lib/supabase/server', () => ({
  createServerSupabase: async () => ({
    auth: {
      getUser: async () => ({ data: { user: S.user }, error: null }),
      signInWithPassword: async (credentials: unknown) => { S.calls.push(['signIn', credentials]); return { data: {}, error: S.error }; },
      resetPasswordForEmail: async (email: string, options: unknown) => { S.calls.push(['reset', email, options]); return { data: {}, error: S.error }; },
      updateUser: async (attributes: unknown) => { S.calls.push(['update', attributes]); return { data: {}, error: S.error }; },
    },
  }),
}));

import * as signin from '../../src/app/auth/signin/route';
import * as forgot from '../../src/app/auth/forgot/route';
import * as password from '../../src/app/auth/password/route';

const post = (path: string, body: unknown, type = 'application/json') =>
  new Request(`https://erp.example${path}`, { method: 'POST', headers: { 'content-type': type }, body: typeof body === 'string' ? body : JSON.stringify(body) });
const answer = async (response: Response) => ({ status: response.status, body: await response.json() as { ok?: boolean; message?: string; ready?: boolean } });
const fail = (error: AuthError) => { S.error = error; };

beforeEach(() => { S.user = null; S.calls = []; S.error = null; jar.clear(); });

describe('D-31 sign-in, reset and password change run on the server', () => {
  it('D-31 sign-in passes the trimmed email and the exact password to Supabase and answers ok', async () => {
    expect(await answer(await signin.POST(post('/auth/signin', { email: '  owner@qa.example ', password: ' pass word ' })))).toEqual({ status: 200, body: { ok: true } });
    expect(S.calls).toEqual([['signIn', { email: 'owner@qa.example', password: ' pass word ' }]]);
  });

  it('D-31 a wrong password, an unknown address and an unconfirmed address get the same answer', async () => {
    const answers = [];
    for (const error of [{ message: 'Invalid login credentials', status: 400, code: 'invalid_credentials' }, { message: 'Email not confirmed', status: 400, code: 'email_not_confirmed' }]) {
      fail(error);
      answers.push(await answer(await signin.POST(post('/auth/signin', { email: 'someone@qa.example', password: 'wrong-password' }))));
    }
    expect(answers).toEqual([{ status: 401, body: { message: 'Invalid login credentials' } }, { status: 401, body: { message: 'Invalid login credentials' } }]);
  });

  it('D-31 rate limits and outages get plain messages, never Supabase internals', async () => {
    fail({ message: 'Request rate limit reached', status: 429, code: 'over_request_rate_limit' });
    expect(await answer(await signin.POST(post('/auth/signin', { email: 'a@qa.example', password: 'x' })))).toEqual({ status: 429, body: { message: 'Too many sign-in attempts. Wait a few minutes and try again.' } });
    fail({ message: 'fetch failed', status: 0 });
    expect(await answer(await signin.POST(post('/auth/signin', { email: 'a@qa.example', password: 'x' })))).toEqual({ status: 503, body: { message: 'Sign-in is unavailable right now. Try again in a moment.' } });
  });

  it('D-31 a cross-site form post (not application/json) or a body without credentials never reaches Supabase', async () => {
    const form = post('/auth/signin', '{"email":"attacker@qa.example","password":"attacker-pass"}', 'text/plain');
    expect((await signin.POST(form)).status).toBe(400);
    expect((await signin.POST(post('/auth/signin', { email: 'a@qa.example', password: 12345678 }))).status).toBe(400);
    expect((await signin.POST(post('/auth/signin', 'not json'))).status).toBe(400);
    expect((await forgot.POST(post('/auth/forgot', 'email=a@qa.example', 'application/x-www-form-urlencoded'))).status).toBe(400);
    expect((await password.POST(post('/auth/password', '{"password":"attacker-pass"}', 'text/plain'))).status).toBe(400);
    expect(S.calls).toEqual([]);
  });

  it('D-31 forgot password emails a link back to this app\'s callback and answers the same for unknown or limited addresses', async () => {
    expect(await answer(await forgot.POST(post('/auth/forgot', { email: ' owner@qa.example ' })))).toEqual({ status: 200, body: { ok: true } });
    expect(S.calls).toEqual([['reset', 'owner@qa.example', { redirectTo: 'https://erp.example/auth/callback?next=/account/reset' }]]);
    fail({ message: 'For security purposes, you can only request this after 60 seconds.', status: 429, code: 'over_email_send_rate_limit' });
    expect(await answer(await forgot.POST(post('/auth/forgot', { email: 'owner@qa.example' })))).toEqual({ status: 200, body: { ok: true } });
    fail({ message: 'Internal Server Error', status: 500 });
    expect(await answer(await forgot.POST(post('/auth/forgot', { email: 'owner@qa.example' })))).toEqual({ status: 503, body: { message: 'Could not send reset instructions right now. Try again in a moment.' } });
  });

  it('D-31 the reset page learns from the server whether a recovery session exists', async () => {
    expect(await answer(await password.GET())).toEqual({ status: 200, body: { ready: false } });
    S.user = { id: 'u-1' };
    expect(await answer(await password.GET())).toEqual({ status: 200, body: { ready: true } });
  });

  it('D-31 a new password needs a session and 8 characters; Supabase refusals are shown in plain words', async () => {
    expect(await answer(await password.POST(post('/auth/password', { password: 'long-enough' })))).toEqual({ status: 401, body: { message: 'This reset link has expired or was already used. Request a new one from the sign-in page.' } });
    S.user = { id: 'u-1' };
    expect((await password.POST(post('/auth/password', { password: 'Abc1234' }))).status).toBe(400);
    expect(S.calls).toEqual([]);
    expect(await answer(await password.POST(post('/auth/password', { password: 'long-enough' })))).toEqual({ status: 200, body: { ok: true } });
    expect(S.calls).toEqual([['update', { password: 'long-enough' }]]);
    fail({ message: 'New password should be different from the old password.', status: 422, code: 'same_password' });
    expect(await answer(await password.POST(post('/auth/password', { password: 'long-enough' })))).toEqual({ status: 400, body: { message: 'New password should be different from the old password.' } });
  });

  it('D-31 an emailed reset link still completes: the verifier saved by the forgot step is an HttpOnly cookie the callback exchange sends back', async () => {
    vi.resetModules();
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://qa.supabase.co');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY', 'sb_publishable_qa');
    const sent: { url: string; body: Record<string, string> }[] = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      sent.push({ url, body: init?.body ? JSON.parse(String(init.body)) : {} });
      if (url.includes('/recover')) return Response.json({});
      return Response.json({ access_token: 'header.payload.signature', token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: 'refresh-qa', user: { id: 'u-1', aud: 'authenticated', email: 'owner@qa.example', app_metadata: {}, user_metadata: {}, created_at: new Date().toISOString() } });
    });
    try {
      const { createServerSupabase } = await vi.importActual<typeof import('../../src/lib/supabase/server')>('../../src/lib/supabase/server');
      expect((await (await createServerSupabase()).auth.resetPasswordForEmail('owner@qa.example', { redirectTo: 'https://erp.example/auth/callback?next=/account/reset' })).error).toBeNull();
      const verifiers = [...jar].filter(([name]) => name.includes('code-verifier'));
      expect(verifiers.length).toBeGreaterThan(0);
      for (const [name, { options }] of verifiers) expect(options, name).toMatchObject({ httpOnly: true, sameSite: 'lax' });
      // Next request from the same browser: the callback exchanges the code with the verifier read back from the cookie.
      expect((await (await createServerSupabase()).auth.exchangeCodeForSession('code-from-email')).error).toBeNull();
    } finally { vi.unstubAllGlobals(); vi.unstubAllEnvs(); }
    const challenge = sent.find(r => r.url.includes('/recover'))!.body.code_challenge;
    const exchange = sent.find(r => r.url.includes('grant_type=pkce'))!.body;
    expect(exchange.auth_code).toBe('code-from-email');
    const { createHash } = await import('node:crypto');
    expect(createHash('sha256').update(exchange.code_verifier).digest('base64url')).toBe(challenge);
    expect(jar.get('sb-qa-auth-token')?.options).toMatchObject({ httpOnly: true, sameSite: 'lax' });
  });

  it('D-31 in production the session cookies are HttpOnly, Secure and SameSite=Lax', async () => {
    vi.resetModules();
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://qa.supabase.co');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY', 'sb_publishable_qa');
    vi.stubGlobal('fetch', async () => Response.json({ access_token: 'header.payload.signature', token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: 'refresh-qa', user: { id: 'u-1', aud: 'authenticated', email: 'owner@qa.example', app_metadata: {}, user_metadata: {}, created_at: new Date().toISOString() } }));
    try {
      const { createServerSupabase } = await vi.importActual<typeof import('../../src/lib/supabase/server')>('../../src/lib/supabase/server');
      expect((await (await createServerSupabase()).auth.signInWithPassword({ email: 'owner@qa.example', password: 'secret-123' })).error).toBeNull();
    } finally { vi.unstubAllGlobals(); vi.unstubAllEnvs(); }
    expect(jar.size).toBeGreaterThan(0);
    for (const [name, { options }] of jar) expect(options, name).toMatchObject({ httpOnly: true, secure: true, sameSite: 'lax', path: '/' });
  });
});

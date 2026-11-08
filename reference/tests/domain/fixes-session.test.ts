import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { unstable_doesMiddlewareMatch } from 'next/experimental/testing/server';

// D-77: an expiring session must be refreshed before Server Components render, and the new cookies saved.
const calls = { created: 0, options: undefined as unknown, refresh: true };
vi.mock('@supabase/ssr', () => ({
  createServerClient: (_url: string, _key: string, init: { cookieOptions: unknown; cookies: { getAll: () => { name: string; value: string }[]; setAll: (v: { name: string; value: string; options: Record<string, unknown> }[]) => void } }) => {
    calls.created++;
    calls.options = init.cookieOptions;
    return { auth: { getSession: async () => {
      if (calls.refresh) init.cookies.setAll([{ name: 'sb-ref-auth-token', value: 'base64-refreshed', options: { path: '/', httpOnly: true, sameSite: 'lax', maxAge: 400 } }]);
      return { data: { session: null }, error: null };
    } } };
  },
}));

const { proxy, config } = await import('../../src/proxy');

describe('D-77 session-refresh proxy', () => {
  beforeEach(() => { calls.created = 0; calls.options = undefined; calls.refresh = true; process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://x.supabase.co'; process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = 'pk'; });

  it('D-77 a refreshed session is written to the browser and to the request being rendered', async () => {
    const request = new NextRequest('http://localhost/?tenant=t', { headers: { cookie: 'sb-ref-auth-token=base64-old; other=1' } });
    const response = await proxy(request);
    expect(calls.created).toBe(1);
    const set = response.cookies.get('sb-ref-auth-token');
    expect(set?.value).toBe('base64-refreshed');
    expect(set?.httpOnly).toBe(true);
    expect(request.cookies.get('sb-ref-auth-token')?.value).toBe('base64-refreshed');
    // The rendering request sees the refreshed cookie (Next forwards it with the x-middleware-override headers).
    expect(response.headers.get('x-middleware-override-headers') ?? '').toContain('cookie');
  });

  it('D-77 no session cookie: nothing to refresh and no Supabase client', async () => {
    const response = await proxy(new NextRequest('http://localhost/', { headers: { cookie: 'other=1' } }));
    expect(calls.created).toBe(0);
    expect(response.cookies.getAll()).toHaveLength(0);
  });

  it('D-77 an unexpired session passes through untouched', async () => {
    calls.refresh = false;
    const response = await proxy(new NextRequest('http://localhost/', { headers: { cookie: 'sb-ref-auth-token.0=base64-a; sb-ref-auth-token.1=b' } }));
    expect(calls.created).toBe(1);
    expect(response.cookies.getAll()).toHaveLength(0);
  });

  it('D-77 cookies use the same HttpOnly/SameSite options as the server client', async () => {
    await proxy(new NextRequest('http://localhost/', { headers: { cookie: 'sb-ref-auth-token=base64-old' } }));
    expect(calls.options).toMatchObject({ path: '/', sameSite: 'lax', httpOnly: true });
  });

  it('D-77 the proxy runs on pages, API and auth routes but not on static assets', () => {
    for (const url of ['/', '/?tenant=t', '/api/workspace', '/auth/signout', '/print/sales_invoice/x', '/account/reset']) expect(unstable_doesMiddlewareMatch({ config, url }), url).toBe(true);
    for (const url of ['/_next/static/chunks/a.js', '/_next/image?url=x', '/favicon.svg', '/logo.png']) expect(unstable_doesMiddlewareMatch({ config, url }), url).toBe(false);
  });
});

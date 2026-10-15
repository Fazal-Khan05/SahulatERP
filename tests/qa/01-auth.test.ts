/**
 * SQA pack 01 — Sign-in, password reset, sessions (AUTH).
 * Executed here: route handlers (/api/workspace, /auth/callback, /auth/signout, /api/branding), the page entry
 * (tenant selection), the print page signed-out branch, server-rendered markup of the login/reset screens and the
 * workbench, and static source checks. The Supabase clients are replaced by an in-memory fake; the real
 * workspace-store, password and engine code run unchanged.
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { buildDemoWorkspace, freshCompany } from './helpers';
import { DEMO_TENANT, type Workspace } from '../../src/modules/erp/types';

type Row = Record<string, unknown>;
const S = vi.hoisted(() => {
  const state = {
    user: null as null | { id: string; email?: string; user_metadata: Record<string, unknown> },
    memberships: [] as Row[], tenants: [] as Row[], snapshots: new Map<string, { data: unknown; revision: number }>(),
    adminCalls: 0, exchanged: [] as string[], signOuts: 0,
    table(rows: () => Row[]) {
      const filters: ((r: Row) => boolean)[] = []; let single = false;
      const q: Record<string, unknown> = {
        select: () => q, order: () => q,
        eq: (c: string, v: unknown) => { filters.push(r => r[c] === v); return q; },
        in: (c: string, vs: unknown[]) => { filters.push(r => vs.includes(r[c])); return q; },
        single: () => { single = true; return q; },
        then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => {
          const data = rows().filter(r => filters.every(f => f(r)));
          return Promise.resolve(single ? (data[0] ? { data: data[0], error: null } : { data: null, error: { message: 'JSON object requested, multiple (or no) rows returned' } }) : { data, error: null }).then(res, rej);
        },
      };
      return q;
    },
    server() {
      return {
        auth: {
          getUser: async () => ({ data: { user: state.user } }),
          exchangeCodeForSession: async (code: string) => { state.exchanged.push(code); if (code !== 'good-code') throw new Error('invalid flow state'); return { data: {}, error: null }; },
          signOut: async () => { state.signOuts++; return { error: null }; },
        },
        from: (t: string) => state.table(() => (t === 'memberships' ? state.memberships : t === 'tenants' ? state.tenants : [])),
      };
    },
    admin() {
      state.adminCalls++;
      return {
        from: (t: string) => state.table(() => (t === 'workspace_snapshots' ? [...state.snapshots].map(([tenant_id, v]) => ({ tenant_id, data: v.data, revision: v.revision })) : [])),
        rpc: async (_: string, a: { p_tenant: string; p_expected: number; p_data: unknown }) => {
          const cur = state.snapshots.get(a.p_tenant);
          if (!cur || cur.revision !== a.p_expected) return { data: null, error: null };
          state.snapshots.set(a.p_tenant, { data: JSON.parse(JSON.stringify(a.p_data)), revision: a.p_expected + 1 });
          return { data: a.p_expected + 1, error: null };
        },
        storage: { from: () => ({ createSignedUrl: async (p: string, s: number) => ({ data: { signedUrl: `https://storage.example/${p}?e=${s}` } }), upload: async () => ({ error: null }), remove: async () => ({}) }) },
      };
    },
  };
  return state;
});

// Cookie jar behind next/headers, used only by the real server client in AUTH-065.
const jar = vi.hoisted(() => new Map<string, { value: string; options: Record<string, unknown> }>());
vi.mock('next/headers', () => ({ cookies: async () => ({ getAll: () => [...jar].map(([name, c]) => ({ name, value: c.value })), set: (name: string, value: string, options: Record<string, unknown>) => jar.set(name, { value, options }) }) }));
vi.mock('server-only', () => ({}));
vi.mock('@/lib/supabase/server', () => ({ createServerSupabase: async () => S.server() }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminSupabase: () => S.admin() }));
vi.mock('@/lib/supabase/client', () => ({ createBrowserSupabase: () => ({ auth: {} }) }));
vi.mock('@/lib/workspace-store', () => import('../../src/lib/workspace-store'));
vi.mock('@/lib/password', () => import('../../src/lib/password'));
vi.mock('@/lib/branding-store', () => import('../../src/lib/branding-store'));
vi.mock('@/lib/utils', () => import('../../src/lib/utils'));
vi.mock('@/modules/erp/access', () => import('../../src/modules/erp/access'));
vi.mock('@/modules/erp/codec', () => import('../../src/modules/erp/codec'));
vi.mock('@/modules/erp/dates', () => import('../../src/modules/erp/dates'));
vi.mock('@/modules/erp/demo', () => import('../../src/modules/erp/demo'));
vi.mock('@/modules/erp/documents', () => import('../../src/modules/erp/documents'));
vi.mock('@/modules/erp/engine', () => import('../../src/modules/erp/engine'));
vi.mock('@/modules/erp/master-data', () => import('../../src/modules/erp/master-data'));
vi.mock('@/modules/erp/modules', () => import('../../src/modules/erp/modules'));
vi.mock('@/modules/erp/money', () => import('../../src/modules/erp/money'));
vi.mock('@/modules/erp/reports', () => import('../../src/modules/erp/reports'));
vi.mock('@/modules/erp/types', () => import('../../src/modules/erp/types'));
vi.mock('@/components/document-preview', () => import('../../src/components/document-preview'));
vi.mock('@/components/print-actions', () => import('../../src/components/print-actions'));
vi.mock('@/components/login-screen', () => import('../../src/components/login-screen'));
vi.mock('@/components/workbench', () => import('../../src/components/workbench'));

import * as workspaceRoute from '../../src/app/api/workspace/route';
import * as callbackRoute from '../../src/app/auth/callback/route';
import * as signoutRoute from '../../src/app/auth/signout/route';
import * as brandingRoute from '../../src/app/api/branding/[kind]/route';
import EntryPage from '../../src/app/[[...path]]/page';
import PrintPage from '../../src/app/print/[kind]/[id]/page';
import { LoginScreen } from '../../src/components/login-screen';
import { ResetPassword } from '../../src/components/reset-password';
import { Workbench } from '../../src/components/workbench';

const root = resolve(__dirname, '../..');
const src = (p: string) => readFileSync(resolve(root, p), 'utf8');
const text = (html: string) => html.replace(/<svg[\s\S]*?<\/svg>/g, '').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&#x27;/g, "'").replace(/\s+/g, ' ').trim();
const OWN = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OWN2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const OTHER = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const USER = { id: 'u-1', email: 'member@qa.example', user_metadata: { display_name: 'QA Member' } };
const company = (tenantId: string, name = 'Own Co'): Workspace => ({ ...freshCompany(undefined, { name }), tenantId });
const member = (tenant: string, role = 'Owner', extra: Row = {}) => ({ tenant_id: tenant, user_id: USER.id, role, branch_ids: [], employee_id: null, active: true, ...extra });
function seed(memberships: Row[], tenants: [string, string, boolean][], snapshots: Workspace[]) {
  S.user = USER; S.memberships = memberships; S.tenants = tenants.map(([id, name, is_demo]) => ({ id, name, is_demo }));
  S.snapshots = new Map(snapshots.map(w => [w.tenantId, { data: JSON.parse(JSON.stringify(w)), revision: w.revision }]));
}
const entry = async (tenant?: string) => EntryPage({ searchParams: Promise.resolve(tenant === undefined ? {} : { tenant }) }) as Promise<ReactElement<Record<string, unknown>>>;
const loginHtml = () => renderToStaticMarkup(createElement(LoginScreen));
const post = (body: unknown, tenant = OWN) => new Request(`http://localhost/api/workspace`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-tenant-id': tenant }, body: JSON.stringify(body) });
const callback = (query: string) => callbackRoute.GET(new Request(`http://localhost/auth/callback${query}`));

beforeEach(() => { S.user = null; S.memberships = []; S.tenants = []; S.snapshots = new Map(); S.adminCalls = 0; S.exchanged = []; S.signOuts = 0; });

describe('01 auth', () => {
  it('AUTH-001 signed-out / renders the login screen [documented: email field is pre-filled with owner@sahulaterp.com]', async () => {
    const el = await entry();
    expect(el.type).toBe(LoginScreen);
    const html = loginHtml();
    const t = text(html);
    for (const copy of ['Welcome back', 'Email address', 'Password', 'Sign in securely', 'Forgot your password?']) expect(t).toContain(copy);
    expect(html).toMatch(/<input[^>]*type="email"/);
    expect(html).toMatch(/<input[^>]*type="password"/);
    expect(html).toContain('value="owner@sahulaterp.com"');
  });
  it('AUTH-005 empty email is blocked by HTML validation (email input is required, type=email)', () => {
    expect(loginHtml()).toMatch(/<input[^>]*type="email"[^>]*required=""/);
  });
  it('AUTH-006 empty password is blocked client-side (required) [documented: also minLength=8]', () => {
    expect(loginHtml()).toMatch(/<input[^>]*type="password"[^>]*required=""[^>]*minLength="8"/);
  });
  it('AUTH-015 tab order follows DOM order email → password → eye → sign in → forgot; no positive tabindex', () => {
    const html = loginHtml();
    const order = [html.indexOf('type="email"'), html.indexOf('type="password"'), html.indexOf('aria-label="Show password"'), html.indexOf('Sign in securely'), html.indexOf('Forgot your password?')];
    expect(order.every(i => i > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(html).not.toMatch(/tabindex="[1-9]/i);
  });
  it('AUTH-020 GET /api/workspace without a session returns 401 and never reads the snapshot', async () => {
    seed([], [], [company(OWN)]); S.user = null; S.adminCalls = 0;
    const res = await workspaceRoute.GET(new Request(`http://localhost/api/workspace?tenant=${OWN}`));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ success: false, message: 'AUTH_REQUIRED' });
    expect(S.adminCalls).toBe(0);
  });
  it('AUTH-021 POST with a stale/absent session returns 401 and nothing changes', async () => {
    const w = company(OWN); seed([member(OWN)], [[OWN, 'Own Co', false]], [w]); S.user = null; S.adminCalls = 0;
    const before = JSON.stringify(S.snapshots.get(OWN));
    const res = await workspaceRoute.POST(post({ type: 'save_company', payload: { name: 'Hacked', address: 'x' }, idempotencyKey: 'auth-021-key' }));
    expect(res.status).toBe(401);
    expect(JSON.stringify(S.snapshots.get(OWN))).toBe(before);
    expect(S.adminCalls).toBe(0);
  });
  it('AUTH-022 ?tenant=<own tenant> lands on that tenant [documented: login keeps pathname+search via window.location.assign]', async () => {
    seed([member(OWN), member(OWN2)], [[OWN, 'Own Co', false], [OWN2, 'Second Co', false]], [company(OWN), company(OWN2, 'Second Co')]);
    const el = await entry(OWN2);
    expect(el.type).toBe(Workbench);
    expect((el.props.initialWorkspace as Workspace).tenantId).toBe(OWN2);
    expect(src('src/components/login-screen.tsx')).toContain('window.location.assign(`${window.location.pathname}${window.location.search}`)');
  });
  it('AUTH-023 ?tenant=<not a member> falls back to own company; no data from the other tenant', async () => {
    seed([member(OWN)], [[OWN, 'Own Co', false], [OTHER, 'Other Co', false]], [company(OWN), company(OTHER, 'Other Co')]);
    const el = await entry(OTHER);
    expect((el.props.initialWorkspace as Workspace).tenantId).toBe(OWN);
    expect(JSON.stringify(el.props)).not.toContain('Other Co');
  });
  it('AUTH-024 ?tenant=not-a-uuid is ignored; own company shown', async () => {
    seed([member(OWN)], [[OWN, 'Own Co', false]], [company(OWN)]);
    expect(((await entry('not-a-uuid')).props.initialWorkspace as Workspace).tenantId).toBe(OWN);
  });
  it('AUTH-025 ?tenant= (empty) is ignored', async () => {
    seed([member(OWN)], [[OWN, 'Own Co', false]], [company(OWN)]);
    expect(((await entry('')).props.initialWorkspace as Workspace).tenantId).toBe(OWN);
  });
  it('AUTH-026 member of demo and own company, no ?tenant → own (non-demo) company', async () => {
    seed([member(DEMO_TENANT), member(OWN)], [[DEMO_TENANT, 'Demo', true], [OWN, 'Own Co', false]], [buildDemoWorkspace(), company(OWN)]);
    expect(((await entry()).props.initialWorkspace as Workspace).tenantId).toBe(OWN);
  });
  it('AUTH-027 two non-demo companies, no ?tenant → first by membership order; switcher lists both', async () => {
    seed([member(OWN2), member(OWN)], [[OWN, 'Own Co', false], [OWN2, 'Second Co', false]], [company(OWN), company(OWN2, 'Second Co')]);
    const el = await entry();
    expect((el.props.initialWorkspace as Workspace).tenantId).toBe(OWN2);
    expect((el.props.memberships as { tenantId: string }[]).map(m => m.tenantId)).toEqual([OWN2, OWN]);
  });
  it('AUTH-028 account with no memberships → "No workspace assigned" with Sign out', async () => {
    seed([], [], []);
    const html = renderToStaticMarkup(await entry());
    expect(text(html)).toContain('No workspace assigned');
    expect(html).toContain('action="/auth/signout" method="post"');
    expect(text(html)).toContain('Sign out');
  });
  it('AUTH-029 inactive membership is treated as no membership for that company', async () => {
    seed([member(OWN), member(OWN2, 'Owner', { active: false })], [[OWN, 'Own Co', false], [OWN2, 'Second Co', false]], [company(OWN), company(OWN2, 'Second Co')]);
    const el = await entry(OWN2);
    expect((el.props.initialWorkspace as Workspace).tenantId).toBe(OWN);
    expect((el.props.memberships as { tenantId: string }[]).map(m => m.tenantId)).toEqual([OWN]);
    S.snapshots.clear();
    const res = await workspaceRoute.GET(new Request(`http://localhost/api/workspace?tenant=${OWN2}`));
    expect(res.status).toBe(403);
  });
  it('AUTH-030 tenant snapshot missing → "Workspace unavailable", no stack trace', async () => {
    seed([member(OWN)], [[OWN, 'Own Co', false]], []);
    const html = renderToStaticMarkup(await entry());
    expect(text(html)).toContain('Workspace unavailable');
    expect(html).not.toMatch(/at \w+ \(|Error:/);
  });
  it('AUTH-032 forgot password with empty email is validated client-side before any request', () => {
    // reset() is a type="button" handler (no native form validation), so it checks the address itself before posting.
    const source = src('src/components/login-screen.tsx');
    const reset = source.slice(source.indexOf('async function reset()'), source.indexOf('return <main'));
    expect(reset).toMatch(/if\s*\(\s*!email/);
    expect(reset.search(/if\s*\(\s*!email/)).toBeLessThan(reset.indexOf("postAuth('/auth/forgot'"));
  });
  it('AUTH-035 reset page shows "Choose a password of at least 8 characters" (initially checking the link)', () => {
    const t = text(renderToStaticMarkup(createElement(ResetPassword)));
    expect(t).toContain('Set a new password');
    expect(t).toContain('Choose a password of at least 8 characters.');
    expect(t).toContain('Checking your reset link');
  });
  it('AUTH-044 /auth/callback without code redirects to / (login) without error', async () => {
    const res = await callback('');
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe('http://localhost/');
    expect(S.exchanged).toEqual([]);
  });
  it('AUTH-045 /auth/callback?code=garbage redirects; no 500', async () => {
    const res = await callback('?code=garbage&next=/account/reset');
    expect(S.exchanged).toEqual(['garbage']);
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe('http://localhost/account/reset');
  });
  it('AUTH-046 /auth/callback?next=https://evil.com stays on the app', async () => {
    expect((await callback('?next=https://evil.com')).headers.get('location')).toBe('http://localhost/');
  });
  it('AUTH-047 /auth/callback?next=//evil.com stays on the app', async () => {
    expect((await callback('?next=//evil.com')).headers.get('location')).toBe('http://localhost/');
  });
  it('AUTH-048 /auth/signout exports POST only (GET → 405 by Next); POST signs out and 303s to /', async () => {
    expect(Object.keys(signoutRoute)).toEqual(['POST']);
    const res = await signoutRoute.POST(new Request('http://localhost/auth/signout', { method: 'POST' }));
    expect(S.signOuts).toBe(1);
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('http://localhost/');
  });
  it('AUTH-054 login right-hand panel hidden below 900px; form fills the width', () => {
    expect(src('src/app/globals.css')).toContain('@media(max-width:900px){.login-shell{grid-template-columns:1fr}.login-visual{display:none}');
  });
  it('AUTH-055 brand mark (gradient tile) and "Sahulat" + violet "ERP" wordmark', () => {
    const html = loginHtml();
    expect(html).toContain('<span class="brand-mark">S</span><span>Sahulat<strong>ERP</strong></span>');
    const css = src('src/app/globals.css');
    expect(css).toContain('.brand-mark{background:var(--gradient-brand)');
    expect(css).toContain('.login-brand strong{color:var(--accent)');
  });
  it('AUTH-056 benefit list is three plain lines with no statistics', () => {
    const items = [...loginHtml().matchAll(/<li>(.*?)<\/li>/g)].map(m => m[1]);
    expect(items).toHaveLength(3);
    expect(items.some(i => /\d/.test(i))).toBe(false);
  });
  it('AUTH-057 no "Working prototype" or "simulated" copy on login', () => {
    expect(text(loginHtml())).not.toMatch(/prototype|simulat/i);
  });
  it('AUTH-064 service-role key is referenced only by the server-only admin client; no client file reads secrets', () => {
    expect(src('src/lib/supabase/admin.ts')).toMatch(/^import 'server-only';/);
    const clientFiles = ['src/components/login-screen.tsx', 'src/components/reset-password.tsx', 'src/components/workbench.tsx', 'src/lib/supabase/client.ts', 'src/app/layout.tsx'];
    for (const f of clientFiles) expect(src(f), f).not.toMatch(/SERVICE_ROLE|SECRET|createAdminSupabase/);
  });
  it('AUTH-065 session cookies are HttpOnly; no token in localStorage', async () => {
    // The real server client signs in (only next/headers and Supabase's HTTP answer are faked) and writes the session as HttpOnly, SameSite=Lax cookies.
    const { createServerSupabase } = await vi.importActual<typeof import('../../src/lib/supabase/server')>('../../src/lib/supabase/server');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://qa.supabase.co');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY', 'sb_publishable_qa');
    vi.stubGlobal('fetch', async () => Response.json({ access_token: 'header.payload.signature', token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: 'refresh-qa', user: { id: USER.id, aud: 'authenticated', email: USER.email, app_metadata: {}, user_metadata: {}, created_at: new Date().toISOString() } }));
    jar.clear();
    try { expect((await (await createServerSupabase()).auth.signInWithPassword({ email: USER.email, password: 'secret-123' })).error).toBeNull(); }
    finally { vi.unstubAllGlobals(); vi.unstubAllEnvs(); }
    expect(jar.size).toBeGreaterThan(0);
    for (const [name, { options }] of jar) {
      expect(name).toMatch(/^sb-qa-auth-token/);
      expect(options, name).toMatchObject({ httpOnly: true, sameSite: 'lax', path: '/' });
    }
    // No browser Supabase client is left: the login and reset screens post to the /auth/* route handlers instead.
    for (const f of ['src/components/login-screen.tsx', 'src/components/reset-password.tsx', 'src/lib/supabase/client.ts']) expect(src(f), f).not.toMatch(/@supabase\/|createBrowserClient|auth-token/);
  });
  it('AUTH-068 member:create for an existing email updates the password and creates no second company [documented: verified from script source; not run against hosted]', () => {
    const s = src('scripts/create-member.ts');
    expect(s).toContain('admin.auth.admin.updateUserById(existing.id, { password');
    expect(s).toMatch(/if \(!has\.present\) \{[\s\S]*insert into public\.tenants/);
  });
  it('AUTH-069 member:create without MEMBER_PASSWORD fails with a clear message', () => {
    expect(src('scripts/create-member.ts')).toContain("if (!url || !key || !db || !email || !password) throw new Error('MEMBER_EMAIL, MEMBER_PASSWORD and Supabase configuration are required.')");
  });
  it('AUTH-071 company:reset for an unknown email errors "No account for …"', () => {
    expect(src('scripts/reset-company.ts')).toContain('if (!user) throw new Error(`No account for ${email}.`)');
  });
  it('AUTH-072 company:reset refuses a member with two own companies', () => {
    expect(src('scripts/reset-company.ts')).toContain('if (tenants.length !== 1) throw new Error(`Expected exactly one own company for ${email}, found ${tenants.length}.`)');
  });
  it('AUTH-075 dark-mode OS: app stays light; theme-color matches the page background', () => {
    const layout = src('src/app/layout.tsx');
    expect(layout).toContain('colorScheme: "light"');
    expect(layout).toContain('themeColor: "#f6f7fb"');
    expect(src('src/app/tokens.css')).toContain('--gray-50: #f6f7fb;');
    for (const f of ['src/app/globals.css', 'src/app/tokens.css', 'src/app/print/print.css']) expect(src(f)).not.toContain('prefers-color-scheme');
  });
  it('AUTH-080 Auditor signing in to a company in setup sees "… is being set up" with Sign out, never the wizard', () => {
    const w = blankSetup();
    const html = renderToStaticMarkup(createElement(Workbench, { initialWorkspace: w, actor: { id: 'a', name: 'Audit', role: 'Auditor', branchIds: [] }, memberships: [] }));
    expect(text(html)).toContain(`${w.company.name} is being set up`);
    expect(html).toContain('action="/auth/signout"');
    expect(html).not.toContain('wizard');
  });
  it('AUTH-081 non-owner role signing in to a company in setup gets the setup card', () => {
    const html = renderToStaticMarkup(createElement(Workbench, { initialWorkspace: blankSetup(), actor: { id: 's', name: 'Sales Lead', role: 'Sales Manager', branchIds: [] }, memberships: [] }));
    expect(html).toMatch(/setup-card|wizard/);
    expect(html).toContain('setup-backdrop');
  });
  it('AUTH-082 ?tenant=<demo you belong to> opens the demo company, flagged as demo', async () => {
    seed([member(OWN), member(DEMO_TENANT)], [[DEMO_TENANT, 'Demo', true], [OWN, 'Own Co', false]], [buildDemoWorkspace(), company(OWN)]);
    const el = await entry(DEMO_TENANT);
    const w = el.props.initialWorkspace as Workspace;
    expect(w.tenantId).toBe(DEMO_TENANT);
    expect(w.demo).toBe(true);
    expect((el.props.memberships as { tenantId: string; isDemo: boolean }[]).find(m => m.tenantId === DEMO_TENANT)?.isDemo).toBe(true);
    const html = renderToStaticMarkup(createElement(Workbench, el.props as never));
    expect(text(html)).toContain('Demo workspace');
  });
  it('AUTH-083 controls are disabled until hydrated so no click is lost (login buttons and workbench nav)', () => {
    const wb = renderToStaticMarkup(createElement(Workbench, { initialWorkspace: buildDemoWorkspace(), actor: { id: 'o', name: 'Owner', role: 'Owner', branchIds: [] }, memberships: [] }));
    expect([...wb.matchAll(/<button data-module="[^"]+" class="nav-item[^"]*"( disabled="")?/g)].every(m => m[1])).toBe(true);
    const login = loginHtml();
    expect(login).toMatch(/<button class="button button-primary" type="submit" disabled="">/);
    expect(login).toMatch(/<button type="button" class="text-button" disabled="">Forgot your password\?<\/button>/);
  });
  it('AUTH-087 JavaScript disabled: static login renders and a native submit carries no credentials (inputs have no name)', () => {
    const html = loginHtml();
    expect(text(html)).toContain('Sign in securely');
    expect(html).not.toMatch(/<input[^>]*\sname=/);
    expect(html).not.toMatch(/<form[^>]*method="get"[^>]*action=/i);
  });
  it('AUTH-089 forgot-password confirmation does not reveal whether the account exists', () => {
    expect(src('src/components/login-screen.tsx')).toContain("'Password reset instructions were sent if this address is registered.'");
  });
  it('AUTH-091 /api/branding/logo while signed out → 401', async () => {
    const res = await brandingRoute.GET(new Request(`http://localhost/api/branding/logo?tenant=${OWN}`), { params: Promise.resolve({ kind: 'logo' }) });
    expect(res.status).toBe(401);
  });
  it('AUTH-092 /print/sales_invoice/<id> while signed out → sign-in message, never the document', async () => {
    const demo = buildDemoWorkspace(); seed([], [], [demo]); S.user = null;
    const doc = demo.documents.find(d => d.kind === 'sales_invoice')!;
    const html = renderToStaticMarkup(await PrintPage({ params: Promise.resolve({ kind: 'sales_invoice', id: doc.id }), searchParams: Promise.resolve({ tenant: DEMO_TENANT }) }));
    expect(text(html)).toContain('Sign in to print documents.');
    expect(html).not.toContain(doc.number);
  });
  it('AUTH-094 page title is "SahulatERP · Your business, connected"', () => {
    expect(src('src/app/layout.tsx')).toContain('title: "SahulatERP · Your business, connected"');
  });
  it('AUTH-095 favicon present', () => {
    expect(existsSync(resolve(root, 'public/favicon.svg'))).toBe(true);
    expect(src('src/app/layout.tsx')).toContain('icons: { icon: "/favicon.svg" }');
  });
  it('AUTH-098 member removed from a company → next load falls back to remaining companies, then "No workspace assigned"', async () => {
    seed([member(OWN), member(OWN2)], [[OWN, 'Own Co', false], [OWN2, 'Second Co', false]], [company(OWN), company(OWN2, 'Second Co')]);
    expect(((await entry(OWN)).props.initialWorkspace as Workspace).tenantId).toBe(OWN);
    S.memberships = S.memberships.filter(m => m.tenant_id !== OWN);
    expect(((await entry(OWN)).props.initialWorkspace as Workspace).tenantId).toBe(OWN2);
    S.memberships = [];
    expect(text(renderToStaticMarkup(await entry(OWN)))).toContain('No workspace assigned');
  });
  it('AUTH-099 inputs labelled "Email address" / "Password"; button text and eye button label present', () => {
    const html = loginHtml();
    expect(html).toMatch(/<label>Email address<div class="input-wrap">[\s\S]*?<input[^>]*type="email"/);
    expect(html).toMatch(/<label>Password<div class="input-wrap">[\s\S]*?<input[^>]*type="password"/);
    expect(html).toContain('aria-label="Show password"');
  });

  const todo: [string, string][] = [
    ['AUTH-002', '[browser] valid sign-in lands on own company (Overview or setup card) without error'],
    ['AUTH-003', '[browser] wrong password shows error under the form, stays on login, no reload'],
    ['AUTH-004', '[browser] unknown email shows the same generic error as wrong password (hosted Supabase message)'],
    ['AUTH-007', '[browser] email with surrounding spaces is trimmed by type=email and accepted'],
    ['AUTH-008', '[browser] upper-case email signs in (Supabase case-insensitive)'],
    ['AUTH-009', '[browser] password with leading/trailing spaces is not trimmed'],
    ['AUTH-010', '[browser] 200-character password accepted when it matches'],
    ['AUTH-011', "[browser] SQL-ish email ' OR 1=1--@x.com gives generic failure, no 500"],
    ['AUTH-012', '[browser] script tag in email renders as text in any error'],
    ['AUTH-013', '[browser] Unicode email local part rejected or generic failure, no crash'],
    ['AUTH-014', '[browser] eye toggle shows/hides characters and keeps the cursor'],
    ['AUTH-016', '[browser] Enter in password field submits'],
    ['AUTH-017', '[browser] double-click sends one request; spinner and disabled while busy'],
    ['AUTH-018', '[browser] reload keeps the cookie session'],
    ['AUTH-019', '[browser] sign out from sidebar profile returns to login; Back does not show workspace content'],
    ['AUTH-031', '[manual] reset email delivery with link to /auth/callback?next=/account/reset (redirectTo verified in source)'],
    ['AUTH-033', '[browser] forgot password for unknown email shows the same confirmation text'],
    ['AUTH-034', '[manual] two quick reset requests: hosted Supabase rate limit surfaced cleanly'],
    ['AUTH-036', '[browser] set an 8-char password via reset link; new works, old fails'],
    ['AUTH-037', '[browser] 7-char new password refused with length message'],
    ['AUTH-038', '[browser] empty new password blocked'],
    ['AUTH-039', '[manual] 72+ char new password: hosted GoTrue limit, never silently truncated'],
    ['AUTH-040', '[manual] new password equal to old: hosted Supabase policy'],
    ['AUTH-041', '[browser] reset page without a session shows expired state with link to login'],
    ['AUTH-042', '[browser] reused reset link shows expired state'],
    ['AUTH-043', '[manual] reset link opened in a different browser'],
    ['AUTH-049', '[browser] sign out in one tab; other tab next command gets 401 and shows login'],
    ['AUTH-050', '[manual] session expiry after refresh-token lapse returns to login'],
    ['AUTH-051', '[browser] two accounts in two browser contexts see only their own memberships'],
    ['AUTH-052', '[browser] same account in two tabs; commands from both apply'],
    ['AUTH-053', '[browser] login at 390px: single column, 16px inputs, no horizontal scroll'],
    ['AUTH-058', '[browser] reduced-motion: no slide animations on login'],
    ['AUTH-059', '[manual] password-manager autofill fills both fields'],
    ['AUTH-060', '[browser] Back after sign-in does not show the login form while signed in'],
    ['AUTH-061', '[browser] sign in offline shows network error; retry works online'],
    ['AUTH-062', '[browser] slow auth (>10s): spinner persists, no duplicate submit'],
    ['AUTH-063', '[browser] network inspection: password only in HTTPS body to Supabase, never in URL/logs'],
    ['AUTH-066', '[browser] reset flow for one user then sign in as another in same browser: no leakage'],
    ['AUTH-067', '[manual] member:create with MEMBER_DEMO=1 against hosted: sees own and demo company'],
    ['AUTH-070', '[manual] company:reset against hosted: next sign-in shows setup card'],
    ['AUTH-073', '[browser] wrong-password copy is plain English (shows raw Supabase error.message today)'],
    ['AUTH-074', '[browser] violet focus ring visible with keyboard'],
    ['AUTH-076', '[browser] 254-char email accepted or clear error'],
    ['AUTH-077', '[browser] pasted email with newline stripped or rejected'],
    ['AUTH-078', '[browser] emoji password works if set that way'],
    ['AUTH-079', '[manual] 20 failed logins/minute: hosted Supabase rate limit surfaced'],
    ['AUTH-084', '[browser] refresh /account/reset after success shows expired/complete state'],
    ['AUTH-085', "[manual] reset page with another user's recovery token changes only that user"],
    ['AUTH-086', '[manual] cookies disabled: clear failure, no loop'],
    ['AUTH-088', '[browser] plus-tag email a+qa@x.com signs in'],
    ['AUTH-090', '[browser] sign out while a command is in flight returns to login without error'],
    ['AUTH-093', '[browser] deep link /print/... then sign in reaches the app'],
    ['AUTH-096', '[browser] 3G throttle: login usable, no duplicate submissions'],
    ['AUTH-097', '[manual] password changed elsewhere: session continues until refresh fails'],
    ['AUTH-100', '[manual] full round trip script sign-up → sign in → setup → sign out → forgot → reset → sign in'],
  ];
  for (const [id, title] of todo) it.todo(`${id} ${title}`);
});

function blankSetup(): Workspace {
  const w = freshCompany();
  return { ...w, setup: { complete: false, step: 1 } };
}

# Session prompts

How to use: start a fresh Claude Code session in the repo and paste the one-line driver below. Claude Code reads this file and `docs/PLAN.md`, finds the next step whose Status is empty, and does only that step. If this file has a section for that step, that section is the brief; otherwise the generic template applies.

## Driver (paste this every session)

```
Do the next undone step in docs/PLAN.md. Use docs/PROMPTS.md if it has a section for that step; otherwise use the generic template there. Stop when the step's acceptance is met and the status is marked.
```

To chain low-risk steps (Phase 1 only, Steps 5–10): "Do Steps 5 to 10 in sequence; stop at the first failing check; mark each done as you go." Never chain Steps 13, 20, 25, 28, 32 or 41; each needs an accountant's check before it is marked done.

## Generic template (applies to every step without its own section)

Read CLAUDE.md, then docs/PLAN.md section for Step N and nothing else from the plan. Do only Step N.

- Deliver exactly the step's Deliverable. Done means the step's Acceptance holds and `npm run check` passes (and `npm run test:e2e` if the step has a screen).
- Follow the module layout in PLAN.md "Architecture": `src/modules/<name>/{schema,rules,commands,queries}.ts`, screens in `src/app/(app)/<module>/`.
- Every table: tenant_id, RLS with FORCE, composite unique (tenant_id, id), audit row on every command, decimal.js for amounts, dated rate tables for anything statutory.
- Show the migration SQL before applying it. No new dependency without asking. Nothing from a later step; note it in docs/LATER.md.
- When finished: mark the step done with today's date in docs/PLAN.md, commit as "Step N: <title>", push, and report what changed, what you did not do, and what the founder must click through to verify.

## Housekeeping before Step 2 (run once, before Step 1 or 2)

Housekeeping, nothing from PLAN.md's steps. Show diffs before committing.

1. Confirm docs/PLAN.md contains the full build plan (a "Build sequence" heading, Step 0 marked Done). If it is still a placeholder, stop and say so.
2. .github/workflows/ci.yml: single job `verify` on push and pull_request: checkout, Node 22, `npm ci`, `npm run check`, `npm run build`. Delete the e2e job and every QA_*/BOOTSTRAP_* reference.
3. package.json: add `"engines": {"node": "22.x"}`. Using the Vercel CLI, set the project's Node version to 22.x.
4. Vercel: remove SUPABASE_SERVICE_ROLE_KEY from Production and Preview (show the command, wait for a yes). The web app must never hold it.
5. .env.local: remove LOCAL_DEMO, BOOTSTRAP_OWNER_ID, BOOTSTRAP_OWNER_EMAIL, BOOTSTRAP_OWNER_PASSWORD. Keep NEXT_PUBLIC_APP_URL and add it to .env.example with a placeholder.
6. Supabase (Management API, show each call, wait for a yes): delete unused API keys app_202611081821 and server_202611081821; leave the default pair. Set auth site_url to https://sahulaterp.vercel.app and the redirect allow-list to https://sahulaterp.vercel.app/**, https://*-khanfazal6888-5679s-projects.vercel.app/** and http://localhost:3000/**. Minimum password length 10. disable_signup true.
7. `npx playwright install chromium`; create e2e/smoke.spec.ts that loads / and checks the heading; confirm `npm run test:e2e` passes.
8. Reconfigure the supabase MCP with the read_only flag (claude mcp remove + add).
9. `npm run check`, commit "Housekeeping before Step 2", push, confirm CI green. Report what changed and anything you could not do.

## Step 1: UI mock-ups

This step produces MOCK-UPS, not application code. Nothing goes in src/. Create docs/mockups/ with static HTML files (plain HTML + one shared CSS file, no framework, no build step, no JavaScript beyond tab switching). They must open by double-clicking. They are throwaway reference material for Step 3.

Screens, each a file linked from docs/mockups/index.html:

1. owner.html — Owner home: cash and bank balances, receivables total and overdue, today's sales, approvals waiting, the "Needs attention" inbox list.
2. salesperson.html — my customers with balance and last order, my open orders, my drafts, "new order" button.
3. recovery.html — cheques due to deposit today, cheques due to clear, overdue customers by days overdue, today's follow-ups with a "promised" column.
4. warehouse.html — goods to receive (expected shipments), deliveries to pick today, stock below reorder level, pending transfers.
5. accountant.html — unposted drafts, unreconciled bank lines count, bills due this week, period close status, trial balance snapshot.
6. inbox.html — the shared "Needs attention" list as one table: type, what, who, due, one action button.
7. invoice.html — the sales invoice following the one-document pattern: header (customer, date, number, branch), lines table with keyboard-entry hints (item code, qty, unit, price, discount, amount), totals, status bar with the primary next action, right-hand timeline. A "More" toggle reveals tax category, salesperson split, currency/FX and FBR fields; hidden by default. Two states: draft (editable) and submitted (locked, with print/email).
8. invoice-list.html — a list page: table with saved-filter chips, sort, column chooser, export.

Rules: realistic synthetic Pakistani data (a bike-parts importer; PKR with lakh/crore grouping, e.g. Rs 12,45,600; DD-MM-YYYY; Karachi/Lahore; no real company names). Desktop first at 1280px, must not break at 390px. No module menu first on any home screen; a slim left rail with only that role's modules. A "What to ask the reviewer" box at the bottom of each screen with three questions. Create docs/UI-NOTES.md with a heading per screen and an empty table (Reviewer, Comment, Decision) under each.

Finish by opening docs/mockups/index.html in the browser preview, screenshotting each screen, listing the files. Commit "Step 1: UI mock-ups for review". Do NOT mark Step 1 done; the founder marks it after the reviews.

## Step 2: tenants, auth, audit, RLS

Deliver: tenants, memberships, branches (minimal), audit_log; sign-in, forgot/reset, sign-out, tenant switcher, eight roles, branch scoping, an audit helper every command calls; RLS on every table. Done means: Playwright proves two tenants with one user each cannot see each other's rows via the UI or any server action; an audit row is written on sign-in; `npm run check` and `npm run test:e2e` pass.

Design decisions, fixed for this and every later step:

Database access
- Migrations run as `postgres` via MIGRATION_DATABASE_URL (session pooler, 5432).
- The web app connects with Drizzle + postgres-js via DATABASE_URL (transaction pooler, 6543, `prepare: false`) as a NEW role `app_runtime` created in the first migration: LOGIN, NOBYPASSRLS, NOSUPERUSER, only the grants it needs. Generate a strong password; store it only in .env.local and Vercel (show the command, wait for a yes). Revoke the blanket default privileges for anon and authenticated on public tables; grant to app_runtime explicitly.
- Every request-time query runs inside `db.transaction` which first executes `select set_config('app.user_id', $1, true), set_config('app.tenant_id', $2, true)`. RLS policies read `current_setting('app.tenant_id', true)` and check membership. FORCE ROW LEVEL SECURITY on every table. One helper `withTenant(userId, tenantId, fn)` in src/db/ is the only way to get a transaction.
- Supabase JS (@supabase/ssr) is used for sign-in, session cookies, password reset and later storage. Never for application tables. The user id comes from the verified session.
- Read node_modules/next/dist/docs/01-getting-started/16-proxy.md and 02-guides/authentication-with-cache-components.md before writing the session refresh (proxy.ts) and any page that reads the session. cacheComponents is on; auth-dependent pages opt out of caching correctly, not by disabling cacheComponents.

Tenancy and keys
- Every table: `id uuid primary key default gen_random_uuid()`, `tenant_id uuid not null references tenants(id)`, `created_at timestamptz`, `created_by uuid`. Composite `unique (tenant_id, id)` so later foreign keys can be `(tenant_id, x_id)`. Memberships: `(tenant_id, user_id)` primary key, `role` enum with the eight roles (Owner, Accountant, Sales Manager, Salesperson, Recovery Officer, Warehouse Manager, Payroll Administrator, Auditor), `branch_ids uuid[]`, `active boolean`.
- Audit: `audit_log(tenant_id, actor_user_id, actor_role, action, entity, entity_id, before jsonb, after jsonb, at timestamptz)`. Insert-only; no update or delete grants to app_runtime.

Onboarding
- No public sign-up. First user is created by `npm run owner:create`, which invites an email via the Admin API using the service-role key from .env.local; that user creates a tenant on first login (minimal "create company" form; the full wizard is Step 11). Owners invite members by email; invitees set a password via the reset flow.

Tests
- Vitest: policy tests that connect as app_runtime, set a tenant, assert a cross-tenant select returns zero rows and a cross-tenant insert fails. Playwright: two tenants, two users, both flows. Synthetic data only.

Show the migration SQL before applying. When finished: mark Step 2 done with the date in docs/PLAN.md, list what changed, what was not done, and anything added to docs/LATER.md.

## Step 3 note

Before Step 3 (app shell and role home screens), docs/UI-NOTES.md must contain reviewer comments. If it is empty, stop and tell the founder to do the reviews first.

## Step 23 note

When Step 23 is finished, remind the founder to create their owner account and click through everything built since Step 2 on the deployment. On 2026-11-11 the founder put this off until after Step 23:

```
npm run owner:create -- <founder's email> --url=https://sahulaterp.vercel.app
```

Until then, definition-of-done item 5 (the founder clicks through on the dev deployment) is outstanding for Step 2 onwards. Each session proves its step with the automated tests and sends screenshots of the new screens instead.

## Accountant checkpoints

Steps 13, 20, 25, 28, 32 and 41: the session must end by producing a one-page worked example (docs/examples/step-N.md) showing the input document and the exact journal lines, for the founder to take to the accountant. The step is not marked done until the founder says the accountant agreed.

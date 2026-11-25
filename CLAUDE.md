# SahulatERP

Read [docs/PLAN.md](docs/PLAN.md) and do only the step you are asked.

Steps 21 to 46 can be built in three tracks at once. If you are asked to build in a track, read [docs/PARALLEL.md](docs/PARALLEL.md) first: it says which steps are whose, which files a track may edit, and how a step is merged.

## Stack

- Next.js (App Router), TypeScript, Tailwind CSS, ESLint
- PostgreSQL and Auth on Supabase: `@supabase/supabase-js`, `@supabase/ssr`
- Drizzle: `drizzle-orm`, `drizzle-kit`, with the `postgres` driver
- `decimal.js` for amounts, `zod` for validation
- shadcn/ui
- Vitest for unit tests, `@playwright/test` for end-to-end tests
- Hosted on Vercel

## Rules

- Money, quantities and rates are decimal.js in code and numeric in the database. Never a JS number for an amount.
- Every table has tenant_id and an RLS policy before any row is inserted.
- Request handlers use the signed-in user's Supabase client; the service-role key is used only by migrations and the worker.
- Documents, stock moves and journals are written only by the posting engine, inside one transaction.
- Posted journals are never updated or deleted; corrections are reversals.
- Every command writes an audit row: who, role, when, what, before, after.
- Document numbers come from number_series inside the transaction; never computed in the app, never reused.
- Tax and withholding come from dated tables via tax/rules.ts; no rate is ever typed into a command or screen.
- External calls record intent before and outcome after; on an ambiguous result, query before retrying; never blindly resubmit an FBR invoice.
- No new dependency without the founder's approval. No work from a later step; note it in docs/LATER.md (from Step 21: in docs/later/step-NN.md).
- From migration 0020 on: a migration adds to a shared list (journal kinds, the starting chart, numbered documents, protected audit rows) with a function of its own, never by writing the shared function out again, and takes every new function away from PUBLIC. One built in a track also says whose it is (`-- track: A`) and never changes a function, policy or trigger another track wrote (docs/PARALLEL.md). `npm run check` enforces this.
- A database function is written with `SET search_path = pg_catalog, pg_temp`, never an empty path, and the app's role makes no temporary objects (drizzle/0023_safe_search_path.sql says why). `npm run check` and the policy tests enforce this.
- Who is signed in is proven to the database, not stated: the app says it only through `withTenant()` and `enterTenant()`, which call `app.enter` with a signature, and a test through `enterAs` / `enterSql` (tests/support/identity.ts). No function, test or script reads or writes the settings `app.user_id` or `app.tenant_id` (drizzle/0031_identity_proof.sql says why). `npm run check` enforces this.
- The version under the sign-in box is `version` in package.json, shown as its first two numbers (1.0, 1.1). A merge to main that changes what a member sees raises the second number by one (`npm version minor --no-git-tag-version`); the founder says when the first changes.
- Customer data, CNICs, salaries, tokens and keys never enter Git, fixtures or logs.
- Nothing in reference/ is imported or run.
- Never run destructive SQL, reset a password, disable a key, or change a Vercel production env var without showing the exact command and getting a yes. The Supabase MCP must be run read-only against any project holding real customer data.

@AGENTS.md

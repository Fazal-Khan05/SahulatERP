# SahulatERP

Read [docs/PLAN.md](docs/PLAN.md) and do only the step you are asked.

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
- No new dependency without the founder's approval. No work from a later step; note it in docs/LATER.md.
- Customer data, CNICs, salaries, tokens and keys never enter Git, fixtures or logs.
- Nothing in reference/ is imported or run.

@AGENTS.md

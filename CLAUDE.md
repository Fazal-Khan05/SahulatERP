# SahulatERP — Development Guidance

Updated 24 September 2026 after the founder prioritized a complete product over a fixed launch date.

## Project status

Working prototype. Next.js, Supabase authentication/PostgreSQL, migrations, a seeded vertical slice and automated tests exist. Use the real commands documented in README.md and keep external integrations simulated.

## Read first

1. [EXECUTION-PLAN.md](EXECUTION-PLAN.md) — current proposed scope, assumptions, architecture and gates.
2. [IMPLEMENTATION-BACKLOG.md](IMPLEMENTATION-BACKLOG.md) — ordered tasks/dependencies; all initially unstarted.
3. `research/` and `SAHULATERP-MASTER.md` — historical context, not unconditional technical or legal authority.

The end-of-2026 target and old delivery sequence are superseded. New forecasts are capacity assumptions, not commitments. The complete first release serves importer-distributors; unrelated industries remain future scope.

## Product and implementation direction

- Build a commercial cloud SaaS with TypeScript, Next.js, PostgreSQL/Supabase, Drizzle and Tailwind/shadcn. Use a modular monolith and one durable Postgres-backed job mechanism.
- Retain the ground-up approach. Reopen the stack/fork decision only with concrete new evidence.
- Validate commissions against reviewed examples early; finish connected trading, accounting, imports, compliance and payroll before public release.
- Exact partner rules, goods, volumes, budget and founder capacity remain discovery inputs. Do not silently assume them.
- Competitor absence claims and prices are hypotheses. Bundled compliance is a commercial direction, not evidence of zero operating cost.

## Correctness requirements

1. Decimal-safe money from input through storage/calculation/output; defined amount, quantity, rate and FX precision/rounding.
2. Editable draft journals, immutable posted journals, explicit reversals/adjustments. Enforce balanced postings and source uniqueness atomically; a normal row CHECK cannot enforce a cross-line sum.
3. Versioned/effective-dated rules plus transaction snapshots preserve historical results.
4. Tenant-aware keys, restricted roles, RLS and business permissions protect tenant data. Test actual database paths, storage, exports and workers. Service-role credentials bypass RLS and must not be ordinary runtime query credentials.
5. Persist integration intent/outcomes. Local retry safety does not imply remote deduplication. Do not blindly resubmit an FBR invoice after an ambiguous timeout.
6. Model partial commission accrual/release/payout/reversal as source-linked amounts and immutable movements. One status field is insufficient.
7. Classify import outlays before allocating inventory costs; reconcile remaining inventory and COGS when charges arrive late.
8. Accounting, stock, commission, payroll and tax must reconcile. Payroll must not expense an already accrued commission twice.

## Compliance evidence

The original OAuth/endpoints and blanket 72-hour edit/delete assumptions are not implementation authority. Follow the verified FBR contract and accountant/integrator-reviewed scenarios in the execution plan. Do not hardcode universal rates, exemptions, input caps or payroll assumptions from research prose.

## Working practice

- Review schema and posting examples before feature code. AI can draft; founder and relevant specialists must understand/review the model.
- Build one complete slice: migration, logic, UI, access, audit, failures and meaningful tests.
- Verify financial invariants, tenancy/permissions, concurrency, external failure recovery and restore. Use focused workflow tests elsewhere.
- Resolve reference-data disagreements with the accountant; incumbent outputs are not automatically correct.
- Keep customer data, salaries, CNICs and secrets out of Git. Use protected originals and redacted/synthetic fixtures.
- Update plan/backlog and decision records when scope changes. Preserve original research instead of duplicating another master document.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

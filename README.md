# SahulatERP

Commercial cloud ERP prototype for Pakistani importer-distributors with sales teams. The application now has Supabase authentication, isolated tenants, a PostgreSQL schema with RLS, synthetic posted transactions and working module screens.

The founder prioritizes a complete, reliable product over a fixed launch date. The old end-of-2026 deadline is retired.

## Run the prototype

1. Copy `.env.example` to `.env.local` and add the Supabase project values. Never commit this file.
2. Install dependencies with `npm install`.
3. Apply hosted migrations with `npm run db:migrate`.
4. Create the configured demo owner with `npm run auth:bootstrap`.
5. Load the resettable synthetic company with `npm run db:seed`.
6. Start the application with `npm run dev` and open `http://127.0.0.1:3000`.

The configured owner email is `owner@sahulaterp.com`. Its password exists only in `.env.local`.

Verification commands:

- `npm run typecheck`
- `npm test`
- `npm run test:e2e`
- `npm run build`
- `npm run db:check`

## Implemented prototype

- Real Supabase password authentication and protected workspaces
- Demo and design-partner tenants with PostgreSQL RLS read policies
- Sales, purchasing, inventory, imports, collections, PDC, commission, payroll, accounting and simulated FBR command logic
- Decimal-safe postings, immutable posted journal tables, period locks and optimistic command revisions
- Resettable synthetic transactions including partial collection, bounced cheque, return after payout, import landed cost and unknown FBR outcome
- Responsive dashboards, module tables, transaction entry, approvals, audit history, role preview and safe demo reset
- Automated financial-invariant and signed-in browser tests

External FBR, bank, customs, salary and notification transmissions remain simulators. Payroll and tax configurations are demonstrations requiring specialist review before any production rollout. The partner tenant is intentionally empty until redacted imports are reviewed.

## Planning and source material

- [Execution plan](EXECUTION-PLAN.md): scope, sequence, capacity/effort model, gates, commercial assumptions and risks.
- [Implementation backlog](IMPLEMENTATION-BACKLOG.md): ordered tasks, dependencies and acceptance criteria. All are unstarted.
- [Development guidance](CLAUDE.md): current implementation rules.

## Original research

- [Master document](SAHULATERP-MASTER.md)
- [Market scan](research/01-pakistan-erp-market-scan.md)
- [Tax/compliance notes](research/02-pakistan-tax-compliance-spec.md)
- [Original technical recommendation](research/03-build-vs-fork-recommendation.md)
- [Original PRD](research/04-prd-v1.md)

These September 22 documents preserve original reasoning. Their dates, technical/legal claims and pricing are not automatically current or verified. Use the execution plan where planning recommendations conflict. Business-specific and statutory rules still require the evidence/review specified there.

The Supabase prototype project is provisioned. GitHub/Vercel deployment and partner-data validation remain to be completed.

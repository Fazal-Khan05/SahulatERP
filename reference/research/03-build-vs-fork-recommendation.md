# Build vs Fork — Technical Recommendation
**Date:** 2026-09-22
**Constraints given:** Solo founder · self-funded · fully AI-assisted development · cloud SaaS only · target launch end-2026 (~15 months) · one committed paying design partner

---

## Recommendation, up front

**Build ground-up on a mainstream TypeScript + Postgres stack. Do not fork ERPNext or Odoo.**

This is the opposite of the advice I'd give a funded team of five, and it's driven almost entirely by
the "solo + AI-assisted" constraint. Reasoning below.

---

## The decisive argument

The instinct is "fork ERPNext, get accounting and inventory for free, build only the Pakistan bits."
That instinct is wrong here, for one reason:

**The modules you'd inherit for free are the commodity ones. The modules that make SahulatERP worth
buying do not exist in any base you could fork.**

Rough split of v1 effort:

| Area | Exists in ERPNext? | Must build regardless |
|---|---|---|
| Double-entry ledger, COA | ✅ Yes | |
| Basic inventory & stock moves | ✅ Yes | |
| Invoicing skeleton | ✅ Yes | |
| **FBR digital invoicing (IRN, QR, OAuth, queue, 72h edit window)** | ❌ No | ✅ |
| **Annex-A/B/C/I + STR-7 generation, 8B cap, ATL lookup, further tax** | ❌ No | ✅ |
| **Import landed costing (GD, RD/ACD, multi-basis apportionment, FX)** | ❌ Partial/weak | ✅ |
| **Commission engine (hierarchy, slabs, targets, recovery-linked, clawback)** | ❌ No | ✅ |
| **Pakistani payroll (EOBI, SESSI/PESSI, gratuity, effective-dated slabs)** | ❌ No | ✅ |
| **Credit control / udhaar / PDC cheque management** | ❌ Weak | ✅ |

You inherit maybe **30–35%** of the work. You pay for it with a permanent comprehension tax on the
other 65% — every custom module has to fit Frappe's DocType model, its hooks, its ORM, its migration
system, its build pipeline.

---

## Why forking is specifically bad for AI-assisted solo development

1. **Frappe is a niche framework.** Models write Next.js, React, Postgres and plain Python far more
   reliably than they write Frappe DocTypes, `hooks.py` wiring, or bench site management. You will spend
   a large fraction of your time correcting confidently-wrong framework code — the worst possible failure
   mode when you're solo and can't ask a colleague.

2. **You cannot reason about code you didn't write, in a codebase of that size, alone.** When a stock
   valuation number comes out wrong, you need to trace it. In your own 30k-line codebase that's an
   afternoon. In ERPNext it's a week, and AI assistance degrades sharply the further you get from the
   code in your context window.

3. **Upgrades punish customisation.** Deep customisations break on upstream upgrades. Solo, you will
   eventually stop upgrading — and then you're maintaining a stale fork of someone else's ERP with none
   of the community benefit.

4. **Multi-tenant SaaS on Frappe means bench multi-site** — separate sites, separate databases, heavier
   ops. You said cloud SaaS only. A single multi-tenant Postgres app with row-level security is
   dramatically less operational work for one person.

5. **You inherit a UX you can't differentiate on.** Candela's top user complaint is literally *"Not User
   Friendly."* ERPNext's interface is functional and dated. If you fork it, you've thrown away one of
   your few sustainable advantages against incumbents.

**Odoo is rejected outright:** Enterprise licensing eats your margin, you'd be the 31st Odoo partner in
Pakistan, and you'd be a services business rather than a product company. That's a different career.

---

## Recommended stack

Chosen for one criterion above all: **maximum AI training coverage**, so generated code is right more often.

| Layer | Choice | Why |
|---|---|---|
| Language | **TypeScript, end to end** | Types catch an entire class of bugs that a solo dev without a QA function will otherwise ship. Non-negotiable given the constraints. |
| Framework | **Next.js (App Router)** | Enormous training representation. Server actions remove a whole API layer you'd otherwise maintain. |
| Database | **PostgreSQL** | Correct decimal arithmetic, real constraints, mature. |
| Hosting/DB platform | **Supabase** | Postgres + auth + storage + **native row-level security**, which is your multi-tenancy primitive. Already wired into this session. |
| ORM | **Drizzle** | SQL-shaped, predictable, easy to audit generated queries. |
| UI | **Tailwind + shadcn/ui** | Best-represented component idiom; gets you a clean, modern interface that beats every local incumbent on first impression. |
| Background jobs | **Postgres-backed queue** (e.g. pgmq / Graphile Worker) | FBR submission retries, payroll runs, commission recalcs. Don't add Redis until you need it. |

### Non-negotiable engineering rules

1. **Money is never a float.** Use integer minor units (paisa) or Postgres `NUMERIC`. Never `float`/`double`.
   Enforce it in the schema so it can't be violated later.
2. **The ledger is append-only.** Journal entries are immutable. Corrections are reversing entries, never
   edits. This is also what your auditors and FBR's 72-hour rule effectively require.
3. **A database constraint or test asserts `sum(debits) == sum(credits)` on every journal entry.** If you
   write one test in the whole product, write this one.
4. **Every rate is effective-dated configuration** — tax slabs, EOBI, minimum wage, commission rates. You
   must be able to reproduce a June 2026 payslip in 2029. Retrofitting effective-dating is brutal.
5. **`tenant_id` on every table, enforced by RLS policy, not by application code.** Application-layer
   tenant filtering fails the moment you forget one query. In an accounting product, a cross-tenant leak
   is fatal to the company.
6. **Idempotency keys on every FBR call.** The network will fail mid-submission and you must never
   double-submit an invoice.

---

## How to vibecode this without shipping a broken ledger

This is the real risk, and it's worth being blunt: **AI-assisted development is strong at breadth and
weak at invariants.** It will produce a plausible commission calculation that is subtly wrong in the
edge case where a sale is returned after the commission was paid. Structure the work so that weakness
is contained.

1. **Schema first, always.** Design and review the data model by hand before generating any feature code.
   The schema is the part that's expensive to change and the part AI is most likely to get structurally
   wrong. This is where your own judgement earns its keep.
2. **Build in vertical slices, one module at a time.** Finish and test landed costing before starting
   commission. Half-finished modules are where inconsistency compounds.
3. **Test the money paths, skip the rest.** You do not need 80% coverage. You need near-total coverage of:
   ledger postings, tax calculation, landed cost apportionment, commission calculation, payroll. Property-based
   tests where you can (e.g. "apportioned costs always sum to the total cost, for any input").
4. **Golden-dataset testing with your design partner.** Get 3 months of their real invoices, real GDs, real
   commission payouts. Your system must reproduce their known-correct numbers exactly. This single
   practice is worth more than any amount of unit testing, and it's the advantage your committed customer
   gives you. Use it.
5. **Hire a chartered accountant for ~10 hours.** Not to build anything — to review your chart of accounts,
   your tax logic, and your Annex-C output. A few hundred dollars here prevents a class of error you
   cannot detect yourself.
6. **Keep modules small enough to fit in a context window.** If a module can't be read in one sitting, it's
   too big to maintain solo.

---

## Realistic 15-month plan

Assumes solo, AI-assisted, working seriously but not superhumanly.

| Phase | Months | Deliverable |
|---|---|---|
| **0 — Foundations** | 1–2 | Schema design, multi-tenancy + RLS, auth, chart of accounts, double-entry ledger core, money primitives. Golden dataset collected from design partner. |
| **1 — Core trading** | 3–5 | Parties (customers/suppliers), items + HS codes, purchases, sales invoicing, inventory & stock moves, basic reports (ledgers, ageing, trial balance, P&L). |
| **2 — Compliance** | 6–8 | FBR digital invoicing (sandbox → production), tax rules engine, further tax + ATL lookup, Annex-C/A, STR-7 export. **Design partner goes live on invoicing here.** |
| **3 — Differentiators** | 9–11 | Import landed costing + GD/Annex-B. Commission engine. Credit control & recovery. |
| **4 — Payroll + polish** | 12–13 | Pakistani payroll with commission flowing into payslips. Reporting depth. Urdu support. |
| **5 — Hardening & launch** | 14–15 | Second and third customers, performance, backups/DR, onboarding flow, billing, support process. |

**The single most important milestone is month 8**, not month 15. If your design partner is not running
real invoices through it by then, the timeline is fiction and you should cut scope — not extend the date.

### What to cut first if you slip
In order: manufacturing → provincial authorities (PRA/SRB/KPRA/BRA) → Urdu UI → multi-company →
e-commerce/courier integrations → POS hardware support. Protect the ledger, FBR, landed cost, and
commission. Those four are the product.

---

## Honest risk register

| Risk | Severity | Mitigation |
|---|---|---|
| Accounting correctness bug reaches production | **Critical** | Golden dataset, ledger invariant tests, CA review |
| Scope creep from "broad SME ERP from day one" | **Critical** | Broad architecture, narrow v1. Written scope, revisited monthly. |
| FBR API downtime blocks customer sales | High | Queue + retry + idempotency + defined degraded mode agreed with a tax advisor |
| Solo founder bus factor / burnout | High | Ship narrow, get revenue early, hire from revenue |
| Competitors add commission before you launch | Medium | It's a 6+ month build for them too, and none show signs of starting. Move, don't panic. |
| Cloud-averse customers refuse SaaS | Medium | You chose SaaS-only. Accept losing that segment; revisit single-tenant deploys post-revenue. |
| Design partner churns or their needs don't generalise | High | Interview 5–10 other importer-distributors before building the commission engine |

# SahulatERP — Master Document

**Everything from the founding research session, in one place.**

| | |
|---|---|
| **Product** | SahulatERP |
| **Type** | Commercial cloud-SaaS ERP — not a personal project, FYP, or prototype |
| **Market** | Pakistan |
| **Target launch** | End of 2026 |
| **Founder** | Fazal Khan — solo, self-funded |
| **Development** | Fully AI-assisted ("vibecoded") |
| **Design partner** | An importer-distributor (China → Pakistan), committed and paying |
| **Document created** | 2026-09-22 |

---

## Index

| Part | Contents |
|---|---|
| **1** | The idea — origin story and the original brief, verbatim |
| **2** | Session record — every question asked and every answer given |
| **3** | Decisions log — what was settled, and why |
| **4** | Market research — competitors, pricing, tiers, gap analysis |
| **5** | Tax & compliance — FBR, invoicing law, returns, payroll, landed cost |
| **6** | Build vs fork — stack decision, engineering rules, 15-month plan |
| **7** | PRD v1 — scope, data model, pricing, success criteria |
| **8** | Open questions and immediate next actions |
| **9** | Sources |

**Companion files:** the same research also lives split across `research/01`–`research/04`, and the
working rules for the codebase are in `CLAUDE.md`.

---
---

# Part 1 — The Idea

## 1.1 Origin

A friend of the founder imports goods from China and sells them in Pakistan. They run a large team. They
use an existing POS/ERP system — the founder recalls the name as something like *"Fast Track"*, though
**no Pakistani product by that name could be found in research**, so the incumbent remains unidentified.
It may be a reseller brand, a custom build, or a misremembered name.

They use it almost entirely for invoicing. They have a lot of problems with it and have been unable to
find a better option.

**The specific pain:** the software cannot handle **commission-based invoicing and salaries**. When a
Regional Sales Manager closes a sale, that sale has to be recorded **manually on paper or in an Excel
file** so the commission can be worked out. What they want is to run their entire business in one place.

## 1.2 The original brief, verbatim

> so i want to make an ERP for our local pakistani shops. this is not a personal project, fyp or anything.
> this is a full fledge market level product which i want to launch by the end of year 2026.
>
> why the idea came.
>
> so one of my friend imports stuff from china and sells in pakistan, they have a big team, they are using
> a pos/ERP system of something called fast track something i dont remember the exact name but i do
> remeber that they mostly use it for invoicing purposes. but they are having a lot of issue with it and
> they are unable to find a good solution for them. i want to name it SahulatERP for now. so the main thing
> they were concerenced about was they were not able to do invoicing and salaries on commision based on
> that software like if one of thier Regional sales manager did a sale they had to record that sale
> manually on paper or excel file. they wanted something they can manage thier entire business in one
> place. i want you to research erp solutions in pakistan. check what are they offering for how much are
> they offering and what features are they providing and every little detail you can get out of them. ask
> me anything you want to ask me for it

## 1.3 What the research validated

The friend's problem is **the market's problem**.

Not one Pakistani ERP computes sales commission properly:

- **Muhasib ERP** — the best local attempt: tick "Allow commission", enter a percentage. One flat rate per
  user. No hierarchy, no slabs, no targets, no recovery linkage.
- **HysabOne** — has "sales agent analytics". That is reporting, not payout calculation.
- **Candela RMS** — the award-winning incumbent in Pakistani organised retail — has **no double-entry
  accounting** and **no multi-currency**, per user reviews. Users also report poor usability and support.
- **Salesflo** — the dedicated field-force/distribution specialist — tracks KPIs and targets but
  **does not calculate commission**.
- **QuotaPath, Performio, incentX, Everstage** — the global tools that do this properly — are all
  USD-priced, have zero Pakistan presence, and integrate with no Pakistani ERP.

**Conclusion:** every competitor's customers are keeping the same parallel Excel file. That is not a
feature gap; it is a wedge.

## 1.4 Positioning statement

> **SahulatERP is the ERP for Pakistani importers and distributors who have a sales team.**
> It does the three things their current software refuses to do: cost their imports properly, pay their
> sales force correctly, and keep them compliant with FBR without an Excel file on the side.

**The one-line wedge:** *Every competitor's customer maintains a parallel Excel sheet for sales commissions. We delete that file.*

---
---

# Part 2 — Session Record

Every question put to the founder, and the answer given.

## 2.1 Round one — strategy

### Q: Who is the beachhead customer for v1?
Options offered: importer-distributors with field sales · general retail/POS chains · broad SME ERP from
day one · FBR compliance wedge first.

**→ Answer: "Broad SME ERP from day one"**

*Advice given, and accepted:* this is the strategy that has hollowed out the local T2 vendors — Candela,
CIS, Oscar all sell "everything to everyone" and all have gated pricing and thin product because they are
spread wide. The differentiators (commission, landed cost) are vertical by nature. Agreed compromise:
**broad architecture, narrow v1** — build the platform generically, sell into importer-distributors first,
keep module design general enough that retail and manufacturing don't require a rewrite.

### Q: Build approach — ground-up, fork ERPNext, or Odoo?
**→ Answer: "Undecided — want a technical comparison first"** → delivered in Part 6.

### Q: What should I produce next?
**→ Answer: "Deeper competitor intel" + "Product spec / PRD for v1"** → delivered in Parts 4/5 and Part 7.

## 2.2 Round two — constraints

### Q: Team and money?
Options: solo self-funded · small team 2–5 · funded team 5+ · TBD.

**→ Answer: "Solo, self-funded"**

### Q: Your role and technical depth?
Options: hands-on developer · technical founder leading a team · non-technical · student/early career.

**→ Answer (custom): "it will be completely vibecoded"**

The founder directs AI to generate essentially all code rather than writing it by hand. This became the
single most decisive input into the stack recommendation.

### Q: Deployment model?
Options: cloud SaaS only · cloud-first with on-prem option · offline-first desktop · recommend for me.

**→ Answer: "Cloud SaaS only"**

*Consequence accepted:* a segment of cloud-averse Pakistani traders will refuse the product. That segment
is written off for v1; single-tenant deployments can be revisited after revenue.

### Q: Is the friend's company actually a committed design partner?
Options: committed and will pay · will help but no commitment · just the source of the idea · not discussed.

**→ Answer: "Committed — will use it and pay"**

*Consequence:* this is a significant advantage. Their real invoices, real Goods Declarations, real
commission payouts and real payslips become both the specification and the test suite.

## 2.3 Pushback given

Two points were raised rather than quietly accommodated:

1. **On breadth.** Solo + vibecoded + broad-SME-ERP + 15 months is the risky combination — not the
   vibecoding, but the breadth. Accounting correctness is unforgiving; a subtly wrong double-entry engine
   or FBR invoices rejected at scale would destroy the product's reputation in a market driven by
   word-of-mouth. Solo, the only real defence is a surface area small enough to fully understand.
   *Resolution: broad architecture, narrow v1.*

2. **On the incumbent's name.** "Fast Track" matched no Pakistani product in any search. Identifying the
   real incumbent — ideally with a screenshot of its invoice screen — is the highest-value single piece of
   intelligence still outstanding.

---
---

# Part 3 — Decisions Log

Settled during this session. Reopening any of these needs a genuinely new reason, not a default preference.

| # | Decision | Rationale |
|---|---|---|
| 1 | **Name: SahulatERP** (working) | Founder's choice |
| 2 | **Broad architecture, narrow v1** | Breadth is what hollowed out the local incumbents; solo capacity demands a small, comprehensible surface |
| 3 | **Ground-up build — not ERPNext, not Odoo** | A fork supplies only ~30–35% of the work, all commodity; the differentiators exist in no forkable base. Full reasoning in Part 6 |
| 4 | **Stack: TypeScript · Next.js · Postgres/Supabase · Drizzle · Tailwind + shadcn/ui** | Maximum LLM training coverage → generated code is right more often. Decisive under the vibecoding constraint |
| 5 | **Cloud SaaS only** | Founder's call; accepts losing cloud-averse buyers |
| 6 | **Integrate FBR via PRAL** | Government-owned licensed integrator, free of charge, removes a per-invoice cost from unit economics |
| 7 | **FBR compliance bundled free in every tier** | Competitors charge Rs 1,500–2,000/mo for something PRAL does free — no durable basis for that pricing |
| 8 | **Target price band Rs 15,000–40,000/mo** | Above the Rs 3–7k bloodbath, far below Odoo Enterprise's ~Rs 91,500/mo for 30 users. Largely unserved |
| 9 | **Commission engine gated to the top tier** | It is the reason to buy and the reason to upgrade |
| 10 | **The critical milestone is month 8, not month 15** | Design partner live on real invoices. If it slips, cut scope — don't move the date |

---
---

# Part 4 — Market Research

## 4.1 The five tiers

The Pakistani market is not one market. It splits into five tiers that barely compete with each other.

| Tier | Typical buyer | Price band | Examples |
|---|---|---|---|
| **T0 — Free / khata apps** | Single-shop kiryana, mobile shop | Rs 0 – 1,500/mo | Timeline POS (free), Udhaar Book |
| **T1 — Cheap cloud POS/accounting** | 1–3 branch retail, small trader | Rs 1,500 – 7,000/mo | Splendid Accounts, HysabOne, Muhasib ERP, Moneypex, CloudPOS, PakERP, AmalERP |
| **T2 — Local "ERP" (desktop/hybrid)** | 10–100 staff trading, distribution, manufacturing | Rs 200k – 1.5M one-time, or Rs 8k–50k/mo | Candela RMS, CIS ERP, Oscar ERP, Sidat Hyder Financials, Websol, SowaanERP, Xenon |
| **T3 — Odoo / ERPNext via partner** | Growing SME, 20–100 users | Rs 300k – 3M implementation + Rs 7k–15k/user/mo | Mantech, Pearl Solutions, CyMax, Smart Nexus, dozens more |
| **T4 — Enterprise** | Corporates, listed companies | Rs 5M – 15M+ implementation | SAP B1, Dynamics 365 BC, NetSuite, Systems Ltd |

**Adjacent but separate:** Distribution Management Systems (DMS) and field-force automation — Salesflo,
SAMS. These sell to FMCG principals and their distributors and are *not* full ERPs. This is the segment
closest to the design partner's pain.

## 4.2 Verified pricing — T1, the volume market

### Splendid Accounts (Karachi) — most transparent competitor, closest analogue
- Basic **Rs 2,000/mo** — Sales module only, POS, mobile app, 19 reports
- Standard **Rs 3,000/mo** — Sales + Inventory, 42 reports, unlimited vendors
- Premium **Rs 4,500/mo** — Complete ERP, CRM, manufacturing, multi-currency, 105 reports, FBR integration
- Additional user **Rs 1,500/user/mo** · Annual billing 25% off (Premium Rs 40,500/yr)
- **Add-ons — this is how they actually monetize:**
  - Order Booker App **Rs 1,030/mo**
  - POS Offline **Rs 515/mo**
  - Digital Invoicing (FBR) **Rs 1,500–2,000/mo**
  - Additional branch **Rs 1,500/mo**
  - SMS packs **Rs 3,000 – 107,400**
- No payroll module.

### HysabOne — "unlimited users & branches"
- Accounts from **Rs 3,499/mo** · POS from **Rs 6,563/mo** · Standard from **Rs 7,000/mo**
- Standard adds inventory, sales orders, multi-store transfers, **sales agent analytics**
- Yearly saves 12.5% · Urdu/English bilingual UI · WhatsApp e-invoicing · FBR IRIS posting
- Claims 500+ businesses

### PakERP — priced per seat bucket, not per module
- 1 user **Rs 4,700/mo** · 3 users **Rs 8,900/mo** · 5 users **Rs 10,800/mo** · 10 users **Rs 14,500/mo**
- 15% off annual · "All features included" at every tier
- Custom development **Rs 5,000/hour** · Admin training **Rs 50,000/month**

### Others
- **Muhasib ERP (Websol)** — from **Rs 1,500/mo**. Has a *commission agent* feature: tick "Allow commission", enter a number. Basic, but it exists.
- **Moneypex** — claims accounting + inventory + POS + manufacturing + **HR & payroll** + FBR digital invoicing. Pricing gated behind demo.
- **CloudPOS** — pricing gated. Strong integration story: FBR + PRA/SRB/BRA/KPRA, Shopify/WooCommerce/OpenCart, Easypaisa/JazzCash/Bank Alfalah, TCS/BlueEx/Swyft/Call Courier. 14+ verticals.
- **AmalERP** — from **Rs 2,500/mo**, built-in FBR digital invoicing.
- **CIS Core ERP** — **Rs 10,000/mo**, markets "implementation in 24 hours".

**General market rate for local cloud POS: Rs 2,000 – 6,000/month per branch.**

## 4.3 Verified pricing — T2, local ERP

- Local vendor perpetual licences **Rs 25,000 – 150,000**
- Basic custom-built POS **from Rs 800,000**
- Multi-branch POS + ERP integration **Rs 3,000,000+**
- Adding an FBR e-invoicing module to an existing system **Rs 150,000 – 400,000**
- Local "true ERP" (PACT, Sage/Peachtree adaptations, custom) **Rs 200,000 – 500,000**

**Xenon ERP's published TCO framing** — a useful benchmark for what T2/T3 buyers expect to pay:

| Segment | Setup | Ongoing |
|---|---|---|
| Small (1–2 locations) | Rs 300k – 600k | Rs 25k – 60k/mo |
| Growing SME (multi-location) | Rs 600k – 1M | Rs 60k – 120k/mo |
| Mid-size | Rs 1M – 1.5M | Rs 120k – 250k/mo |

Data migration + training ≈ 10–15% of setup cost. Claimed ROI in 8–14 months.

**Candela RMS** (Lahore, Presidential Award winner) — the incumbent in organised retail. Desktop + cloud,
scales from single outlet to hundreds of stores. POS, inventory, PO, warehouse, loyalty, promotions, CRM.
Integrated with **PRA** for restaurant invoices and with **SAP A1/B1**. Pricing quote-only; Capterra lists
a $220 flat one-time starting price. Rated 4.0/5.
**User-reported weaknesses — directly actionable:** *"Not User Friendly"*, **no double-entry accounting**,
**single currency only**, weak analytic reports, installation/configuration difficulty, poor support for
built-in bugs.

## 4.4 Verified pricing — T3 and T4

**Odoo**
- Enterprise licence **~Rs 7,000–15,000/user/month** (some partners quote Rs 20,000+)
- Implementation in Pakistan **Rs 300,000 – 1,500,000**; Mantech advertises from **Rs 500,000**
- 30-user Enterprise ≈ **Rs 91,500/mo year 1**, ~Rs 114,200/mo year 2+
- Timeline 8–14 weeks typical; 6–8 weeks for 10–15 users and 2–3 modules

**ERPNext**
- Licence **Rs 0**. Costs are hosting (Frappe Cloud from $5/mo) + implementation ($2,000–$100,000)
- Typical 10–30 user SME all-in year 1: **$10,000–$15,000**

**SowaanERP** (ERPNext-based, Pakistan) — **$300/user/year**; HR module quoted Rs 1,500–3,000/user/mo

**Enterprise**
- **SAP Business One** — $1,500–$3,500/user one-time; 20-user system Rs 5M–10M+; implementation Rs 5M–15M+
- **Dynamics 365** — $70–$210/user/mo; implementation Rs 3M–8M+
- **NetSuite** — $999/mo base + $99/user/mo
- **All three require custom development for FBR compliance.** Repeatedly cited, and a genuine opening.

## 4.5 Gap analysis

### Gap 1 — Commission & incentive management ⭐ *the core thesis*
Nobody in Pakistan does this properly. See §1.3. What's needed and missing everywhere: multi-tier
hierarchy (RSM → ASM → TSM → Order Booker), slab/tiered rates, commission on **recovery** not just
invoice, target vs achievement, product-category-specific rates, split commissions, clawback on returns
and bad debt, and the calculated commission **flowing straight into payroll**.

### Gap 2 — Import landed costing
Directly relevant to the design partner. Needed: PO in USD/CNY → LC/TT & bank charges → freight →
insurance → **GD (Goods Declaration)** → customs duty + regulatory duty + additional customs duty + sales
tax at import + advance income tax → clearing agent → inland freight → **apportioned across SKUs** →
inventory at true landed cost per unit. Landed cost typically runs **15–40% above FOB**. Without it, gross
margin reporting is fiction. International ERPs do it; Pakistani T1 SaaS largely doesn't; T2 does it
inconsistently, usually via Excel.

### Gap 3 — Payroll disconnected from sales
Dedicated HR vendors exist (PayPeople, WebHR, IceHrm, Financeora) handling EOBI, SESSI/PESSI, gratuity and
tax slabs — but they are **separate products that don't know what an RSM sold**. Moneypex claims in-suite
payroll; depth unverified. The unmet need: **base + commission + incentive + travel allowance, computed
from live sales data, on one payslip.**

### Gap 4 — Credit control & recovery
Pakistani wholesale runs on *udhaar*. Needed: party credit limits, ageing, cheque management (PDC, bounced
cheques), recovery officer assignment, and critically **commission released only once payment is
recovered**. Rarely handled well; mostly bolted-on ageing reports.

### Gap 5 — Multi-entity / multi-currency for importers
Import in USD/CNY, sell in PKR, exchange gain/loss on LC settlement. "Supports 160 currencies" is not the
same as correct FX revaluation accounting.

### Gap 6 — Urdu and offline-first UX
HysabOne is among the few advertising bilingual Urdu/English; most are English-only. Offline POS is sold
as a **paid add-on** (Splendid: Rs 515/mo) despite Pakistani power and connectivity reality.

### Gap 7 — Enterprise systems have no Pakistani tax brain
SAP/Dynamics/NetSuite all need custom development for FBR. An opening even as a bolt-on layer.

## 4.6 Market context

- SMEs are **>90% of all enterprises** in Pakistan; only **~18%** have any online presence
- Retail market CAGR forecast **8.2%** (2026–2032)
- E-commerce expected to pass **PKR 500bn (~$1.8bn)** by end-2026, growing 18–22% CAGR
- Economy remains largely **cash-based and undocumented**; ~55% of e-commerce payments still COD
- Bazaar Technologies raised **$70M** (Tiger Global, Dragoneer) to digitise Pakistani retail — capital is
  backing this thesis

**The wave to ride:** the FBR digital invoicing mandate is force-marching hundreds of thousands of
previously-undocumented businesses into needing software between now and 2027.

## 4.7 Pricing strategy implications

| Band | Reality |
|---|---|
| Under Rs 2,000/mo | Perceived as a khata app. Low willingness to pay, high churn |
| **Rs 3,000–7,000/mo** | The fought-over T1 band. Splendid, HysabOne, PakERP, Muhasib all here |
| **Rs 10,000–50,000/mo** | Thin competition, mostly quote-only vendors with weak product. **The design partner sits here and is underserved** |
| Rs 90,000+/mo | Odoo Enterprise territory — you'd have to beat a global product on features |

The add-on model (order-booker Rs 1,030/mo, extra branch Rs 1,500/mo, FBR Rs 1,500–2,000/mo) is proven
here and worth copying: land cheap, expand via modules.

**Unaddressed sweet spot: Rs 15,000–40,000/mo** for an importer/distributor with 20–60 staff and a field
sales team, where commission automation alone saves a full-time person and prevents payout disputes.

---
---

# Part 5 — Tax & Compliance

> Everything in this part is a **non-negotiable correctness requirement**, not a feature idea. An invoice
> FBR rejects, or an Annex-C that doesn't reconcile, costs the customer money and costs you the account.

## 5.1 Sales tax mechanics

### Rates
- **Standard sales tax (GST) on goods: 18%**
- Reduced / zero rates per the Schedules to the Sales Tax Act 1990, keyed off **HS code / PCT heading**
- **Further tax: 4%** — charged *on top* of standard tax when a registered seller supplies an
  **unregistered** buyer, or a buyer not on the **Active Taxpayers List (ATL)**
  - Effective total in that case: **22%**
  - This is an ATL **lookup**, not a static customer flag — a customer can drop off ATL between invoices
  - Abolition has been proposed repeatedly and **rejected by the IMF** (Jul 2025). Assume it stays; keep the rate configurable
- **Extra tax / FED** applies to specific categories
- **Sales tax withholding** — s.3(7), Eleventh Schedule. Government bodies, companies and specified
  registered persons withhold part of the tax and pay FBR directly. Rate varies by supplier status, from
  1/5th of tax down to 5% of value for unregistered suppliers

### Design implication
Tax calculation must be a **rules engine keyed on (HS code, buyer registration status, ATL status, buyer
type, province)** — not a percentage field on the product. Hardcoding 18% is the most common failure in
local software and will bite within a month.

## 5.2 Mandatory sales tax invoice fields (Section 23)

| Field | Notes |
|---|---|
| Supplier name, address, **STRN** | |
| Buyer name, address, registration number | **STRN** if registered; **CNIC** if unregistered |
| Unique sequential serial number | **Never reused, never skipped.** Gaps are audit red flags |
| Date of issue | |
| Description & quantity of goods | |
| Value excluding sales tax | |
| Sales tax amount | At applicable rate |
| Total value including sales tax | |

- Invoices may be issued in **English or Urdu**
- **Records retained 6 years**
- Retail consumer sales: a standard POS receipt suffices, no buyer registration needed
- Manufacturer/importer supplying an **unregistered distributor** must show that distributor's CNIC or NTN

**Under digital invoicing, add three more:** **IRN** (Invoice Reference Number), **FBR QR code**,
**digital signature**.

## 5.3 FBR Digital Invoicing — the mandate

- **S.R.O. 709 (22 Apr 2025)** made electronic invoicing mandatory for corporate and non-corporate
  sales-tax-registered persons
- Original deadlines: corporate **1 June 2025**, non-corporate **1 July 2025**. Repeatedly extended
- Phased rollout continued under **SRO 1852(I)/2025**; commonly cited backstop for all active sales-tax
  filers is **31 July 2026**
- By end-2025 scope was effectively **all sales-tax-registered persons**
- Scope includes service sectors: restaurants, hotels, clinics, salons, couriers, online sellers
- **Penalties:** Rs 500,000 first default → Rs 3,000,000 repeat, plus registration suspension and
  blacklisting powers (Finance Act 2026). Enforcement broadened from **January 2026**

## 5.4 FBR Digital Invoicing — the API

### Onboarding
1. Register on the FBR Digital Invoicing portal
2. Obtain **Client ID + Client Secret**
3. **OAuth 2.0** bearer tokens — **token validity 5 years**
4. Test in **Sandbox** (no tax implications), then **Production** (legally binding, real-time)

### Endpoints
- `POST /Invoice` — submit
- `POST /Invoice/Validate` — pre-submission verification
- `GET` reference endpoints — province codes, document types, item codes, units of measurement

### Payload
Seller NTN/STRN/name/address · Buyer NTN/CNIC/name/address · Line items with **HS codes** ·
Tax calculations (sales tax, FED, further tax) · QR code for verification

### Operational rules
- IRN must be obtained **before the sale completes** — a blocking synchronous call in the sale flow
- **72-hour window** to cancel/delete/edit a bona-fide mistake; after that, Commissioner IR approval
- A business may use **multiple licensed integrators** simultaneously (STGO 01 of 2026)

### ⚠ Architecture warning
A synchronous, mandatory, third-party call in the critical path of every sale is an availability risk you
do not control. You need request queuing, idempotency keys, retry with backoff, a clearly-defined degraded
mode, and per-tenant visibility into what is unsubmitted. **Decide the degraded-mode policy with a tax
advisor, not alone.**

### Reference docs to obtain
FBR Technical API Documentation PDF **v1.12** · Digital Invoicing User Manual **v1.4** ·
Chapter XIV, Sales Tax Rules 2006 (licensed integrator framework)

## 5.5 The licensed integrators

| # | Licence No. | Entity |
|---|---|---|
| 1 | 398586644 | Haball (Pvt) Ltd |
| 2 | 394537651 | WebDNAWorks (Pvt) Ltd |
| 3 | 649954048 | EY Ford Rhodes |
| 4 | — | **PRAL** (government-owned) |
| 5 | 715193372 | OpenPort Pakistan (Pvt) Ltd |
| 6 | 620903892 | TMR Consulting (Pvt) Ltd |
| 7 | 555378169 | NatureTech (Pvt) Ltd |
| 8 | 90332116 | Dynamic Resources (Pvt) Ltd |

### Economics
- FBR charges **nothing**
- **PRAL integrates free of cost** — this kills "integration fee" as a business model
- Private integrator fees are **capped by FBR** via STGO
- Real market cost today: software/POS setup Rs 15,000–40,000 one-time, digital certificate/device
  Rs 5,000–10,000, annual maintenance Rs 10,000–20,000. **First-year total Rs 15,000–60,000** for an SME
- Competitors charge Rs 1,500–2,000/mo as an FBR add-on

**Strategic read:** licensing (Chapter XIV) is a real moat, but PRAL's free service means you should
**integrate through PRAL and make compliance a feature, not a product**. Selling "FBR compliance" alone is
a commodity by 2027. Selling *"you're compliant AND you finally know what your sales team earned"* is not.

## 5.6 Sales tax returns — the ERP must generate these

This is where you beat the cheap competition. Most T1 SaaS produces invoices and leaves the accountant to
rebuild the return in Excel.

### Monthly cycle
| Date | Action |
|---|---|
| **10th** | Upload **Annex-C** (sales) and **Annex-A** (purchases) |
| **15th** | Generate **PSID** payment slip, pay via banking channel |
| **18th** | Submit **STR-7** via IRIS |

**NIL returns are mandatory** even with zero activity — same penalties for omission.

### STR-7 (main return)
`Net Payable = Output Tax − Allowed Input Tax`
**Section 8B cap: input tax claimed cannot exceed 90% of output tax.** Excess carries forward. The engine
must implement the cap **and** the carry-forward ledger.

### Annex-C — Sales / Output tax
Per invoice line: buyer STRN or CNIC · invoice number, date (**DD-MM-YYYY strictly**) · HS/PCT code ·
quantity, UoM, description · taxable value excl. tax · sales tax at applicable rate · further tax (4%)
where unregistered · extra tax / FED where applicable.

> **Critical:** if the supplier files Annex-C late, **their buyers cannot claim input tax**. That is a
> business-relationship consequence, not just a compliance one — surface it loudly in the UI.

### Annex-A — Purchases / Input tax
**Auto-populates from suppliers' Annex-C submissions.** Per invoice: number, date, supplier STRN, value,
claimed tax. User must **accept / reject / mark not-claimed** per invoice. **6-month claim window.**

> ⚠ Manually entering an invoice absent from the supplier's filing triggers FBR cross-matching flags,
> automatic reversal and penalties. The UI must actively discourage it.

### Annex-B — Imports ⭐
Auto-populated from **Customs WeBOC / PSW** via **GD number**. GD number + date, commodity description,
HS code, import value, sales tax collected at import, claim status.
**This is the bridge between import landed costing and the tax module — same GD, two purposes.**

### Annex-I — Debit/Credit notes
Must reference the original invoice number and date **exactly**. Note type, adjusted amount, tax impact.
FBR matches these; mismatches trigger queries. **Referential integrity is mandatory in the data model.**

### Annex-F — Stock statement
Opening stock, purchases, sales, closing stock, reconciliation. Required for manufacturers.

### Annex-H — Refund claims
Exporters / zero-rated. Export invoices, shipping bills, GD numbers, refund calculation.

### Data format rules (CSV upload standard)
**No commas in numeric fields** · mandatory-field checks before upload · **DD-MM-YYYY** enforced ·
HS/PCT code validated against Schedule items for rate determination.

### Penalties
Late payment: default surcharge at **KIBOR + 3% annually**. Wrong input tax claim: recovery + 3% penalty
or **Rs 25,000 minimum**.

## 5.7 Provincial sales tax on services

Separate authorities, registrations, rates and filings: **PRA** (Punjab), **SRB** (Sindh),
**KPRA** (Khyber Pakhtunkhwa), **BRA** (Balochistan).

Candela integrates with PRA for restaurant invoices; CloudPOS claims all four. **Treat as post-v1** unless
the design partner needs one — each is real integration work.

## 5.8 Payroll compliance

| Item | Rule |
|---|---|
| **EOBI** | 5% employer / 1% employee, on minimum wage basis |
| **SESSI / PESSI** | Provincial social security — Sindh / Punjab variants, different rules |
| **Provident fund** | Employer + employee contributions |
| **Gratuity** | Based on tenure and last drawn salary |
| **Income tax withholding** | Income Tax Ordinance 2001 slabs — **change annually with the Finance Act** |
| **Minimum wage** | Changes annually, varies by province |

**Design implication:** tax slabs, EOBI rates and minimum wage are **effective-dated configuration**, never
constants in code. You will re-run historical payrolls; a June 2026 payslip must be reproducible in 2029
using June 2026's rules. Retrofitting effective-dating is agony.

## 5.9 Import landed costing — cost components

For the China-import use case:

- **Pre-shipment:** FOB value (USD/CNY), LC opening charges, LC margin, bank commission, TT charges
- **Transit:** ocean/air freight, insurance, THC
- **Customs (per GD):** customs duty, **Regulatory Duty (RD)**, **Additional Customs Duty (ACD)**, sales
  tax at import, **advance income tax**, FED where applicable
- **Port & clearing:** port charges, EDI, CWC, PQFS, wharfage, demurrage/detention, clearing agent fee
- **Inland:** inland freight, handling, warehouse-in

**Apportionment:** each cost must be allocatable across SKUs by **value, weight, volume, or quantity** —
the correct basis differs per cost type (freight by volume/weight, duty by value). This is a **per-cost-line
choice, not a global setting**.

**Output:** inventory posted at **true landed cost per unit**. Landed cost typically runs **15–40% above FOB**.

**FX:** purchase in USD/CNY, settle the LC later at a different rate → **exchange gain/loss must post to
P&L**. "Supports 160 currencies" is not the same as correct FX revaluation.

---
---

# Part 6 — Build vs Fork

**Constraints:** solo · self-funded · fully AI-assisted development · cloud SaaS only · ~15 months · one committed paying design partner

## 6.1 Recommendation

**Build ground-up on a mainstream TypeScript + Postgres stack. Do not fork ERPNext or Odoo.**

This is the opposite of the advice for a funded team of five, and it is driven almost entirely by the
"solo + AI-assisted" constraint.

## 6.2 The decisive argument

The instinct is "fork ERPNext, get accounting and inventory free, build only the Pakistan bits." That
instinct is wrong here for one reason:

**The modules you'd inherit free are the commodity ones. The modules that make SahulatERP worth buying do
not exist in any base you could fork.**

| Area | In ERPNext? | Must build regardless |
|---|---|---|
| Double-entry ledger, COA | ✅ | |
| Basic inventory & stock moves | ✅ | |
| Invoicing skeleton | ✅ | |
| **FBR digital invoicing (IRN, QR, OAuth, queue, 72h window)** | ❌ | ✅ |
| **Annex-A/B/C/I + STR-7, 8B cap, ATL lookup, further tax** | ❌ | ✅ |
| **Import landed costing (GD, RD/ACD, multi-basis apportionment, FX)** | ❌ weak | ✅ |
| **Commission engine (hierarchy, slabs, targets, recovery-linked, clawback)** | ❌ | ✅ |
| **Pakistani payroll (EOBI, SESSI/PESSI, gratuity, effective-dated slabs)** | ❌ | ✅ |
| **Credit control / udhaar / PDC cheques** | ❌ weak | ✅ |

You inherit maybe **30–35%** of the work, and pay for it with a permanent comprehension tax on the other 65%.

## 6.3 Why forking is specifically bad for AI-assisted solo development

1. **Frappe is a niche framework.** Models write Next.js, React, Postgres and plain Python far more
   reliably than Frappe DocTypes, `hooks.py` wiring, or bench site management. You'd spend a large
   fraction of your time correcting confidently-wrong framework code — the worst failure mode when solo.
2. **You cannot reason about code you didn't write, at that size, alone.** A wrong stock valuation is an
   afternoon in your own 30k-line codebase and a week in ERPNext, with AI assistance degrading the further
   you get from what fits in context.
3. **Upgrades punish customisation.** Deep customisations break upstream. Solo, you'd eventually stop
   upgrading — leaving a stale fork of someone else's ERP with none of the community benefit.
4. **Multi-tenant SaaS on Frappe means bench multi-site** — separate sites, separate databases, heavier
   ops. A single multi-tenant Postgres app with RLS is dramatically less work for one person.
5. **You inherit a UX you can't differentiate on.** Candela's top complaint is literally *"Not User
   Friendly."* ERPNext's interface is functional and dated. Forking throws away one of your few
   sustainable advantages.

**Odoo rejected outright:** Enterprise licensing eats margin, you'd be the 31st Odoo partner in Pakistan,
and you'd be a services business rather than a product company.

## 6.4 Recommended stack

Chosen above all for **maximum AI training coverage**, so generated code is right more often.

| Layer | Choice | Why |
|---|---|---|
| Language | **TypeScript, end to end** | Types catch a class of bugs a solo dev with no QA will otherwise ship |
| Framework | **Next.js (App Router)** | Huge training representation; server actions remove an API layer |
| Database | **PostgreSQL** | Correct decimal arithmetic, real constraints, mature |
| Platform | **Supabase** | Postgres + auth + storage + **native RLS**, your multi-tenancy primitive |
| ORM | **Drizzle** | SQL-shaped, predictable, easy to audit generated queries |
| UI | **Tailwind + shadcn/ui** | Best-represented component idiom; beats every local incumbent on first impression |
| Jobs | **Postgres-backed queue** (pgmq / Graphile Worker) | FBR retries, payroll runs, commission recalcs. No Redis until needed |

## 6.5 Non-negotiable engineering rules

1. **Money is never a float.** Integer minor units (paisa) or Postgres `NUMERIC`. Enforce in the schema.
2. **The ledger is append-only.** Journal entries immutable; corrections are reversing entries, never edits.
3. **A constraint or test asserts `sum(debits) == sum(credits)` on every journal entry.** If you write one
   test in the whole product, write this one.
4. **Every rate is effective-dated configuration** — tax slabs, EOBI, minimum wage, commission rates.
5. **`tenant_id` on every table, enforced by RLS policy, not application code.** In an accounting product
   a cross-tenant leak is fatal to the company.
6. **Idempotency keys on every FBR call.** The network will fail mid-submission; never double-submit.

## 6.6 How to vibecode this without shipping a broken ledger

**AI-assisted development is strong at breadth and weak at invariants.** It will produce a plausible
commission calculation that is subtly wrong when a sale is returned after commission was paid. Structure
the work so that weakness is contained.

1. **Schema first, always.** Design and review the data model by hand before generating feature code. The
   schema is expensive to change and the part AI gets structurally wrong most often. **This is where your
   own judgement earns its keep.**
2. **Vertical slices, one module at a time.** Finish landed costing before starting commission.
3. **Test the money paths, skip the rest.** Not 80% coverage — near-total coverage of ledger postings, tax
   calculation, landed cost apportionment, commission, payroll. Property-based tests where possible
   ("apportioned costs always sum to the total, for any input").
4. **Golden-dataset testing with the design partner.** Three months of their real invoices, GDs, and
   commission payouts. Your system must reproduce their known-correct numbers exactly. **Worth more than
   any amount of unit testing, and it's what the committed customer buys you. Use it.**
5. **Hire a chartered accountant for ~10 hours.** Not to build — to review the chart of accounts, tax logic
   and Annex-C output. A few hundred dollars prevents a class of error you cannot detect yourself.
6. **Keep modules small enough to fit in a context window.**

## 6.7 Realistic 15-month plan

| Phase | Months | Deliverable |
|---|---|---|
| **0 — Foundations** | 1–2 | Schema design, multi-tenancy + RLS, auth, chart of accounts, double-entry core, money primitives. Golden dataset collected |
| **1 — Core trading** | 3–5 | Parties, items + HS codes, purchases, sales invoicing, inventory & stock moves, basic reports |
| **2 — Compliance** | 6–8 | FBR digital invoicing (sandbox → production), tax rules engine, further tax + ATL, Annex-C/A, STR-7. **Design partner goes live on invoicing** |
| **3 — Differentiators** | 9–11 | Import landed costing + GD/Annex-B. Commission engine. Credit control & recovery |
| **4 — Payroll + polish** | 12–13 | Pakistani payroll with commission on payslips. Reporting depth. Urdu |
| **5 — Hardening & launch** | 14–15 | Customers 2 and 3, performance, backups/DR, onboarding, billing, support |

**The critical milestone is month 8, not month 15.** If the design partner isn't running real invoices by
then, the timeline is fiction — cut scope, don't extend the date.

**Cut order if you slip:** manufacturing → provincial authorities → Urdu UI → multi-company →
e-commerce/courier integrations → POS hardware. **Protect the ledger, FBR, landed cost, and commission.
Those four are the product.**

## 6.8 Risk register

| Risk | Severity | Mitigation |
|---|---|---|
| Accounting correctness bug reaches production | **Critical** | Golden dataset, ledger invariant tests, CA review |
| Scope creep from "broad SME ERP from day one" | **Critical** | Broad architecture, narrow v1. Written scope, revisited monthly |
| FBR API downtime blocks customer sales | High | Queue + retry + idempotency + defined degraded mode agreed with a tax advisor |
| Solo founder bus factor / burnout | High | Ship narrow, get revenue early, hire from revenue |
| Competitors add commission before launch | Medium | It's a 6+ month build for them too, and none show signs of starting |
| Cloud-averse customers refuse SaaS | Medium | Accept losing that segment; revisit single-tenant post-revenue |
| Design partner churns or needs don't generalise | High | Interview 5–10 other importer-distributors before building the engine |

---
---

# Part 7 — PRD v1

## 7.1 Competitive frame

| Competitor | Their price | Why we win |
|---|---|---|
| Splendid Accounts | Rs 2,000–4,500/mo + add-ons | No commission engine, no landed costing, no payroll |
| HysabOne | Rs 3,499–7,000/mo | Sales *analytics* only — doesn't compute or pay commission |
| Muhasib ERP | from Rs 1,500/mo | Commission = one flat % per user. No hierarchy, targets, or recovery linkage |
| Candela RMS | quote-only | **No double-entry accounting. No multi-currency.** Poor UX and support |
| Salesflo | quote-only | Field-force KPIs and targets, but **does not calculate commission**. Not an ERP |
| Odoo partners | Rs 300k–3M + Rs 7–15k/user/mo | Cost, 8–14 week implementations, no native FBR or landed costing |
| SAP / D365 / NetSuite | Rs 3M–15M+ | FBR compliance requires custom development in all three |

## 7.2 Who v1 is not for

Single-shop kiryana (khata apps serve them), restaurants (different product), manufacturers with complex
BOM/routing (v3), enterprises already on SAP.

## 7.3 v1 module scope — IN

**M1. Foundations** — Multi-tenant (RLS), users, roles & permissions, audit log, company/branch setup,
fiscal years & period locking, effective-dated configuration framework.

**M2. Accounting core** — Chart of accounts (Pakistani default template), double-entry ledger
(append-only), journal vouchers, multi-currency with FX revaluation and realised/unrealised gain-loss,
bank & cash accounts, trial balance, P&L, balance sheet, general & party ledgers.

**M3. Parties & items** — Customers, suppliers, sales staff. STRN/NTN/CNIC capture, **ATL status lookup
and caching**. Items with HS/PCT codes, UoM, categories, price lists, batch/expiry.

**M4. Purchasing & imports** ⭐ — Purchase orders (foreign currency), goods receipt, supplier bills.
**Import landed costing:** shipment record → LC/TT & bank charges, freight, insurance, GD (customs duty,
RD, ACD, sales tax at import, advance income tax), port/EDI/CWC/PQFS, clearing agent, inland freight →
**apportionment across SKUs by value / weight / volume / quantity, selectable per cost line** → inventory
posted at true landed cost per unit. GD data feeds **Annex-B**.

**M5. Sales & inventory** — Quotations, sales orders, delivery notes, sales invoices, returns/credit notes.
Multi-warehouse stock, transfers, adjustments with history, stock valuation, reorder alerts. Gross profit
per invoice/SKU/customer **computed on landed cost**.

**M6. FBR digital invoicing** ⭐ — OAuth 2.0 client, sandbox + production, synchronous IRN acquisition
before sale completion, QR code, digital signature, queue + retry + idempotency, defined degraded mode,
72-hour correction window handling, per-tenant submission dashboard. Integrate via **PRAL** (free).

**M7. Tax engine & returns** ⭐ — Rules engine keyed on (HS code, buyer registration status, ATL status,
buyer type, province). Standard 18%, reduced/zero rates, **further tax 4%**, extra tax/FED, sales tax
withholding (s.3(7)). Generates **Annex-C, Annex-A, Annex-B, Annex-I** and **STR-7** with the
**Section 8B 90% input cap** and carry-forward ledger. CSV output conforming to FBR format rules.

**M8. Commission & incentives** ⭐⭐ — *the differentiator*
- Sales hierarchy: **Regional Sales Manager → Area Sales Manager → Territory Sales Officer → Order Booker**
- Commission plans: flat %, tiered slabs, per-product-category rates, per-customer-class rates, fixed amount per unit
- Assignment by territory, customer, product line, or explicit deal
- **Split commissions** across multiple staff on one sale
- Targets vs achievement (monthly/quarterly), with achievement-gated rates
- **Recovery-linked release** — commission accrues on invoice, releases on payment received
- **Clawback** on returns, credit notes, bad debt write-offs
- Full audit trail: for any payout, show every contributing invoice
- Statement per salesperson, approval workflow, export to payroll

**M9. Credit control & recovery** — Party credit limits enforced at invoice entry, ageing (30/60/90/120+),
**PDC cheque register** (received/deposited/cleared/bounced), recovery officer assignment, follow-up log,
customer statements.

**M10. Payroll** ⭐ — Employees, attendance, salary structures. **EOBI (5%/1%), SESSI/PESSI, provident
fund, gratuity, income tax withholding on effective-dated slabs.** Allowances and deductions.
**Commission and incentive flow in from M8 onto a single payslip.** Payslip generation, salary register,
statutory reports.

**M11. Reporting & dashboards** — Owner dashboard (cash, receivables, top customers, margin), sales
dashboard (by rep, territory, product, target vs actual), inventory ageing & dead stock, import shipment
profitability, commission liability.

## 7.4 v1 module scope — OUT (deliberately deferred)

| Deferred | To | Why |
|---|---|---|
| Manufacturing (BOM, routing, WIP) | v3 | Different buyer, large surface area |
| Provincial authorities (PRA/SRB/KPRA/BRA) | v2 | Separate integration each; only needed for services |
| Retail POS (hardware, barcode, cashier shifts, loyalty) | v2 | Different segment; opens the Rs 3–7k bloodbath |
| Urdu UI | v2 | Valuable, not blocking for the target segment |
| E-commerce & courier integrations | v2 | Nice-to-have for this buyer |
| Mobile order-booker app | **v1.5 — first thing after launch** | High value; needs offline sync done properly |
| Multi-company consolidation | v2 | |
| Fixed assets & depreciation | v2 | |
| Licensed-integrator status | v3 | PRAL is free; revisit at scale |

## 7.5 Data model — core entities

*Sketch only. Do the real design by hand before generating code.*

```
tenants
  users, roles, permissions, audit_log
  companies → branches → warehouses
  fiscal_years → periods (with lock status)
  config_values (key, value, effective_from, effective_to)   ← all rates live here

accounts (chart of accounts, hierarchical)
journal_entries (immutable, append-only)
  journal_lines (account_id, debit, credit, currency, fx_rate, base_amount)
     CONSTRAINT: sum(debit) == sum(credit) per entry

parties (customer | supplier | both)
  party_tax_info (strn, ntn, cnic, atl_status, atl_checked_at)
items → item_tax_info (hs_code, pct_heading, tax_category)
price_lists, price_list_items

purchase_orders → goods_receipts → supplier_bills
shipments                                  ← import header
  shipment_costs (type, amount, currency, apportion_basis)
  goods_declarations (gd_number, gd_date, duty, rd, acd, sales_tax, ait)
  landed_cost_allocations (shipment_id, item_id, cost_type, allocated_amount)

sales_orders → delivery_notes → sales_invoices → invoice_lines
credit_notes, debit_notes (→ reference original invoice exactly)
payments, payment_allocations
cheques (PDC register: received/deposited/cleared/bounced)

stock_moves (immutable), stock_balances, stock_valuation_layers

fbr_submissions (invoice_id, irn, qr_payload, status, attempts,
                 idempotency_key, request, response, submitted_at)

tax_rules (hs_code_pattern, buyer_type, registration_status,
           province, rate, further_tax_rate, effective_from)

sales_hierarchy (employee_id, parent_id, role, territory_id)
commission_plans → commission_plan_rules (slabs, categories, rates)
commission_assignments (plan_id, scope_type, scope_id)
commission_accruals (invoice_line_id, employee_id, amount, status)
     status: accrued → released → paid → clawed_back
commission_payouts → payout_lines

employees, attendance, salary_structures
payroll_runs → payslips → payslip_lines
     (earnings incl. commission from commission_payouts; deductions incl. EOBI/tax)
```

**Key relationships to get right:**
- `commission_accruals` links to the **invoice line**, not the invoice — rates vary by product category
- Accrual status transitions are driven by **payment allocation** (release) and **credit notes**
  (clawback). Model as an explicit state machine
- `landed_cost_allocations` must always sum to the total shipment cost. Assert it
- `config_values` effective-dating is what lets you re-run historical payroll correctly

## 7.6 Pricing

| Tier | Price | Includes |
|---|---|---|
| **Core** | **Rs 12,000/mo** | Accounting, parties, items, sales, purchasing, inventory, FBR digital invoicing, tax returns. 5 users |
| **Trade** | **Rs 22,000/mo** | Core + import landed costing + credit control & recovery. 10 users |
| **Complete** | **Rs 35,000/mo** | Trade + commission engine + payroll. 20 users |
| Extra user | Rs 1,200/user/mo | |
| Extra branch | Rs 2,500/mo | |
| Implementation & migration | Rs 75,000–250,000 one-time | Scaled by data volume |

**Deliberate choices:**
- **FBR compliance is included in every tier, never an add-on.** Competitors charge Rs 1,500–2,000/mo;
  PRAL provides it free. Making it free is a sharp, honest differentiator and removes a churn reason
- Commission engine sits in the **top tier** — the reason to buy and the reason to upgrade
- Annual billing at ~15–20% discount (market norm)

## 7.7 Success criteria

**v1 is successful if, by launch:**
1. The design partner has run **3 consecutive months** of real operations — invoicing, imports, commission,
   payroll — with **no parallel Excel file**
2. Sales commission is calculated entirely by the system and **agreed by the sales team without dispute**
3. **Zero FBR invoice rejections** in the final month
4. Their accountant files STR-7 from our output **without manual rework**
5. **At least 2 more paying customers** acquired without a founder-led custom build

> **Criterion 2 is the real one.** If the RSMs trust the number, you have a product. If they don't, you
> have software.

---
---

# Part 8 — Open Questions & Next Actions

## 8.1 Immediate next actions

| # | Action | Why it's first |
|---|---|---|
| 1 | Get the design partner to formalise: written commitment, pricing, data access | Everything below depends on it |
| 2 | **Collect the golden dataset** — 3 months of real invoices, GDs, commission payouts, payslips | This is your spec *and* your test suite |
| 3 | Document their **exact** commission rules, including every exception and argument | The engine must handle reality, not a clean model |
| 4 | Identify the incumbent software by its real name; get screenshots | Know precisely what you're displacing |
| 5 | Download FBR API doc v1.12 + user manual v1.4; register for sandbox | Longest technical lead time; start early |
| 6 | Interview 5–10 other importer-distributors | Confirms the commission pain generalises before you build for it |
| 7 | Design the schema by hand, reviewed against the golden dataset | The one thing not to delegate to AI |
| 8 | Engage a chartered accountant for ~10 hours of review | Cheap insurance against an undetectable class of error |
| 9 | `git init` and commit | No version control exists yet |

## 8.2 Questions outstanding for the founder

These shape the commission engine, which is the whole product.

1. **What does the design partner pay for their current system today?** Anchors pricing better than all the
   market research above.
2. **Is commission paid on invoice, or on recovery?** Highest-variance requirement in the build. Pakistani
   wholesale runs on *udhaar*, so recovery-linked with clawback has been assumed — needs confirming.
3. **How many sales staff, and how many tiers in the hierarchy?** Determines commission engine complexity.
4. **Roughly how many invoices per month?** Sets the FBR submission throughput bar.
5. **Are they already under the digital invoicing mandate?** If yes, that deadline is the sales lever — for
   them and for everyone pitched next.
6. **Do they need multi-company (separate legal entities), or one company with branches?**
7. **The incumbent's real name.** "Fast Track" matched nothing in Pakistan. A screenshot of its invoice
   screen would be worth more than another day of searching.

## 8.3 Further research not yet done

- [ ] Actual quotes from Candela, CIS, Oscar, Xenon (pricing gated — needs a demo call)
- [ ] Verify Moneypex payroll depth (only local SaaS claiming HR + payroll in-suite)
- [ ] Salesflo's pricing and contract model — closest thing to a commission/field-force incumbent
- [ ] FBR Digital Invoicing technical docs + Chapter XIV, Sales Tax Rules 2006, in full
- [ ] Map provincial revenue authorities (PRA, SRB, KPRA, BRA) — separate integrations and rates

---
---

# Part 9 — Sources

## Competitors & pricing
- https://splendidaccounts.pk/pricing-plan/
- https://hysabone.com/pricing/
- https://pakerp.com/pricing/
- https://cloudpos.pk/
- https://moneypex.com/pk
- https://www.candelarms.com/
- https://www.capterra.com/p/97672/Candela-RMS/
- https://www.salesflo.com/
- https://www.salesflo.com/salesflo-core/
- https://www.websol.com.pk/products/websol-muhasib-erp/
- https://amalerp.com/blog/best-erp-software-in-pakistan
- https://www.mantechit.com/blog/best-erp-software-in-pakistan/
- https://www.ictsystems.com.pk/best-erp-software-in-pakistan-2026/
- https://atxenon.com/erp-software-cost-in-pakistan/
- https://timelinedigi.com/blog/pos-software-price-in-pakistan
- https://www.smart-nexus.com/blog/erpnext-vs-odoo-pakistan
- https://www.softwaresuggest.com/erp-software/pakistan

## FBR & tax compliance
- https://www.fbr.gov.pk/list-of-license-interprator/173967/173971
- https://fbr.gov.pk/faqs/173967/173969
- https://fbr.gov.pk/di-technical-assistance/173967/173970
- https://download1.fbr.gov.pk/Docs/2026331133557466STGO01of2026.pdf
- https://profit.pakistantoday.com.pk/2026/04/01/fbr-allows-multiple-integrators-for-e-invoicing-integration/
- https://www.switchertechno.com/fbr-digital-invoicing-guide-pakistan
- https://www.switchertechno.com/fbr-digital-invoicing-cost-pakistan/
- https://app.digitalinvoices.pk/blog/fbr-digital-invoicing-api-complete-guide-2026
- https://amalerp.com/blog/sales-tax-invoice-requirements-pakistan
- https://paktaxcalc.com/blog/sales-tax-return-filing-pakistan.html
- https://waystax.com/sales-tax-rate-in-pakistan/
- https://taxflow.com.pk/blog/further-tax-pakistan-explained
- https://taxsummaries.pwc.com/pakistan/corporate/withholding-taxes
- https://profit.pakistantoday.com.pk/2025/07/25/imf-rejects-pakistans-proposal-to-abolish-4-sales-tax-on-unregistered-persons-asks-to-expand-tax-base/

## Payroll
- https://web.hr/get/payroll-software-in-pakistan
- https://www.paypeople.pk/blog/payroll-software-in-pakistan-best-2026-hrms-paypeople-johar-cc73563/
- https://hrbsglobal.com/countries/pakistan/payroll/

## Market context
- https://www.6wresearch.com/industry-report/pakistan-retail-industry-market-outlook
- https://www.grand-review.com/article/pakistan-smes-bridging-the-digital-divide-for-export-growth-in-2026-mnp1uzdz
- https://techcrunch.com/?p=2284452

---

*Compiled 2026-09-22. Pricing and regulatory deadlines change — re-verify anything load-bearing before acting on it.*

# SahulatERP — Product Requirements, v1
**Date:** 2026-09-22 · **Target launch:** end-2026 · **Status:** Draft for review

---

## 1. Positioning

> **SahulatERP is the ERP for Pakistani importers and distributors who have a sales team.**
> It does the three things their current software refuses to do: cost their imports properly,
> pay their sales force correctly, and keep them compliant with FBR without an Excel file on the side.

**Long-term:** a broad SME ERP for Pakistan.
**v1:** a narrow, excellent product for one segment — built on architecture that generalises.

### The one-line wedge
Every competitor's customer maintains a parallel Excel sheet for sales commissions. We delete that file.

### Who we are not for (v1)
Single-shop kiryana (khata apps serve them), restaurants (different product), manufacturers with
complex BOM/routing (v3), enterprises already on SAP.

---

## 2. Competitive frame

| Competitor | Their price | Why we win |
|---|---|---|
| Splendid Accounts | Rs 2,000–4,500/mo + add-ons | No commission engine, no landed costing, no payroll |
| HysabOne | Rs 3,499–7,000/mo | Sales *analytics* only — doesn't compute or pay commission |
| Muhasib ERP | from Rs 1,500/mo | Commission = one flat % per user. No hierarchy, targets, or recovery linkage |
| Candela RMS | quote-only | **No double-entry accounting. No multi-currency.** Users report poor UX and support |
| Salesflo | quote-only | Field-force KPIs and targets, but **does not calculate commission**. Not an ERP |
| Odoo partners | Rs 300k–3M setup + Rs 7–15k/user/mo | Cost, 8–14 week implementations, no native FBR or landed costing |
| SAP / D365 / NetSuite | Rs 3M–15M+ | FBR compliance requires custom development in all three |

**Target price band: Rs 15,000–40,000/month.** Above the Rs 3–7k bloodbath, far below Odoo Enterprise's
~Rs 91,500/mo for 30 users. Currently almost unserved.

---

## 3. v1 module scope

### ✅ IN — v1

**M1. Foundations**
Multi-tenant (RLS), users, roles & permissions, audit log, company/branch setup, fiscal years & period
locking, effective-dated configuration framework.

**M2. Accounting core**
Chart of accounts (Pakistani default template), double-entry ledger (append-only), journal vouchers,
multi-currency with FX revaluation and realised/unrealised gain-loss, bank & cash accounts, trial balance,
P&L, balance sheet, general & party ledgers.

**M3. Parties & items**
Customers, suppliers, sales staff. STRN/NTN/CNIC capture, **ATL status lookup and caching**. Items with
HS/PCT codes, units of measure, categories, price lists, batch/expiry.

**M4. Purchasing & imports** ⭐
Purchase orders (foreign currency), goods receipt, supplier bills.
**Import landed costing:** shipment record → LC/TT & bank charges, freight, insurance, GD (customs duty,
RD, ACD, sales tax at import, advance income tax), port/EDI/CWC/PQFS, clearing agent, inland freight →
**apportionment across SKUs by value / weight / volume / quantity, selectable per cost line** →
inventory posted at true landed cost per unit. GD data feeds **Annex-B**.

**M5. Sales & inventory**
Quotations, sales orders, delivery notes, sales invoices, returns/credit notes. Multi-warehouse stock,
transfers, adjustments with history, stock valuation, reorder alerts. Gross profit per invoice/SKU/customer
**computed on landed cost**.

**M6. FBR digital invoicing** ⭐
OAuth 2.0 client, sandbox + production, synchronous IRN acquisition before sale completion, QR code,
digital signature, queue + retry + idempotency, defined degraded mode, 72-hour correction window handling,
per-tenant submission dashboard. Integrate via **PRAL** (free).

**M7. Tax engine & returns** ⭐
Rules engine keyed on (HS code, buyer registration status, ATL status, buyer type, province).
Standard 18%, reduced/zero rates, **further tax 4%** for unregistered/non-ATL buyers, extra tax/FED,
sales tax withholding (s.3(7)). Generates **Annex-C, Annex-A, Annex-B, Annex-I** and **STR-7** with the
**Section 8B 90% input cap** and carry-forward ledger. CSV output conforming to FBR format rules
(no commas in numerics, DD-MM-YYYY).

**M8. Commission & incentives** ⭐⭐ — *the differentiator*
- Sales hierarchy: Regional Sales Manager → Area Sales Manager → Territory Sales Officer → Order Booker
- Commission plans: flat %, tiered slabs, per-product-category rates, per-customer-class rates, fixed amount per unit
- Assignment by territory, customer, product line, or explicit deal
- **Split commissions** across multiple staff on one sale
- Targets vs achievement (monthly/quarterly), with achievement-gated rates
- **Recovery-linked release** — commission accrues on invoice, releases on payment received
- **Clawback** on returns, credit notes, and bad debt write-offs
- Full audit trail: for any payout, show every contributing invoice
- Statement per salesperson, approval workflow, export to payroll

**M9. Credit control & recovery**
Party credit limits with enforcement at invoice entry, ageing (30/60/90/120+), **PDC cheque register**
(received/deposited/cleared/bounced), recovery officer assignment, follow-up log, customer statements.

**M10. Payroll** ⭐
Employees, attendance, salary structures. **EOBI (5%/1%), SESSI/PESSI, provident fund, gratuity, income
tax withholding on effective-dated slabs.** Allowances and deductions. **Commission and incentive flow in
from M8 onto a single payslip.** Payslip generation, salary register, statutory reports.

**M11. Reporting & dashboards**
Owner dashboard (cash, receivables, top customers, margin), sales dashboard (by rep, territory, product,
target vs actual), inventory ageing & dead stock, import shipment profitability, commission liability.

---

### ⏳ OUT of v1 — deliberately deferred

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

---

## 4. Data model — core entities

Sketch only. Do the real design by hand before generating code.

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
- `commission_accruals` must link to the **invoice line**, not the invoice — commission rates vary by product category.
- Accrual status transitions are driven by **payment allocation** (release) and **credit notes** (clawback). Model this as an explicit state machine.
- `landed_cost_allocations` must always sum to the total shipment cost. Assert it.
- `config_values` effective-dating is what lets you re-run historical payroll correctly.

---

## 5. Pricing (proposed)

Following the proven local pattern: land on a base tier, expand through modules.

| Tier | Price | Includes |
|---|---|---|
| **Core** | **Rs 12,000/mo** | Accounting, parties, items, sales, purchasing, inventory, FBR digital invoicing, tax returns. 5 users. |
| **Trade** | **Rs 22,000/mo** | Core + import landed costing + credit control & recovery. 10 users. |
| **Complete** | **Rs 35,000/mo** | Trade + commission engine + payroll. 20 users. |
| Extra user | Rs 1,200/user/mo | |
| Extra branch | Rs 2,500/mo | |
| Implementation & migration | Rs 75,000–250,000 one-time | Scaled by data volume |

**Deliberate choices:**
- **FBR compliance is included in every tier, never an add-on.** Competitors charge Rs 1,500–2,000/mo for
  it; PRAL provides it free. Making it free is a sharp, honest differentiator and removes a reason to
  churn.
- Commission engine sits in the **top tier** — it's the reason to buy and the reason to upgrade.
- Annual billing at ~15–20% discount (market norm).

---

## 6. Success criteria

**v1 is successful if, by launch:**
1. The design partner has run **3 consecutive months** of real operations — invoicing, imports, commission, payroll — with no parallel Excel file.
2. Their sales commission is calculated entirely by the system and **agreed by the sales team without dispute**.
3. Zero FBR invoice rejections in the final month.
4. Their accountant files STR-7 from our output without manual rework.
5. **At least 2 more paying customers** acquired without a founder-led custom build.

Criterion 2 is the real one. If the RSMs trust the number, you have a product. If they don't, you have software.

---

## 7. Immediate next actions

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

---

## 8. Open questions for the founder

- What does the design partner pay for their current system today? That anchors your pricing more than any market research.
- How many sales staff, and how many tiers in their hierarchy? Determines commission engine complexity.
- Is commission currently paid on invoice or on recovery? This is the highest-variance requirement.
- Do they need multi-company (separate legal entities), or one company with branches?
- Roughly how many invoices per month? Sets the performance bar for FBR submission throughput.
- Are they sales-tax registered and already under the digital invoicing mandate? If yes, deadline pressure is your sales lever.

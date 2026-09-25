# Pakistan Tax & Compliance — Hard Requirements for SahulatERP
**Date:** 2026-09-22
**Status:** Spec input. Everything here is a *non-negotiable* correctness requirement, not a feature idea.

> This is the part of the product where "close enough" is worthless. An invoice FBR rejects, or an
> Annex-C that doesn't reconcile, costs the customer money and costs you the account. Build this
> layer deliberately and test it hard.

---

## 1. Sales tax mechanics

### Rates
- **Standard sales tax (GST) on goods: 18%**
- Reduced / zero rates apply per the Schedules to the Sales Tax Act 1990, keyed off **HS code / PCT heading**
- **Further tax: 4%** — charged *on top* of standard tax when a registered seller supplies an **unregistered** buyer, or a buyer not on the **Active Taxpayers List (ATL)**
  - Effective total in that case: **22%**
  - This is an ATL *lookup*, not a static customer flag — a customer can drop off ATL between invoices
  - Note: abolition has been proposed repeatedly and **rejected by the IMF** (Jul 2025). Assume it stays, but make the rate configurable.
- **Extra tax / FED** applies to specific categories
- **Sales tax withholding** — Section 3(7), Eleventh Schedule. Government bodies, companies and specified registered persons must withhold part of the sales tax and pay FBR directly. Rate varies by supplier status, from 1/5th of tax down to 5% of value for unregistered suppliers.

### Design implication
Tax calculation must be a **rules engine keyed on (HS code, buyer registration status, ATL status, buyer type, province)** — not a percentage field on the product. Hardcoding 18% is the single most common mistake in local software and it will bite you within a month.

---

## 2. Mandatory sales tax invoice fields (Section 23)

| Field | Notes |
|---|---|
| Supplier name, address, **STRN** | |
| Buyer name, address, registration number | **STRN** if registered; **CNIC** if unregistered |
| Unique sequential serial number | **Never reused, never skipped.** Gaps are audit red flags. |
| Date of issue | |
| Description & quantity of goods | |
| Value excluding sales tax | |
| Sales tax amount | At applicable rate |
| Total value including sales tax | |

- Invoices may be issued in **English or Urdu**
- **Records must be retained 6 years**
- Retail consumer sales: a standard POS receipt suffices, no buyer registration needed
- Manufacturer/importer supplying an **unregistered distributor** must show the distributor's CNIC or NTN

### Under digital invoicing, add three more:
- **IRN** (Invoice Reference Number) from FBR
- **FBR QR code**
- **Digital signature**

---

## 3. FBR Digital Invoicing API

### Onboarding
1. Register on the FBR Digital Invoicing portal
2. Obtain **Client ID + Client Secret**
3. **OAuth 2.0** bearer tokens — **token validity 5 years**
4. Test in **Sandbox** (no tax implications), then move to **Production** (legally binding, real-time)

### Endpoints
- `POST /Invoice` — submit
- `POST /Invoice/Validate` — pre-submission verification
- `GET` reference endpoints — province codes, document types, item codes, units of measurement

### Payload must carry
- Seller: NTN, STRN, name, address
- Buyer: NTN/CNIC, name, address
- Line items with **HS codes**
- Tax calculations (sales tax, FED, further tax, etc.)
- QR code generated for verification

### Operational rules
- IRN must be obtained **before the sale completes** — this is a blocking, synchronous call in your POS/invoice flow
- **72-hour window** to cancel/delete/edit a bona-fide mistake; after that, Commissioner IR approval required
- A business may use **multiple licensed integrators** simultaneously (STGO 01 of 2026)

### Reference docs to obtain
- FBR Technical API Documentation PDF **v1.12**
- Digital Invoicing User Manual **v1.4**
- Chapter XIV, Sales Tax Rules 2006 (licensed integrator framework)

### ⚠ Architecture warning
A synchronous, mandatory, third-party call in the critical path of every sale is an availability risk you
do not control. You need: request queuing, idempotency keys, retry with backoff, a clearly-defined
degraded mode, and per-tenant visibility into what is unsubmitted. Decide the degraded-mode policy
**with a tax advisor**, not on your own.

### Integrator strategy
- FBR charges nothing. **PRAL integrates free of cost.**
- Private integrator fees are **capped by FBR** via STGO.
- 8 licensed integrators currently: Haball, WebDNAWorks, EY Ford Rhodes, PRAL, OpenPort Pakistan, TMR Consulting, NatureTech, Dynamic Resources.
- **Recommendation: integrate via PRAL.** Free, government-backed, and it removes a per-invoice cost from your unit economics. Revisit becoming a licensed integrator yourself only once you have scale — it's a moat, but not a v1 problem.

---

## 4. Sales tax return filing — the ERP must generate these

This is where you beat the cheap competition. Most T1 SaaS produces invoices but leaves the client's
accountant to rebuild the return in Excel.

### Monthly cycle
| Date | Action |
|---|---|
| **10th** | Upload **Annex-C** (sales) and **Annex-A** (purchases) |
| **15th** | Generate **PSID** payment slip, pay via banking channel |
| **18th** | Submit **STR-7** via IRIS |

**NIL returns are mandatory** even with zero activity. Same penalties for omission.

### STR-7 (main return)
`Net Payable = Output Tax − Allowed Input Tax`
**Section 8B cap: input tax claimed cannot exceed 90% of output tax.** Excess carries forward. Your
engine must implement this cap and the carry-forward ledger.

### Annex-C — Sales / Output tax
Per invoice line:
- Buyer STRN (registered) or CNIC (unregistered)
- Invoice number, date (**DD-MM-YYYY, strictly**)
- HS code / PCT heading per line
- Quantity, UoM, description
- Taxable value excl. tax
- Sales tax at applicable rate
- Further tax (4%) where buyer unregistered
- Extra tax / FED where applicable

> **Critical:** If the supplier files Annex-C late, **their buyers cannot claim input tax.** This is a
> business-relationship consequence, not just a compliance one — surface it loudly in the UI.

### Annex-A — Purchases / Input tax
- **Auto-populates from suppliers' Annex-C submissions**
- Per invoice: number, date, supplier STRN, value, claimed tax
- User must **accept / reject / mark not-claimed** per invoice
- **6-month claim window** from invoice date
- ⚠ Manually entering an invoice absent from the supplier's filing triggers FBR cross-matching flags, automatic reversal, and penalties. Your UI must actively discourage this.

### Annex-B — Imports ⭐ (directly relevant to your design partner)
- Auto-populated from **Customs WeBOC / PSW** via **GD number**
- GD number + date, commodity description, HS code, import value, sales tax collected at import, claim status
- **This is the bridge between the import landed-costing module and the tax module.** Same GD, two purposes.

### Annex-I — Debit/Credit notes
- Must reference original invoice number + date **exactly**
- Note type, adjusted amount, tax impact
- FBR matches these; mismatches trigger queries. Referential integrity is mandatory in your data model.

### Annex-F — Stock statement
Opening stock, purchases, sales, closing stock, reconciliation. Required for manufacturers.

### Annex-H — Refund claims
Exporters / zero-rated. Export invoices, shipping bills, GD numbers, refund calc.

### Data format rules (CSV upload standard)
- **No commas in numeric fields**
- Mandatory-field completion checks before upload
- **DD-MM-YYYY** date format enforced
- HS code / PCT heading validated against Schedule items for rate determination

### Penalties
- Late payment: default surcharge at **KIBOR + 3% annually**
- Wrong input tax claim: recovery + 3% penalty or **Rs 25,000 minimum**
- Digital invoicing non-compliance: **Rs 500,000** first default → **Rs 3,000,000** repeat, plus registration suspension / blacklisting powers (Finance Act 2026)

---

## 5. Provincial sales tax on services

Separate authorities, separate registrations, separate rates, separate filings:
- **PRA** — Punjab Revenue Authority
- **SRB** — Sindh Revenue Board
- **KPRA** — Khyber Pakhtunkhwa Revenue Authority
- **BRA** — Balochistan Revenue Authority

Candela integrates with PRA for restaurant invoices; CloudPOS claims PRA/SRB/BRA/KPRA. Treat these as
**post-v1** unless your design partner needs one. Scope them deliberately — each is real integration work.

---

## 6. Payroll compliance

| Item | Rule |
|---|---|
| **EOBI** | 5% employer / 1% employee, on minimum wage basis |
| **SESSI / PESSI** | Provincial social security — Sindh / Punjab variants, different rules |
| **Provident fund** | Employer + employee contributions |
| **Gratuity** | Based on tenure and last drawn salary |
| **Income tax withholding** | Income Tax Ordinance 2001 slabs — **change annually with the Finance Act** |
| **Minimum wage** | Changes annually, varies by province |

### Design implication
Tax slabs, EOBI rates, and minimum wage are **effective-dated configuration**, never constants in code.
You will be re-running historical payrolls; you must be able to reproduce a June 2026 payslip in 2029
using June 2026's rules. Build the effective-dating in from day one — retrofitting it is agony.

---

## 7. Import landed costing — cost components to model

For the China-import use case:

**Pre-shipment:** FOB value (USD/CNY), LC opening charges, LC margin, bank commission, TT charges
**Transit:** Ocean/air freight, insurance, THC
**Customs (per GD):** Customs duty, **Regulatory Duty (RD)**, **Additional Customs Duty (ACD)**, sales tax at import, **advance income tax**, FED where applicable
**Port & clearing:** Port charges, EDI, CWC, PQFS, wharfage, demurrage/detention, clearing agent fee
**Inland:** Inland freight, handling, warehouse-in

**Apportionment:** each cost must be allocatable across SKUs by **value, weight, volume, or quantity** —
the correct basis differs per cost type (freight by volume/weight, duty by value). This must be a
per-cost-line choice, not a global setting.

**Output:** inventory posted at **true landed cost per unit**. Landed cost typically runs **15–40% above FOB**.

**FX:** purchase in USD/CNY, settle LC later at a different rate → **exchange gain/loss** must post to P&L.
Nominal "supports 160 currencies" is not the same as correct FX revaluation. This is a real accounting
requirement, not a display feature.

---

## Sources
- https://waystax.com/sales-tax-rate-in-pakistan/
- https://taxflow.com.pk/blog/further-tax-pakistan-explained
- https://amalerp.com/blog/sales-tax-invoice-requirements-pakistan
- https://paktaxcalc.com/blog/sales-tax-return-filing-pakistan.html
- https://app.digitalinvoices.pk/blog/fbr-digital-invoicing-api-complete-guide-2026
- https://fbr.gov.pk/faqs/173967/173969
- https://www.fbr.gov.pk/list-of-license-interprator/173967/173971
- https://download1.fbr.gov.pk/Docs/2026331133557466STGO01of2026.pdf
- https://taxsummaries.pwc.com/pakistan/corporate/withholding-taxes
- https://profit.pakistantoday.com.pk/2025/07/25/imf-rejects-pakistans-proposal-to-abolish-4-sales-tax-on-unregistered-persons-asks-to-expand-tax-base/

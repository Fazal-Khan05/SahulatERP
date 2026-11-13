# Rates review

Every statutory rate the product gives a new company, for the pilot company's accountant to check.
The launch gate in [PLAN.md](PLAN.md) needs this signed off before the first real company goes live.

**Status: checked by Claude against the law texts on 12 November 2026; not reviewed by an accountant.** The founder has no accountant (decided 13 November 2026). Each company will confirm its own rates during setup, and can change any of them on Settings, Tax.

The rows below are what `app.seed_tax_defaults` (in `drizzle/0004_tax.sql`) writes for each new
company. Every row is dated 1 July 2026, the start of fiscal year 2026-27 (tax year 2027). They can
be seen in the product under Settings, Tax. An owner or an accountant can add a new dated rate there;
a change in the law is a new row from its date, and documents dated earlier keep the old rate.

## Where the values come from

Read on 12 November 2026:

| Key | Source |
| --- | --- |
| STA | FBR, Sales Tax Act 1990 "as amended up to 30th June, 2026": <https://download1.fbr.gov.pk/Docs/20267171373418951SalesTaxAct1990updatedupto30.06.2026.pdf> |
| ITO | FBR, Income Tax Ordinance 2001 "amended upto 30th June, 2026": <https://download1.fbr.gov.pk/Docs/2026724177725705IncomeTaxOrdinanace2001.pdf> |
| Card | FBR, Withholding Income Tax Rate Card, updated to 30 June 2026 as per Finance Act 2026: <https://download1.fbr.gov.pk/Docs/202681113864992WithholdingTaxRatesCard2027.pdf> |
| KPMG | KPMG Taseer Hadi, A Brief of Finance Act 2026 and A Brief of Provincial Tax Laws 2026 (cross-check only) |
| PRA | Punjab Sales Tax on Services Act 2012, 17th edition 2026-2027: <https://pra.punjab.gov.pk/Downloads/THE-PUNJAB-SALES-TAX-ON-SERVICES-ACT-2012-17th-Edition-2026-2027.pdf> |
| SRB | Sindh Sales Tax on Services Act 2011, amended up to 1 July 2026: <https://www.srb.gos.pk/srb/wp-content/uploads/2026/08/SSTOS_Act2011.pdf> |
| KPRA | KPRA Withholding Regulation 2024: <https://kpra.gov.pk/?sdm_process_download=1&download_id=13361> |
| BRA | Balochistan Sales Tax on Services Act 2015, last amended by the Balochistan Finance Act 2026: <https://www.ebra.com.pk/storage/uploads/downloads/1785387363.pdf> |

No memorandum from A.F. Ferguson, Yousuf Adil, EY or Tola on the Finance Act 2026 was found; the
only cross-check on FBR's own texts is KPMG's.

## Sales tax categories

| Category | Rate | Further tax | Law | Read in | Accountant agrees |
| --- | --- | --- | --- | --- | --- |
| Standard rate | 18% of value | 4% | STA s.3(1); further tax s.3(1A) | STA | |
| Third Schedule (retail price) | 18% of retail price | None | STA s.3(2)(a), Third Schedule; SRO 648(I)/2013 | STA for the rate; the SRO only in secondary sources | |
| Zero-rated | 0% | None | STA s.4, Fifth Schedule | STA | |
| Exempt | 0% | None | STA s.13, Sixth Schedule | STA | |

Further tax is charged when the buyer has no sales tax registration number or is not an active
taxpayer. Deciding that for a buyer, and the supplies SRO 648(I)/2013 excludes (such as sales to
end consumers), belongs to the tax engine in Step 17, not to these tables.

No reduced-rate category is given to a company. A company adds its own, with the schedule or SRO
that gives the rate (for example the Eighth Schedule and the item's serial).

## Income tax deducted from payments (section 153)

Percent of the gross amount, sales tax included. Law: ITO s.153(1); First Schedule, Part III,
Division III; Tenth Schedule, rule 1 for a person not on the Active Taxpayers List (double).

| Payment | On the ATL | Not on the ATL | Paragraph | Accountant agrees |
| --- | --- | --- | --- | --- |
| Goods, from a company | 5% | 10% | (1)(b)(i) | |
| Goods, from an individual or AOP | 5.5% | 11% | (1)(b)(ii) | |
| Goods: rice, cotton seed oil or edible oils | 1.5% | 3% | (1)(a) | |
| Toll manufacturing, by a company | 9% | 18% | (1)(b)(i) | |
| Toll manufacturing, by an individual or AOP | 11% | 22% | (1)(b)(ii) | |
| Services: listed sectors (transport, freight forwarding, courier, security guards, warehousing and the others in the paragraph) | 7% | 14% | (2)(i) | |
| Services: IT and IT-enabled services | 4% | 8% | proviso to (2)(i) | |
| Services: independent professionals (doctors, lawyers, architects, accountants and similar) | 15% | 30% | (2)(ii) | |
| Services: advertising in electronic and print media | 1.5% | 3% | (2)(iii) | |
| Services: terminal and port operating companies | 12% | 24% | (2)(iv) | |
| Services: any other service | 14% | 28% | (2)(v) | |
| Contracts, with a company | 7.5% | 15% | (3)(ii) | |
| Contracts, with an individual or AOP | 8% | 16% | (3)(iii) | |
| Contracts, with a sportsperson | 15% | 30% | (3)(i) | |

Read in ITO and on the Card; the two agree on every line. The Finance Act 2026 moved listed
services from 6% to 7% and other services from 15% to 14%.

The listed sectors at 7% are: transport, freight forwarding, air cargo, courier, manpower
outsourcing, hotel, security guard, software development, tracking, advertising other than in
print or electronic media, share registrar, engineering including architectural, warehousing,
non-banking finance companies, data services under a PTA licence, telecommunication towers, car
rental, building maintenance, the Pakistan Stock Exchange and the Pakistan Mercantile Exchange,
inspection, certification, testing and training, oilfield, telecommunication, collateral
management, travel and tour, REIT management, and the National Clearing Company. The product's
wording for this line names only five of them; the supplier bill (Step 25) must show the full list
where the line is chosen, or a hotel or maintenance bill will be put under "any other service" at
14%. The independent-professionals line (15%) also covers software engineers and developers
working independently, which its wording does not say.

## Sales tax withheld from suppliers (Eleventh Schedule)

Law: STA s.3(7), Eleventh Schedule. Read in STA.

| Supplier | Who deducts | Withheld | Serial | Accountant agrees |
| --- | --- | --- | --- | --- |
| An active taxpayer | A company | 1/5 of the sales tax on the invoice (stored as 20%) | 1 | |
| An active taxpayer registered as a wholesaler, dealer or distributor | A company | 1/10 of the sales tax on the invoice (10%) | 2 | |
| Not an active taxpayer | A company, AOP or individual | 5% of the gross value of the supplies | 4 | |
| Advertisement services | A registered person | The whole sales tax (100%) | 5 | |

Serials 1 and 2 do not apply where an active taxpayer supplies another registered person (the
exclusion after the schedule's table), so in practice they concern a buying company that is not
itself registered for sales tax. The product's wording for those two lines does not say so yet.

## Provincial sales tax on services

The standard rate, as a percent of the value before tax.

| Province | Rate | Law | Read in | Accountant agrees |
| --- | --- | --- | --- | --- |
| Punjab | 16% | Punjab Sales Tax on Services Act 2012, s.2(41A) and s.10 | PRA | |
| Sindh | 15% | Sindh Sales Tax on Services Act 2011, s.8(1) | SRB | |
| Khyber Pakhtunkhwa | 15% | Khyber Pakhtunkhwa Sales Tax on Services Act 2022 | KPRA regulation and KPMG; the Act's own section was not read | |
| Balochistan | 15% | Balochistan Sales Tax on Services Act 2015, s.10(1) | BRA | |

## How the tax engine applies these rates (Step 17)

Decided by Claude from the Act, with an independent second calculation; not reviewed by an
accountant. `docs/examples/step-17.md` has the worked cases.

- Further tax is added when the buyer has no sales tax registration, when the buyer is
  registered but marked not active, and when a registered buyer's active-taxpayer status has
  never been checked. The last is a choice, not the letter of the law: the Act says "not an
  active taxpayer", and an unchecked buyer is not known to be one.
- Further tax is a percentage of the value before sales tax.
- Third Schedule goods are taxed at the rate times the item's retail price times the quantity,
  whatever they sell for, with the retail price taken as the Act defines it: before sales tax.
- A zero-rated category carries further tax only if the company has put a further-tax rate on
  it (none is given by default; see question 2 below).
- Reduced-rate goods carry further tax like standard-rate goods.
- An item with no category is charged at the company's standard-rate category (founder's
  decision, 2026-11-13).
- With prices that include tax, the price is what the buyer pays and holds the sales tax and
  any further tax: each is its share of rate over (100 + rate + further rate).
- Amounts are rounded to the paisa, halves up, line by line.

## Questions for the accountant

1. **Third Schedule goods and further tax.** The product charges no further tax on them, relying
   on SRO 648(I)/2013. We could not read that SRO in the original or in a consolidated form; two
   secondary sources say Third Schedule items are one of its entries. Is that still right?
2. **Zero-rated supplies and further tax.** The product charges none. But section 4 applies
   "except" sub-section (1A) of section 3, so by the Act a zero-rated supply to an unregistered
   buyer carries further tax unless an SRO excludes it. What should the default be for exports and
   for local Fifth Schedule supplies? The product can hold either: the category's further-tax rate
   can be set.
3. **Khyber Pakhtunkhwa.** Please confirm the 15% standard rate and the section that sets it.
4. **Is anything in "Not included" below needed by the pilot company from its first day?**
5. **A registered buyer whose active-taxpayer status was never checked.** The product adds
   further tax until someone marks the customer active. Is that the right way round?
6. **The retail price on a Third Schedule item.** The product multiplies it by the rate, as
   section 3(2)(a) says, so it must be the price before sales tax. Packs that print a price
   including tax need that price divided by 1.18 when it is entered. Is that how the pilot's
   suppliers print it?
7. **Sales to end consumers.** The product can leave further tax off a sale marked as one the
   SRO excludes. Which of the pilot's sales, if any, count?

## Not included

These exist in the law and are not in a new company's tables. A company can add a sales tax
category itself; a new withholding line needs a product update.

- **Reduced sales tax rates** (Eighth Schedule: 1%, 3%, 5%, 10%, 12%, 12.5%, 16% and others by
  item). Added by the company per item group.
- **Other section 153 lines:** distributors of cigarettes (2.5%) and pharmaceuticals (1%);
  distributors, dealers and wholesalers of fast-moving consumer goods, fertiliser, electronics,
  sugar, cement, steel and edible oil who are on both lists (0.25%); gold and silver (1%); local
  sales of the five export sectors (1%) and yarn traders (0.5%); oil tanker contractors (2%);
  services to exporters under s.153(2); online sales under s.153(2A).
- **Section 153 thresholds and who must deduct.** No deduction below Rs 75,000 of goods or
  Rs 30,000 of services from one supplier in a year; no threshold for contracts. These and the
  list of "prescribed persons" are applied by the supplier bill in Step 25.
- **Other Eleventh Schedule lines:** government bodies as the buyer; cane molasses; lead and scrap
  batteries, gypsum and limestone, coal, waste paper, plastic waste, crush stone and silica (80% of
  the tax); online marketplaces (2% of gross value); toll manufacturers. Also the schedule's
  exclusions, such as supplies by an active taxpayer to another registered person.
- **How much provincial sales tax the buyer withholds.** Sindh and Balochistan: 1/5 from a
  registered provider, the whole tax from an unregistered one. Khyber Pakhtunkhwa: half, or the
  whole. Punjab: the whole tax, or 20% under a 2025 rule that the published rules contradict. To
  be settled with the accountant in Step 25.
- **Islamabad Capital Territory services tax** (15% on most entries; no 2026-27 text found).
- **Extra tax on electricity and gas bills, federal excise duty, and Tenth Schedule goods.**
- **Rates before 1 July 2026.** A document dated earlier finds no rate until a row is added for
  that period.

## Sign-off

| Date | Reviewed by | What was reviewed | Changes asked for |
| --- | --- | --- | --- |
| | | | |

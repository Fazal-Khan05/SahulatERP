# Onboarding, module toggles and branded documents — QA record

**Date:** 14 October 2026
**Scope:** backlog item T00, built from [docs/plans/2026-10-13-onboarding-modules-branding.md](../../docs/plans/2026-10-13-onboarding-modules-branding.md)
**System:** local Next.js checkout against the hosted Supabase project after migration `202610140001_modules_branding.sql`

## Result

| Check | Result |
| --- | --- |
| `npm run typecheck`, `npm run build` | Pass |
| `npm test` — 50 tests (domain, access, modules, real migrations + RLS + storage policies in PGlite) | Pass |
| Hosted migration dry run (transaction, rolled back) then applied | Pass; FBR and bank tables dropped, companies projected, `branding` bucket and read policy created |
| `onboarding.spec.ts` on the disposable QA tenant | Pass (wizard, upload, toggles, password gate, API bypass refused, print page, phone width) |
| `owner-workspace.spec.ts`, `qa-regression.spec.ts` on the demo tenant | Pass; demo behaviour and numbers unchanged |

## What was verified in the browser

- A new company goes from first sign-in to a printable invoice without help: company → documents (logo upload, accent colour, footer, live preview) → features (preset, dependency auto-select) → review → Overview.
- Sidebar, header actions, search, notifications and the role matrix all hide disabled modules; a `create_payroll` call to the API while Payroll is off is refused with "Payroll is turned off for this company".
- Turning a module off asks for the member's password. A wrong password is refused ("Password incorrect."), the right one hides the module and keeps its records, and calling `set_modules` directly without the password returns 401.
- Turning a module back on restores it immediately; provisioning never overwrites edited defaults (unit test).
- The printed invoice carries the uploaded logo, company contact, NTN, accent colour, line items, tax, totals and footer text; another tenant's member cannot fetch the logo (401).
- Design Partner, which has not completed setup, now lands its owner in the wizard with "Switch to Sahulat Trading Co." and sign-out links.
- 390 px: wizard and workspace render without horizontal overflow.

## Defects found and fixed during QA

1. **Clicks lost before hydration.** In dev mode the wizard's Continue click could land before React attached its handlers, so nothing happened (and typed text in controlled inputs could be lost). Company fields are now uncontrolled and read from the form on submit, and wizard buttons stay disabled until the client has hydrated.
2. **Preview heading collided with page headings** (`<h1>` inside the in-app preview). The compact preview renders a plain title element.
3. **Duplicate success notice** on the Features tab; the module cards now rely on the page-level notice.
4. **One-off 500 (`Unexpected end of JSON input`)** during a dev-server recompile between test runs; not reproducible on rerun. Noted here so it is not mistaken for a product bug if it appears in CI logs.

## Decisions applied

- FBR digital invoicing and bank-statement reconciliation removed from engine, schema and UI (founder decision, 13 Oct 2026).
- No SVG uploads; PNG and JPEG only, type sniffed server-side.
- Module and branding changes are open to any non-Auditor member; turning a module off requires that member's own password.
- Statutory payroll rates are blank for a new company and payroll refuses to run until they are entered.

## Hosted data touched

- Migration applied once after a rolled-back dry run. Demo and Design Partner snapshots unchanged except for the projected company columns.
- QA tenant `33333333-3333-4333-8333-333333333333` ("QA Company", flagged `is_demo`) created and reset by `npm run qa:tenant`; it holds only synthetic test records and a 1-pixel PNG logo.

## Still open

- The in-memory password-attempt limit is per server instance.
- Emailing documents is a later slice; signed image URLs expire after 10 minutes, which is fine for printing but not for emailed HTML.
- Bespoke invoice layouts remain a manual onboarding service.

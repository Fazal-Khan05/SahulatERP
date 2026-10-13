# Plan: Onboarding wizard, module toggles and branded documents

Status: **built 14 October 2026** (branch `onboarding-modules-branding`); QA record in [reports/qa-2026-10-14/ONBOARDING_MODULES_QA.md](../../reports/qa-2026-10-14/ONBOARDING_MODULES_QA.md). Written 13 October 2026. Supersedes nothing; it adds to [EXECUTION-PLAN.md](../../EXECUTION-PLAN.md) and [IMPLEMENTATION-BACKLOG.md](../../IMPLEMENTATION-BACKLOG.md).

## 0. Decisions this plan records

| Decision | Choice | Source |
| --- | --- | --- |
| FBR digital invoicing | Out of scope. Sales-tax bookkeeping stays; nothing submits to PRAL/FBR. `fbr_simulations` table and `Fbr` type are removed in this slice. | Founder, 13 Oct 2026 |
| Bank reconciliation | Out of scope. `bank_import`/`bank_match` commands and `bank_statement_lines` table are removed in this slice. Cash & bank (accounts, balances, transfers, PDC status) stays on the roadmap. | Founder, 13 Oct 2026 |
| Onboarding inputs | Company name, address, contact, and document branding only. No fiscal-year, chart-of-accounts or tax questions in the wizard. | Founder, 13 Oct 2026 |
| Module selection | Toggle list (cards) in the wizard and again in Settings → Features. | Founder, 13 Oct 2026 |
| Turning a module off | Allowed for any non-Auditor member, hides only (never deletes), requires that member's own password. Turning on needs no password. | Founder, 13 Oct 2026 |
| Invoice template | One standard template with logo, letterhead image, accent colour and footer text. Bespoke layouts are a manual onboarding service, not a product feature. | Founder, 13 Oct 2026 |

Items in [IMPLEMENTATION-BACKLOG.md](../../IMPLEMENTATION-BACKLOG.md) affected: D08 and F08 (FBR) become "closed, out of scope"; T04 loses its "live tax issuance waits for compliance gate" clause; a new item **T00 Onboarding and modules** is added before T01 because every later screen depends on the module flags.

## 1. What the user will experience

### 1.1 First sign-in to a company with no setup

1. Owner signs in. The company has `setupComplete = false`, so instead of the Overview they see the wizard. Non-owners of an unset-up company see "Your owner is still setting up this company".
2. **Step 1 — Company.** Name (prefilled from the tenant), address, phone, email, tax/NTN number (optional, shown on documents when present). Live preview of the invoice header on the right.
3. **Step 2 — Documents.** Choose "Standard template" (default, already previewed) or "Use our letterhead": upload logo (PNG/JPG/SVG, ≤ 1 MB), optional letterhead image for the full header band, accent colour, footer text (bank details, terms). Preview updates live with a sample invoice.
4. **Step 3 — Features.** Module cards with toggles. Preset buttons: "Importer-distributor (recommended)" selects Sales, Purchasing, Inventory, Imports, Collections, Commissions, Reports. "Just the basics" selects Sales, Purchasing, Inventory, Reports. Dependencies auto-select parents and explain why. Each card says what it sets up.
5. **Step 4 — Review and finish.** Summary of the three steps. "Create my workspace" runs provisioning and lands on the Overview with a "Next steps" checklist (add your first product, add a customer, invite users).

Back navigation works between steps; progress is saved per step so an abandoned wizard resumes where it stopped.

### 1.2 Settings → Features (any time later)

- Same cards, same dependency rules. Enabled cards show record counts ("14 invoices, 3 drafts").
- Turning **on**: immediate; provisioning for that module runs; success toast; the sidebar gains the module.
- Turning **off**: dialog "Hide Commissions? 12 entitlements and 2 payroll links exist. They are kept and reappear if you turn it back on." Password field. The server verifies the password with Supabase before applying. Dependents are listed and turned off together (turning off Sales also offers to turn off Commissions, and requires it).
- Sidebar, header actions, search, notifications, dashboard queues and the role matrix all read the same flags, so a hidden module disappears everywhere.

### 1.3 Settings → Company & documents

- Edit the same fields as wizard steps 1 and 2 with the live invoice preview. Saves immediately.

### 1.4 Printable documents

- "Print / PDF" button on invoice, credit note, delivery note, purchase order, receipt. Opens `/print/<kind>/<id>` in a new tab: a clean A4 page using the standard template and the company's branding, with the browser's print dialog for PDF. Works at 390 px for a quick look on a phone.

## 2. Module catalogue

One definition, `src/modules/erp/modules.ts`, used by the engine, the server and the UI.

| Key | Label | Requires | Commands it owns | Provisioning on enable |
| --- | --- | --- | --- | --- |
| `sales` | Sales | — | create/submit/convert/return for sales kinds, `save_party` (customers) | Number series QUO/SO/DN/INV/CN; accounts 1100, 4000, 2100 |
| `purchasing` | Purchasing | — | create/submit/convert/return for purchase kinds, `save_party` (suppliers) | Number series PO/GRN/BILL/PR; accounts 2000, 2010, 1300 |
| `inventory` | Inventory | — | `stock_transfer`, `stock_adjust`, `set_stock_quantity`, `bulk_stock_increase`, `save_item` | Default branch "Main" and warehouse "Main store" if none exist; account 1200, 5000 |
| `imports` | Imports & costing | `purchasing`, `inventory` | `create_shipment`, `add_shipment_cost`, `allocate_shipment` | Number series SHP; accounts 1400, 5300 |
| `collections` | Collections & PDCs | `sales` | `create_receipt` (customer), `update_cheque`, `follow_up` | Number series REC; account 1000 |
| `commissions` | Commissions | `sales`, `collections` | `save_plan`, `approve_commission`, `save_employee` | Accounts 5100, 2200; a draft "Standard plan" (flat 0%) so the screen is not empty |
| `payroll` | Payroll | — (uses employees) | `create_payroll`, `update_payroll`, `save_employee`, `import_records` (attendance) | Accounts 5200, 2300, 2400; settings `eobiBase`, `employeeEobi`, `employerEobi`, `incomeTaxRate` seeded as blank-with-hints, not hard-coded rates |
| `reports` | Reports | — | none (read only) | none |

Always on and not shown as toggles: `dashboard`, `accounting` (ledger, journals, periods, `create_journal`, `reverse_journal`, `set_period`), `settings` (`save_settings`, `set_modules`, `save_branding`). Core accounts 1000, 1200, 3000 exist for every tenant so opening balances always have somewhere to post.

Rules:
- `requires` is transitive and enforced on the server; enabling a module enables its requirements, disabling one disables its dependents, both reported in the response message.
- Role matrix is intersected with enabled modules: `canView(role, module) && enabled.has(module)`.
- Commands listed under a disabled module are rejected with "Commissions is turned off for this company. Turn it on in Settings → Features." (HTTP 400, not 403, because the role may be fine).
- Provisioning is idempotent: it only adds what is missing, never overwrites edited values, and is written as an engine command `provision_modules` so it is audited and replayable.

## 3. Data model

### 3.1 Snapshot (runtime source today)

```ts
company: { name; taxId; address; phone; email; currency: "PKR"; logo /* initial letter fallback */ }
branding: { template: "standard"; logoPath?: string; letterheadPath?: string; accent: string; footer: string }
modules: Module[]                 // enabled module keys
setup: { complete: boolean; step: 1|2|3|4; completedAt?: string }
```

`Fbr`, `fbr[]`, `bankLines[]`, `BankLine` are removed. `decodeWorkspace` fills defaults for old snapshots: `modules` = all, `setup.complete = true` for the demo tenant and any tenant with documents, otherwise false; `branding` = standard with no images.

### 3.2 Database (migration `202610140001_modules_branding.sql`)

- `companies`: add `phone text`, `email text`, `enabled_modules text[] not null default '{}'`, `setup_complete boolean not null default false`, `branding jsonb not null default '{}'`. `private.sync_projection` writes them.
- Drop `public.fbr_simulations` and `public.bank_statement_lines` (and their rows in `sync_projection`). Drizzle schema updated to match.
- Storage bucket `branding` (private). Objects live at `<tenant_id>/logo.<ext>` and `<tenant_id>/letterhead.<ext>`. RLS on `storage.objects`: select for members of that tenant (`private.can_access((storage.foldername(name))[1]::uuid)`), insert/update/delete for Owner and Accountant only. Uploads go through our API route (server validates type and size, strips metadata, writes with the service role to the tenant's folder); reads use short-lived signed URLs minted server-side, so the browser never needs storage credentials. `database.test.ts` gains a policy test for the bucket using the PGlite storage schema stub.
- No new tables for modules; flags live on `companies` because reporting and future per-module billing will query them.

### 3.3 Demo and seed

- `blankWorkspace(false)` (Design Partner) no longer seeds branches, warehouses or settings rates; it produces an un-set-up company so the wizard runs for real.
- `buildDemoWorkspace()` sets all modules, `setup.complete = true`, standard branding, so the demo is unchanged.
- `seed-hosted.ts` unchanged apart from the removed tables.

## 4. Server and engine changes

### 4.1 Engine commands (`engine.ts`)

- `set_modules { enabled: Module[] }` — validates keys, resolves dependencies, computes added/removed, calls provisioning for added, writes `w.modules`, audit entry lists the diff. Owner only (and Accountant for enabling only).
- `provision_modules { modules: Module[] }` — internal, called by `set_modules` and the wizard finish; idempotent as per §2.
- `save_company { name; address; phone; email; taxId }` — replaces the company part of `save_settings`; Owner and Accountant.
- `save_branding { template; accent; footer; logoPath?; letterheadPath? }` — Owner and Accountant. Paths must start with `<tenantId>/`.
- `complete_setup {}` — requires name and address present and at least one module; sets `setup.complete`, writes the "Next steps" checklist state.
- `save_setup_step { step }` — persists wizard progress.
- Remove `bank_import`, `bank_match` and all `fbr` references. `summary()` and `scopeWorkspace` drop `bankLines`/`fbr`.
- `canRun(role, action)` gains a second gate: `moduleOf(action)` must be enabled, except for always-on actions.

### 4.2 API routes

- `POST /api/workspace` unchanged, except: for `set_modules` with removals, the body must include `confirmPassword`; the route verifies it (below) and strips it before calling the engine. Never logged.
- `POST /api/branding/upload` — multipart; fields `kind: logo|letterhead`; checks member role, MIME (`image/png|jpeg|svg+xml`), size ≤ 1 MB (logo) / 2 MB (letterhead), SVG sanitised (strip scripts/foreign objects) or rejected; stores with service role at the tenant path; returns the path. Then the client calls `save_branding`.
- `GET /api/branding/[kind]` — returns a 302 to a 10-minute signed URL for the tenant's asset, after the membership check. Print pages and previews use this.
- `GET /print/[kind]/[id]` — server-rendered page (static route, so it wins over the catch-all). Loads the scoped workspace, finds the document, renders the template. 404 if the actor's scope does not include it.

### 4.3 Password confirmation

- Server creates a throw-away Supabase client (publishable key, no cookies) and calls `auth.signInWithPassword({ email: user.email, password })`. Success → proceed and discard the returned session; failure → 401 "Password incorrect". Rate limit: 5 attempts per user per 15 minutes in memory per instance (good enough for now; noted as a gap for multi-instance later).
- Only the signed-in owner's own email is used; the password is never stored or echoed.

### 4.4 Scoping and enforcement

- `scopeWorkspace` also strips data of disabled modules for non-ledger roles (ledger roles still see journals, which are always on).
- Page loader: if `!workspace.setup.complete` and role is Owner → render `<SetupWizard/>`; other roles → the waiting screen.

## 5. UI work

### 5.1 New components

- `setup-wizard.tsx` — four steps, local state + `save_setup_step` on each Next. Uses the same `CompanyForm`, `BrandingForm`, `ModulePicker` components as Settings so there is one implementation.
- `company-form.tsx`, `branding-form.tsx` (with upload, colour, footer, and `DocumentPreview`), `module-picker.tsx` (cards, toggles, dependency notes, presets, record counts when passed).
- `document-preview.tsx` — renders the standard template from a `DocumentView` model; used for the live preview (sample data) and the print page (real data).
- `confirm-password-dialog.tsx` — reused later for other destructive actions.
- `features-settings.tsx`, `company-settings.tsx` — Settings tabs. Settings gets tabs: Company & documents, Features, Users (placeholder until invites ship), Audit.

### 5.2 Workbench changes

- Replace hard-coded `nav`, `roleModules`, `headerActions` with lookups that filter by `workspace.modules`.
- Role preview also respects modules.
- "Print / PDF" button in invoice details, sales list row menu, purchasing list.

### 5.3 Standard document template

- A4 and Letter via `@page`; header band (letterhead image if set, else logo + name + address + contact + NTN), document title and number, party block, meta (date, due, warehouse, terms, salesperson), line table (item, qty + unit, rate, discount, tax, amount), totals (net, tax by rate, total, paid, returns, balance or customer credit), footer text, page numbers, "Computer-generated document" line. Urdu-safe fonts (Noto Naskh fallback) so Urdu names render.
- Print CSS already exists in `globals.css`; this page is its own stylesheet to keep it independent of the app shell.

## 6. Tests

- `tests/domain/modules.test.ts`: dependency resolution (enable child → parents; disable parent → children), provisioning idempotence, command rejection for disabled modules, role × module intersection, `complete_setup` validation, decode defaults for old snapshots.
- `tests/domain/database.test.ts`: migration applies on the pre-existing state (snapshots without `modules`), `companies.enabled_modules` projected, dropped tables gone, storage policies allow member read and owner write only, cross-tenant object path denied.
- `tests/domain/access.test.ts`: disabled-module data stripped for non-ledger roles.
- `tests/e2e/onboarding.spec.ts` (against a disposable QA tenant, never the demo): wizard all four steps with logo upload, land on Overview, Features page shows enabled set; turn Commissions off with wrong password (refused), right password (hidden, counts message shown), back on (returns, data intact); print page renders invoice with logo and totals; 390 px wizard usable.
- `qa-regression.spec.ts` updated: no bank/FBR references.

## 7. Delivery order (each step leaves the app working)

1. **Cleanup migration**: drop FBR and bank-lines tables, types, commands, UI; decode defaults. Tests green. *(small)*
2. **Module catalogue + flags + enforcement**: `modules.ts`, `set_modules`/`provision_modules`, `canRun` gate, workbench reads flags, Features settings page with password confirmation. Demo has everything on, so nothing visibly changes for it. *(medium)*
3. **Company and branding**: fields, `save_company`/`save_branding`, upload route, storage bucket and policies, Company & documents settings tab with live preview. *(medium)*
4. **Standard template and print pages**: `DocumentPreview`, `/print/[kind]/[id]`, buttons. *(medium)*
5. **Wizard**: composes 2–4; `blankWorkspace` un-seeded; waiting screen for non-owners; Next-steps checklist. *(medium)*
6. **E2E on a QA tenant**, docs and backlog updates, decision record. *(small)*

Effort is listed as small/medium per CLAUDE.md's rule that forecasts are capacity assumptions, not commitments; roughly six working sessions in total.

## 8. Acceptance criteria

- A new owner can go from first sign-in to a branded, printable invoice without reading documentation.
- No module code path runs for a disabled module: sidebar, actions, search, notifications, API.
- Disabling never deletes; re-enabling restores exactly; the audit log shows who changed modules and when.
- Password confirmation cannot be bypassed by calling the API directly.
- Branding files of one tenant are not readable by another tenant's member (tested at the storage policy).
- The demo tenant's behaviour and numbers are unchanged.
- `npm test`, `npm run build`, owner e2e, regression e2e and onboarding e2e pass.

## 9. Risks and open points

- **SVG uploads**: decided no (13 Oct 2026). PNG/JPG only, sniffed server-side.
- **Signed URLs in printed PDFs**: browsers embed the image at print time, so expiry is fine; emailed HTML would not be. Emailing is a later slice.
- **Module off with drafts**: drafts in a hidden module cannot be submitted until it is back on. Message this in the dialog.
- **Payroll defaults**: provisioning must not seed statutory rates (CLAUDE.md). The Payroll settings screen shows required blanks with hints; `create_payroll` refuses to run until they are filled.
- **Multi-instance rate limiting** for password attempts: in-memory only for now; move to a table when there is more than one server.
- **Who may change modules/branding**: decided (13 Oct 2026): any non-Auditor member, with their own password to disable.

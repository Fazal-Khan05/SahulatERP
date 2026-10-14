# 02 — Onboarding wizard and provisioning (ONB)

Preconditions: a fresh company (setup incomplete) reached by signing in. The workspace renders blurred behind the setup card.

| ID | P | T | Case | Expected |
|---|---|---|---|---|
| ONB-001 | P1 | F | Sign in to a fresh company | Centred setup card over blurred dashboard; "Step 1 of 4"; stepper shows Company highlighted |
| ONB-002 | P1 | F | Company name + address, Continue | Step 2 Documents; progress bar grows to 50% |
| ONB-003 | P1 | N | Continue with empty name | "Enter the company name and address." |
| ONB-004 | P1 | N | Name of 1 character | Same refusal |
| ONB-005 | P1 | N | Name filled, address empty | Same refusal |
| ONB-006 | P2 | E | Name of exactly 2 characters | Accepted |
| ONB-007 | P2 | E | Name 120+ characters | Accepted or trimmed with clear limit; invoice preview does not overflow |
| ONB-008 | P2 | E | Name with emoji and Urdu script | Saved and printed correctly |
| ONB-009 | P2 | E | Name with leading/trailing spaces | Trimmed |
| ONB-010 | P2 | E | Address with multiple lines | Preserved on documents |
| ONB-011 | P2 | F | Email prefilled with the signed-in email | Yes, editable |
| ONB-012 | P2 | N | Invalid email `abc` | Browser validation or saved as text; printed as typed |
| ONB-013 | P2 | F | Phone `+92 300 1234567` | Saved; shown on invoice header |
| ONB-014 | P2 | F | NTN optional field left blank | Allowed; "NTN / STRN" line absent on print |
| ONB-015 | P2 | F | Close the tab after step 1, sign in again | Resumes at step 2 with company saved |
| ONB-016 | P2 | F | Back from step 2 to step 1 | Fields show saved values; slide-left transition |
| ONB-017 | P1 | F | Step 2: upload PNG logo under 1 MB | Preview updates; "Replace logo" button appears |
| ONB-018 | P1 | F | Upload JPG logo | Accepted |
| ONB-019 | P2 | N | Upload a 3 MB PNG as logo | Refused with size message |
| ONB-020 | P2 | N | Upload a PDF as logo | Refused by type |
| ONB-021 | P2 | N | Upload SVG as logo | Refused (no SVG by product decision) |
| ONB-022 | P2 | N | Upload a file renamed `.png` that is actually text | Refused or broken-image handled; no crash |
| ONB-023 | P2 | F | Upload letterhead (≤2 MB) | Replaces whole header in preview |
| ONB-024 | P2 | N | Letterhead 5 MB | Refused |
| ONB-025 | P2 | F | Pick each accent colour swatch | Preview heading/table colour changes immediately |
| ONB-026 | P2 | F | Custom colour input | Hex saved; preview updates |
| ONB-027 | P2 | N | Custom colour `zzzzzz` | Rejected or ignored; no broken CSS |
| ONB-028 | P2 | F | Footer text with bank details | Appears at the bottom of the preview |
| ONB-029 | P2 | E | Footer 500 chars | Wraps; no overflow |
| ONB-030 | P2 | E | Footer with `<script>` | Rendered as text |
| ONB-031 | P2 | F | Continue on step 2 with nothing changed | Allowed (standard template) |
| ONB-032 | P2 | F | Replace logo twice | Latest shown; old file removed from storage |
| ONB-033 | P2 | S | Another tenant's member requests this logo URL | 401 |
| ONB-034 | P1 | F | Step 3: presets "All features", "Importer-distributor", "Just the basics" shown as pills | Yes, with descriptions on desktop |
| ONB-035 | P1 | F | Click "All features" | Every module on, including Payroll |
| ONB-036 | P1 | F | Click "Importer-distributor" | 8 modules on (no Payroll) |
| ONB-037 | P1 | F | Click "Just the basics" | Sales, Purchasing, Inventory, Cash & bank, Reports |
| ONB-038 | P1 | F | Basics, then turn on Commissions | Collections turns on automatically (dependency) |
| ONB-039 | P1 | F | Turn on Imports & costing | Purchasing and Inventory turn on |
| ONB-040 | P1 | F | Turn off Sales while Commissions on | Commissions and Collections turn off; warning text shown on cards |
| ONB-041 | P1 | N | Turn everything off, Continue | "Turn on at least one feature." |
| ONB-042 | P2 | F | Active preset pill highlights when selection matches exactly | Yes; deselects when any switch changes |
| ONB-043 | P2 | U | Each module tile has coloured icon, benefit line, description, "Will set up" line | Yes |
| ONB-044 | P2 | U | Selected tile has violet outline and lifted shadow | Yes |
| ONB-045 | P2 | F | Keyboard: Tab to switch, Space toggles | Works; `role=switch` with `aria-label "<Module> module"` |
| ONB-046 | P1 | F | Step 4 Review shows company, documents, features with Edit buttons | Yes; "N turned on" count correct |
| ONB-047 | P2 | F | Edit from Review → step 1, change name, Continue through | Review reflects change |
| ONB-048 | P1 | F | "Create my workspace" | Provisioning screen: ring, "Setting up {company}", staggered module lines; stays ≥2.6s |
| ONB-049 | P1 | F | After provisioning | Dashboard unblurs; Overview visible; modules in sidebar match selection |
| ONB-050 | P1 | D | Provisioned accounts | Chart has receivable/revenue/output-tax (Sales), payable/input-tax (Purchasing), inventory/COGS (Inventory), bank & cash (Cash & bank) per "Sets up" text |
| ONB-051 | P1 | D | Provisioned number series | QUO/SO/DN/INV/CN, PO/GRN/BILL/PR present as enabled |
| ONB-052 | P1 | D | Inventory on with no warehouse | A first branch and warehouse created ("Main store") |
| ONB-053 | P1 | D | Cash & bank on | A main bank account and cash-in-hand created |
| ONB-054 | P2 | D | Commissions on | A draft "Standard plan" exists |
| ONB-055 | P1 | N | Call `complete_setup` twice | Second: "Setup is already complete." |
| ONB-056 | P1 | N | `complete_setup` via API with no modules | "Turn on at least one feature." |
| ONB-057 | P1 | N | `complete_setup` via API with blank company | "Enter the company name and address first." |
| ONB-058 | P2 | F | Provisioning fails (simulate network drop) | Card returns to Review with error; no partial module state visible |
| ONB-059 | P2 | F | Press "Create my workspace" twice quickly | One provisioning; button disabled while busy |
| ONB-060 | P2 | U | Provisioning lines equal selected modules + "Opening your books" + "Preparing your workspace" | Yes |
| ONB-061 | P2 | U | Reduced motion | Lines appear without stagger; ring slow |
| ONB-062 | P1 | S | Payroll off: POST `create_payroll` | 400 "Payroll is turned off for this company. Turn it on in Settings → Features." |
| ONB-063 | P1 | S | Imports off: `create_shipment` | Refused with the module-off message |
| ONB-064 | P2 | F | Sidebar after basics | No Commissions, Imports, Payroll, Collections entries |
| ONB-065 | P2 | F | Header action buttons respect modules | No "Record receipt" when Collections off |
| ONB-066 | P2 | F | Search excludes records of off modules | Yes |
| ONB-067 | P2 | U | Card on 390px phone | Fills screen; step titles collapse to numbers except current; sticky footer buttons; no horizontal scroll |
| ONB-068 | P2 | U | Card on iPad portrait | Centred with scrim; both columns on Documents step |
| ONB-069 | P2 | U | Documents step on phone | Preview below the form; scrollable inside card |
| ONB-070 | P2 | U | Backdrop | Dashboard visible but blurred; not clickable; not focusable with Tab (`inert`) |
| ONB-071 | P2 | U | Footer under card | "Setting up {company} as {name}", switch-company links, Sign out |
| ONB-072 | P2 | F | Switch to another company from the footer | Navigates with `?tenant`; wizard state of the first is kept |
| ONB-073 | P2 | F | Sign out from the wizard | Login screen |
| ONB-074 | P2 | F | Escape key on the card | Does nothing (setup cannot be dismissed) |
| ONB-075 | P2 | E | Steps saved via API out of order (`save_setup_step` 4 before 2) | Accepted or refused consistently; wizard opens at the saved step without crashing |
| ONB-076 | P2 | E | `save_setup_step` with step 9 | Validation error |
| ONB-077 | P2 | E | `set_modules` with unknown key `crypto` | Validation error |
| ONB-078 | P2 | E | `set_modules` with `["commissions"]` only | Server adds sales and collections (requirements) |
| ONB-079 | P2 | F | Step 1 while busy (Continue pressed) | Inputs disabled; spinner on button |
| ONB-080 | P2 | F | Hydration: click Continue immediately after load | Click not lost (button disabled until hydrated) |
| ONB-081 | P2 | F | Reload during step 3 after toggling but before Continue | Toggles reset to last saved set |
| ONB-082 | P2 | F | Company name change after setup (Settings) | Not blocked by wizard state |
| ONB-083 | P2 | U | Progress bar widths 25/50/75/100% | Yes, animated |
| ONB-084 | P2 | U | Stepper done steps show check marks | Yes |
| ONB-085 | P2 | U | Step transition forward slides from right, back from left | Yes |
| ONB-086 | P2 | D | Audit history after setup | Entries for save_company, save_branding, set_modules, save_setup_step, complete_setup |
| ONB-087 | P2 | D | Revision increments once per step save | Yes |
| ONB-088 | P2 | F | Owner finishes setup while a second member is on the card in another browser | Second member's next action shows the workspace |
| ONB-089 | P2 | F | Auditor opens a company mid-setup | "… is being set up" screen |
| ONB-090 | P2 | E | Address with 2,000 characters | Accepted up to limit; preview truncates gracefully |
| ONB-091 | P2 | E | Tax id with letters and dashes `ABC-123-X` | Saved as typed |
| ONB-092 | P2 | E | Footer containing only spaces | Treated as empty |
| ONB-093 | P2 | F | Logo upload while offline | Clear error; can retry |
| ONB-094 | P2 | S | Upload path traversal filename `../../x.png` | Stored under tenant path; filename ignored |
| ONB-095 | P2 | F | Branding saved on step 2 appears in Settings → Company & documents | Yes |
| ONB-096 | P2 | F | Invoice printed after setup | Logo, accent colour, footer, NTN all as entered |
| ONB-097 | P2 | F | Company reset by script, user already signed in | Next navigation shows setup card again |
| ONB-098 | P2 | U | Demo company never shows setup card | Correct (demo seeded complete) |
| ONB-099 | P2 | X | Setup with All features on a slow connection | Provisioning completes; UI never shows a half-provisioned sidebar |
| ONB-100 | P1 | F | End to end: fresh tenant → all four steps → Create → first invoice printed | All pass with no console errors |

Covered by automation: `onboarding.spec.ts` (steps, dependency, password gate, print), unit `modules.test.ts`.

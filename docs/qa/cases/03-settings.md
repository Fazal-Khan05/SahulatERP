# 03 — Settings: company & documents, features, access, audit (SET)

| ID | P | T | Case | Expected |
|---|---|---|---|---|
| SET-001 | P1 | F | Open Settings | Tabs: Company & documents, Features, Access, Audit history |
| SET-002 | P1 | F | Change company name, Save changes | "Company details and document branding saved."; sidebar switcher updates |
| SET-003 | P1 | N | Clear company name, Save | Refused (name ≥ 2) |
| SET-004 | P2 | F | Save button disabled until something changes | Yes |
| SET-005 | P2 | F | Change NTN, Save, print invoice | "NTN / STRN: …" printed |
| SET-006 | P2 | F | Change accent colour, Save | Preview updates live; print uses new colour |
| SET-007 | P2 | F | Replace logo in Settings | New logo in preview and print |
| SET-008 | P2 | F | Remove logo | Preview falls back to company initial |
| SET-009 | P2 | F | Upload letterhead, then remove | Header returns to logo + name |
| SET-010 | P2 | N | Logo > 1 MB | Refused |
| SET-011 | P2 | E | Footer emptied | Printed documents show no footer line |
| SET-012 | P2 | F | Edit, then switch tab without saving | Changes lost without crash (acceptable) or kept; no partial save |
| SET-013 | P2 | F | Auditor opens Company & documents | Read-only; no Save button |
| SET-014 | P2 | F | Salesperson saves company name | Allowed (all roles may edit company/branding per access list) |
| SET-015 | P1 | F | Features tab lists all modules with switches and record counts | Yes |
| SET-016 | P1 | F | Turn on an off module (e.g. Payroll) | No password; switch on; sidebar gains Payroll immediately |
| SET-017 | P1 | F | Turn off a module | Dialog "Hide {Module}?" with record counts, password field |
| SET-018 | P1 | N | Wrong password | "Password incorrect." stays open |
| SET-019 | P1 | F | Correct password | Module hidden; sidebar entry gone; records kept |
| SET-020 | P1 | S | `set_modules` via API removing a module without `confirmPassword` | 401 |
| SET-021 | P1 | S | `set_modules` via API with wrong password | 401 |
| SET-022 | P1 | F | Turn module back on | Records and settings exactly as before |
| SET-023 | P1 | F | Turn off Sales with Commissions on | Dialog lists Collections and Commissions as also hidden |
| SET-024 | P1 | N | Try to turn off Sales via API but keep Commissions | "Commissions, Collections & PDCs cannot stay on without Sales." |
| SET-025 | P2 | F | Any role (not only Owner) can confirm with their own password | Yes by product decision |
| SET-026 | P2 | N | Auditor tries to toggle | Switches disabled |
| SET-027 | P2 | F | Cancel the hide dialog | Switch stays on |
| SET-028 | P2 | F | Press Escape on the hide dialog | Closes, no change |
| SET-029 | P2 | E | Password field pasted with trailing newline | Trimmed or refused cleanly |
| SET-030 | P2 | S | Password sent only in the command body over HTTPS | Not in URL, not logged in audit |
| SET-031 | P2 | F | Hidden module's drafts | "Drafts inside a hidden module cannot be submitted until it is turned back on." |
| SET-032 | P1 | S | Submit a sales draft via API while Sales is hidden | Refused with module-off message |
| SET-033 | P2 | F | Hidden module's records in search | Not shown |
| SET-034 | P2 | F | Hidden module's accounts in Accounting | Still present (books are never hidden) |
| SET-035 | P2 | F | Reports when Collections hidden | Receivables still report (accounting data) |
| SET-036 | P2 | F | Hide Reports | Sidebar Reports gone; Overview still works |
| SET-037 | P2 | F | Hide Cash & bank with balances | Allowed (hidden, not deleted); Accounting balances unchanged |
| SET-038 | P2 | F | Record counts in the dialog | Match the actual lists (documents, customers, products…) |
| SET-039 | P2 | F | Presets not shown in Settings | Correct (`showPresets=false`) |
| SET-040 | P2 | F | Tiles in Settings use the same colours as sidebar | Yes |
| SET-041 | P2 | U | Dialog backdrop blurred and tinted | Yes |
| SET-042 | P2 | U | Dialog on phone | Bottom sheet; password input 16px |
| SET-043 | P2 | F | Access tab: company name, tax id, revision | Correct |
| SET-044 | P2 | F | "View as role" | Enabled only for Owner in a demo company |
| SET-045 | P2 | F | View as Salesperson | Sidebar reduces; "Previewing as Salesperson" chip; Exit preview |
| SET-046 | P1 | S | While previewing as Salesperson, POST an owner-only command | Allowed server-side (real role) — preview is visual only, and the UI says so |
| SET-047 | P2 | F | Reset demo (demo company, Owner) | Confirmation dialog; data restored to seed |
| SET-048 | P2 | S | Reset demo on a non-demo company via API | Refused |
| SET-049 | P2 | S | Reset demo as Accountant | Button absent; API refused |
| SET-050 | P2 | F | Audit history tab | Chronological commands with actor, type, time |
| SET-051 | P2 | F | Audit entry for a hide-module action | Present without the password |
| SET-052 | P2 | F | Audit after 200 commands | Paginated or scrollable; no freeze |
| SET-053 | P2 | E | Company name with emoji | Saved; printed |
| SET-054 | P2 | E | Phone with letters | Saved as typed (free text) |
| SET-055 | P2 | E | Email invalid | Saved as typed or validated; consistent with wizard |
| SET-056 | P2 | F | Save company while another member saves branding | Both persist (separate commands) |
| SET-057 | P2 | D | Revision increments per save | Yes |
| SET-058 | P2 | F | Settings reachable for every role | Yes (view) |
| SET-059 | P2 | F | Keyboard navigate tabs | Arrow keys/Tab reach tabs; `role=tab`, `aria-selected` |
| SET-060 | P2 | U | Active tab violet underline | Yes |
| SET-061 | P2 | F | Deep behaviour: hide Inventory with stock on hand | Allowed; stock valuation unchanged in Accounting |
| SET-062 | P2 | F | Hide Purchasing with open supplier bills | Allowed; payables unchanged |
| SET-063 | P2 | F | Hide Collections with pending cheques | Allowed; cheques can't be moved until re-enabled |
| SET-064 | P2 | N | Toggle quickly on/off/on | Single final state; no duplicate dialogs |
| SET-065 | P2 | F | Hide module, sign out, sign in | Still hidden |
| SET-066 | P2 | F | Hide module in tab A, tab B shows it | Tab B's next command returns new workspace; sidebar updates |
| SET-067 | P2 | S | `set_modules` as Auditor via API | "Your role does not permit this action." |
| SET-068 | P2 | F | Branding preview uses latest posted invoice if any, else sample | Yes |
| SET-069 | P2 | U | Branding preview typography/colours match print | Yes |
| SET-070 | P2 | F | Save branding with same values | No error; revision may increment |
| SET-071 | P2 | E | Accent colour black `#000000` | Allowed; print readable |
| SET-072 | P2 | E | Accent colour white `#ffffff` | Allowed but heading invisible — note as design limitation or validation |
| SET-073 | P2 | S | Branding upload path uses tenant id folder | Yes; cross-tenant read 401 |
| SET-074 | P2 | S | Branding upload as Auditor | Refused |
| SET-075 | P2 | F | Settings → Features counts "N turned on" | Matches |
| SET-076 | P2 | U | Long module descriptions wrap in tiles | Yes |
| SET-077 | P2 | U | Dependency hint "Uses Sales" shown in violet | Yes |
| SET-078 | P2 | U | "Turning this off also turns off …" shown in amber | Yes |
| SET-079 | P2 | F | Hide module while that module's view is open | View closes to Overview; no blank page |
| SET-080 | P2 | F | Settings on a company still in setup | Not reachable (setup card) |
| SET-081 | P2 | F | Company & documents save as Recovery Officer | Allowed |
| SET-082 | P2 | E | NTN 50 characters | Accepted; prints |
| SET-083 | P2 | E | Address empty in Settings | Refused (address required) |
| SET-084 | P2 | F | Default sales-tax rate (if present in settings) | Applied as prefilled tax on sales lines |
| SET-085 | P2 | F | Default tax absent on new company | Tax placeholder 0 on lines |
| SET-086 | P2 | F | Numbering prefix in settings | Documents use it (`MC-…` for "My Company" seeded prefix) |
| SET-087 | P2 | S | Direct `save_company` with 10 KB address | Validation max length error |
| SET-088 | P2 | F | Reset demo twice in a row | Second works; seed identical |
| SET-089 | P2 | F | "Your workspace is ready." notice shown after setup only | Not shown after later saves |
| SET-090 | P2 | U | Error notice from a failed save is red | Yes (noticeError) |
| SET-091 | P2 | U | Success notice is neutral/green | Yes |
| SET-092 | P2 | F | Notice clears when the next command starts | Yes |
| SET-093 | P2 | F | Hide module dialog lists "N records" per type | Zero-count types omitted |
| SET-094 | P2 | F | Hide Reports requires password too | Yes (all hides) |
| SET-095 | P2 | F | Turning a module on provisions what it needs if missing | E.g. Cash & bank on later creates accounts once, never duplicates |
| SET-096 | P2 | D | Turn Cash & bank off and on three times | Still exactly one main bank and one cash account |
| SET-097 | P2 | D | Turn Commissions off/on | Plans and entitlements unchanged |
| SET-098 | P2 | F | Audit history shows role previews? | Not logged (client-only) |
| SET-099 | P2 | X | Features tab with 50k documents | Counts computed in < 2s |
| SET-100 | P1 | F | End to end: hide Commissions with password, verify API refusal, re-enable, approve an entitlement | All pass |

Covered by automation: `onboarding.spec.ts` (features/password/API bypass), `master-data.spec.ts` (branding).

# 17 — Shell: navigation, search, notifications, workspace switcher, Overview (NAV)

| ID | P | T | Case | Expected |
|---|---|---|---|---|
| NAV-001 | P1 | F | Sidebar lists enabled modules in order with coloured icon tiles | Overview, Sales, Purchasing, Imports, Inventory, Collections, Cash & bank, Commissions (LIVE), Payroll, Accounting, Reports, Settings |
| NAV-002 | P1 | F | Click each item | View changes; breadcrumb "Workspace › {Module}"; URL unchanged (SPA state) |
| NAV-003 | P1 | F | Active item has lilac fill and violet bar | Yes |
| NAV-004 | P2 | F | Nav disabled until hydrated | Click before hydration not lost |
| NAV-005 | P2 | F | Keyboard: Tab through nav, Enter activates | Yes |
| NAV-006 | P1 | F | Role hides modules (Salesperson: no Purchasing, Cash & bank, Accounting, Payroll) | Per canView |
| NAV-007 | P2 | F | Hidden module (Settings) removes item | Yes |
| NAV-008 | P1 | F | Workspace switcher lists memberships with demo tag | Yes; current highlighted |
| NAV-009 | P1 | F | Switch company | Navigates with `?tenant=`; data of the other company |
| NAV-010 | P2 | F | Switcher with one company | Shows company; menu has only that |
| NAV-011 | P2 | S | Switcher never lists companies you are not a member of | Correct |
| NAV-012 | P1 | F | Top bar: date (Asia/Karachi), search, bell, avatar | Yes |
| NAV-013 | P2 | F | Date shows "Wed, 14 Oct" style | Yes; hidden on phone |
| NAV-014 | P1 | F | Search ⌘K / Ctrl+K opens | Instantly, no animation |
| NAV-015 | P1 | F | Search "INV-2026" | Documents listed; Enter opens the first |
| NAV-016 | P2 | F | Search customer name | Customers and their documents |
| NAV-017 | P2 | F | Search walk-in typed name | Document found |
| NAV-018 | P2 | F | Search product SKU | Product |
| NAV-019 | P2 | F | Search employee | Only for roles allowed |
| NAV-020 | P2 | F | Search respects module gating | Hidden module records absent |
| NAV-021 | P2 | F | Search respects role scoping (Salesperson sees own docs) | Yes |
| NAV-022 | P2 | E | Search empty string | Prompt text |
| NAV-023 | P2 | E | Search 2 chars | Results or "type more" |
| NAV-024 | P2 | E | Search with regex chars `(.*` | Literal; no crash |
| NAV-025 | P2 | E | Search Urdu | Matches |
| NAV-026 | P2 | F | Arrow keys move selection, Escape closes | Yes |
| NAV-027 | P2 | F | Result click navigates to module and opens record | Yes |
| NAV-028 | P2 | X | Search with 20k records | < 100 ms per keystroke |
| NAV-029 | P1 | F | Bell badge count = attention items | Yes |
| NAV-030 | P2 | F | Bell menu lists items grouped; click goes to module | Yes |
| NAV-031 | P2 | F | Attention: draft sales to submit, cheques due, low stock, follow-ups due, unallocated shipments, released commissions, overdue invoices/bills | Each appears when relevant |
| NAV-032 | P2 | F | Attention clears after action | Yes |
| NAV-033 | P2 | F | Attention respects role/module | Yes |
| NAV-034 | P2 | F | Avatar initials | From name |
| NAV-035 | P2 | F | Sign out from profile | Login |
| NAV-036 | P1 | F | Overview metrics: Total sales, Collections, Outstanding receivables, Inventory value | Correct values |
| NAV-037 | P2 | F | Metric cards stagger in | Yes; reduced motion no stagger |
| NAV-038 | P2 | F | Sales & collections chart last 6 months | Bars violet/cyan; legend |
| NAV-039 | P2 | F | Chart empty state | "Submit an invoice or clear a receipt to see activity here." |
| NAV-040 | P2 | F | Needs your attention card | Queues with counts; "Nothing needs attention." |
| NAV-041 | P2 | F | Recent sales table last 5 | Walk-in names; View buttons |
| NAV-042 | P2 | F | Welcome strip copy | "A clear view of your day. Every figure comes from your posted records." (ledger roles) / role-limited copy |
| NAV-043 | P2 | F | No "Design partner", "Revision", "prototype" copy anywhere | Confirmed |
| NAV-044 | P2 | F | "All changes saved / Saved as you work" in sidebar | Yes |
| NAV-045 | P2 | F | Page heading description per module | Yes |
| NAV-046 | P2 | F | Header action button per module (New sales invoice, New purchase order, Record receipt) | Only with edit permission |
| NAV-047 | P2 | F | Branch picker only with ≥2 branches | Yes |
| NAV-048 | P2 | F | Branch picker filters views | Yes |
| NAV-049 | P2 | F | Notice bar success (neutral) vs error (red, role alert) | Yes |
| NAV-050 | P2 | F | Notice clears on next command | Yes |
| NAV-051 | P1 | F | Phone: hamburger opens drawer with scrim | Drawer slides; scrim blurred; close X |
| NAV-052 | P2 | F | Tap scrim closes | Yes |
| NAV-053 | P2 | F | Tap item closes drawer and navigates | Yes |
| NAV-054 | P2 | F | Escape closes drawer | Yes |
| NAV-055 | P2 | F | Drawer safe-area padding | Yes |
| NAV-056 | P2 | F | Toggle has aria-expanded and aria-controls | Yes; labels "Open navigation"/"Close navigation" unique |
| NAV-057 | P2 | F | Tabbed modules (Sales: Documents/Customers; Inventory: Stock/Products/Warehouses) | Tabs work; aria |
| NAV-058 | P2 | F | Tab state resets when switching module | Acceptable; no crash |
| NAV-059 | P2 | F | View transition fade/slide on module change | Yes |
| NAV-060 | P2 | F | Browser back/forward | No broken state (SPA; stays on app) |
| NAV-061 | P2 | F | Reload keeps company (via cookie) but returns to Overview | Yes |
| NAV-062 | P2 | F | Deep link `?tenant` reload | Same company |
| NAV-063 | P2 | F | Preview as role chip and Exit | Only demo + Owner |
| NAV-064 | P2 | F | Footer "SAHULAT ERP · Made for the way you do business · PKR · Asia/Karachi" | Present |
| NAV-065 | P2 | F | Modal auto-close only for follow-up and stock transfer | Other dialogs stay open on unrelated commands |
| NAV-066 | P2 | F | Two dialogs (editor + confirm) stacking | Focus trapped in top one |
| NAV-067 | P2 | F | Dialog close X labelled "Close dialog" | Yes |
| NAV-068 | P2 | F | Dialog Escape | Closes |
| NAV-069 | P2 | F | Dialog overlay click | Closes (or not for editor — consistent) |
| NAV-070 | P2 | X | First load TTI < 3 s on 4G | Yes |
| NAV-071 | P2 | X | Module switch < 100 ms | Yes |
| NAV-072 | P2 | F | Console free of errors on every module | Yes |
| NAV-073 | P2 | F | Hydration warnings none | Yes |
| NAV-074 | P2 | F | Workspace menu animation from trigger origin | Yes |
| NAV-075 | P2 | F | Hover motion only with mouse | Touch no stuck hover |
| NAV-076 | P2 | F | Attention item "Draft sales documents to submit" opens Sales filtered to drafts | Yes |
| NAV-077 | P2 | F | Metric subtext "From posted records" | Yes |
| NAV-078 | P2 | F | Overview for role-limited user says figures cover their scope | Yes |
| NAV-079 | P2 | F | Overview after company reset | All zero; welcome strip |
| NAV-080 | P2 | F | Search dialog on phone | Full-width; keyboard 16px input |
| NAV-081 | P2 | F | Bell on phone | Menu fits |
| NAV-082 | P2 | F | Long company name in switcher | Truncated with ellipsis |
| NAV-083 | P2 | F | Many companies (10) in switcher | Scrollable |
| NAV-084 | P2 | F | Sidebar scroll with all modules on small height | Scrolls; bottom profile visible |
| NAV-085 | P2 | F | Module label "Imports & costing" wraps on narrow sidebar | OK |
| NAV-086 | P2 | F | LIVE label on Commissions | Gradient pill |
| NAV-087 | P2 | S | Nav for Auditor: all read-only | No action buttons |
| NAV-088 | P2 | S | Salesperson header action "New sales invoice" | Present (can create) |
| NAV-089 | P2 | F | Period chip removed | Yes |
| NAV-090 | P2 | F | Breadcrumb "Workspace" not a link | Acceptable |
| NAV-091 | P2 | F | Title tag constant | "SahulatERP · Your business, connected" |
| NAV-092 | P2 | F | Theme-color meta | #f6f7fb |
| NAV-093 | P2 | F | Demo company tag in heading and switcher | "Demo workspace" only there |
| NAV-094 | P2 | F | Non-demo company has no tag | Correct |
| NAV-095 | P2 | F | Idle for 1 hour then act | Works or clean re-login |
| NAV-096 | P2 | F | Two tabs, command in one | Other tab updates on next command (revision) without data loss |
| NAV-097 | P2 | F | Offline then command | Error notice; retry works |
| NAV-098 | P2 | F | Dev compile race (500 HTML) | Client retries once; no duplicate |
| NAV-099 | P2 | F | Zoom 200% desktop | Layout usable; no overlap |
| NAV-100 | P1 | F | End to end tour (docs/DEMO-TOUR.md) at desktop and phone | Completes without console errors |

Covered by automation: `owner-workspace.spec.ts` (every module), `qa-regression.spec.ts` (drawer, search, attention).

# 19 — Responsive, mobile, accessibility, motion (UIX)

Breakpoints: ≤760px phone layout (drawer, bottom-sheet dialogs), ≤900px login single column. Tokens in `src/app/tokens.css`. Hardware required for tap/keyboard/safe-area cases.

| ID | P | T | Case | Expected |
|---|---|---|---|---|
| UIX-001 | P1 | U | Every module at 390×844 | No horizontal page scroll (`scrollWidth ≤ innerWidth`) |
| UIX-002 | P1 | U | Every module at 1440×900 | Layout as designed |
| UIX-003 | P2 | U | 768×1024 tablet | Sidebar visible or drawer; readable |
| UIX-004 | P2 | U | 1920×1080 | Content max width; no stretching |
| UIX-005 | P2 | U | 320px width | Usable; wraps |
| UIX-006 | P1 | U | Inputs 16px on touch devices | iOS does not zoom on focus |
| UIX-007 | P1 | U | Tap targets ≥ 44px on touch | Buttons, nav, switches |
| UIX-008 | P1 | U | Dialogs on phone are bottom sheets with sticky actions | Yes |
| UIX-009 | P2 | U | Sheet content scrolls with overscroll contained | No page rubber-band |
| UIX-010 | P2 | U | Safe-area insets top/bottom (notch devices) | Padding applied |
| UIX-011 | P2 | U | Keyboard open on phone with sheet | Actions remain reachable (interactive-widget resizes) |
| UIX-012 | P2 | U | No tap highlight flash | Transparent |
| UIX-013 | P2 | U | Press feedback on buttons (opacity/scale) | Yes |
| UIX-014 | P2 | U | Long-press on button doesn't select text | user-select none on controls |
| UIX-015 | P2 | U | Body text selectable | Yes |
| UIX-016 | P2 | U | Hover styles not stuck after tap | Gated by hover media |
| UIX-017 | P2 | U | Theme-color matches page background | Yes |
| UIX-018 | P2 | U | 100dvh app shell | No cut-off with browser bars |
| UIX-019 | P2 | U | Landscape phone | Usable |
| UIX-020 | P2 | U | Pinch zoom allowed | Yes (no user-scalable=no) |
| UIX-021 | P1 | U | Contrast: body text ≥ 4.5:1 | Graphite on white/grey passes |
| UIX-022 | P1 | U | Contrast: muted/subtle text ≥ 4.5:1 | #646464 passes |
| UIX-023 | P1 | U | Contrast: violet buttons white text ≥ 4.5:1 | #6b3df5 passes |
| UIX-024 | P2 | U | Contrast: badges (green/amber/red/violet/cyan on pastels) ≥ 4.5:1 | Each passes |
| UIX-025 | P2 | U | Contrast: links violet on white | Passes |
| UIX-026 | P2 | U | Contrast: placeholder text ≥ 3:1 | Passes or documented |
| UIX-027 | P2 | U | Contrast: setup footer white on tinted scrim | Passes |
| UIX-028 | P1 | U | Keyboard: full app operable without mouse | Yes |
| UIX-029 | P1 | U | Focus visible everywhere (violet ring) | Yes |
| UIX-030 | P2 | U | Focus trapped in dialogs; returns to trigger on close | Yes |
| UIX-031 | P2 | U | Skip to content link (if present) | Works |
| UIX-032 | P2 | U | Landmarks: nav, main, header | Present |
| UIX-033 | P2 | U | Headings order h1→h2→h3 | No skips |
| UIX-034 | P2 | U | All inputs labelled (aria-label or label) | axe clean |
| UIX-035 | P2 | U | Icon-only buttons have aria-label | Close, menu, search |
| UIX-036 | P2 | U | Switches `role=switch` + checked state | Yes |
| UIX-037 | P2 | U | Tabs `role=tablist/tab` + aria-selected | Yes |
| UIX-038 | P2 | U | Dialogs `role=dialog` + aria-labelledby | Yes (setup card too) |
| UIX-039 | P2 | U | Alerts `role=alert` for errors, `status` for notices | Yes |
| UIX-040 | P2 | U | Tables have `th` headers | Yes |
| UIX-041 | P2 | U | Images alt text (logo "{company} logo") | Yes |
| UIX-042 | P2 | U | Decorative icons aria-hidden | Yes |
| UIX-043 | P2 | U | Screen reader reads setup steps and progress | Current step announced |
| UIX-044 | P2 | U | Provisioning screen `aria-live=polite` | Announced |
| UIX-045 | P2 | U | Reduced motion: no slide/stagger; fades only | Yes |
| UIX-046 | P2 | U | Reduced motion: provisioning ring slow | Yes |
| UIX-047 | P2 | U | Animations ≤ 320ms UI, ease-out | Yes |
| UIX-048 | P2 | U | No `transition: all` | grep clean |
| UIX-049 | P2 | U | No layout-animating properties (width/height) except accordions | grep clean |
| UIX-050 | P2 | U | Dialog enter/exit symmetric | Yes |
| UIX-051 | P2 | U | Drawer uses drawer easing | Yes |
| UIX-052 | P2 | U | Search dialog no animation | Yes |
| UIX-053 | P2 | U | Metric stagger 40ms | Yes |
| UIX-054 | P2 | U | Hover lift only pointer:fine | Yes |
| UIX-055 | P2 | U | Fonts: Geist loads; fallback system sans | No FOIT beyond swap |
| UIX-056 | P2 | U | Tabular numerals in tables | Yes |
| UIX-057 | P2 | U | Money format `Rs 1,234` consistent | Everywhere |
| UIX-058 | P2 | U | Dates `YYYY-MM-DD` in tables, friendly in top bar | Consistent |
| UIX-059 | P2 | U | Empty states have a next action | Yes |
| UIX-060 | P2 | U | Error copy plain English, names the fix | Yes |
| UIX-061 | P2 | U | No raw hex in components (tokens only) | `validate-tokens` clean |
| UIX-062 | P2 | U | Single radius scale 6/10/14/20 | No stray radii |
| UIX-063 | P2 | U | Shadows indigo-tinted | Yes |
| UIX-064 | P2 | U | Sidebar tiles colours per module consistent with picker | Yes |
| UIX-065 | P2 | U | Gradient only on brand mark, welcome strip border, LIVE, final setup button, provisioning ring/progress | No gradient on data surfaces |
| UIX-066 | P2 | U | Badge pill style | Yes |
| UIX-067 | P2 | U | Button heights 38/30 | Yes |
| UIX-068 | P2 | U | Input height 40 | Yes |
| UIX-069 | P2 | U | Card hairline borders | Yes |
| UIX-070 | P2 | U | Top bar blur | Yes |
| UIX-071 | P2 | U | Zoom 200% desktop | No overlap |
| UIX-072 | P2 | U | Windows high-contrast mode | Borders visible |
| UIX-073 | P2 | U | Safari desktop rendering | Matches Chrome |
| UIX-074 | P2 | U | Firefox rendering | Matches |
| UIX-075 | P2 | U | iOS Safari bottom bar overlap | Sticky actions above bar |
| UIX-076 | P2 | U | Android Chrome keyboard resize | Layout resizes |
| UIX-077 | P2 | U | Datalist on iOS | Suggestions or free text OK |
| UIX-078 | P2 | U | Date input on iOS | Native picker |
| UIX-079 | P2 | U | Number inputs show numeric keyboard | `type=number` |
| UIX-080 | P2 | U | Select elements styled consistently | Yes |
| UIX-081 | P2 | U | Scrollbars styled (desktop) | Thin |
| UIX-082 | P2 | U | Table scroll hint text on phone | "Swipe sideways to see every column." |
| UIX-083 | P2 | U | Long names truncate with ellipsis where fixed width | Yes |
| UIX-084 | P2 | U | Urdu text rendering | Correct font fallback |
| UIX-085 | P2 | U | RTL text in LTR UI | No layout break |
| UIX-086 | P2 | U | Print styles don't affect screen | Yes |
| UIX-087 | P2 | U | Loading spinners on busy buttons only | Yes |
| UIX-088 | P2 | U | Skeleton shimmer where used | Reduced-motion static |
| UIX-089 | P2 | U | Toast/notice readable on phone | Yes |
| UIX-090 | P2 | U | Lighthouse accessibility ≥ 95 on login, overview, sales | Yes |
| UIX-091 | P2 | U | Lighthouse performance ≥ 80 mobile | Yes |
| UIX-092 | P2 | U | axe-core no serious violations on every module | Yes |
| UIX-093 | P2 | U | Colour-blind simulation: status not colour-only | Text labels present |
| UIX-094 | P2 | U | Voice control names match visible labels | Yes |
| UIX-095 | P2 | U | Dialog title ids unique with nested dialogs | Yes |
| UIX-096 | P2 | U | `inert` backdrop during setup | Not focusable |
| UIX-097 | P2 | U | Preset pills wrap on phone | Descriptions hidden |
| UIX-098 | P2 | U | Module tiles single column on phone | Yes |
| UIX-099 | P2 | U | Setup card full-screen on phone | Yes |
| UIX-100 | P1 | U | Full tour on iPhone hardware | No blockers |

Covered by automation: `onboarding.spec.ts` (390px no-scroll), `qa-regression.spec.ts` (drawer a11y); add axe to Playwright for UIX-092.

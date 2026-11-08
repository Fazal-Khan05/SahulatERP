# 01 — Sign-in, password reset, sessions (AUTH)

Preconditions unless stated: an invited member with a confirmed email and a known password; the app at `/`.

| ID | P | T | Case | Expected |
|---|---|---|---|---|
| AUTH-001 | P1 | F | Open `/` signed out | "Welcome back" login screen, email field, password field, "Sign in securely", "Forgot your password?" |
| AUTH-002 | P1 | F | Sign in with valid email and password | Lands on the member's own company (Overview or setup card); no error |
| AUTH-003 | P1 | N | Wrong password | Error under the form; stays on login; password field kept focusable; no page reload |
| AUTH-004 | P1 | N | Unknown email | Same generic error as wrong password (no account enumeration) |
| AUTH-005 | P2 | N | Empty email, click sign in | Browser/HTML validation blocks submit; no request sent |
| AUTH-006 | P2 | N | Empty password | Blocked client-side |
| AUTH-007 | P2 | E | Email with surrounding spaces `  user@x.com  ` | Trimmed and accepted |
| AUTH-008 | P2 | E | Email in different case `USER@X.COM` | Accepted (Supabase emails are case-insensitive) |
| AUTH-009 | P3 | E | Password with leading/trailing spaces | Not trimmed; must match exactly what was set |
| AUTH-010 | P2 | E | 200-character password | Accepted if it matches; no truncation |
| AUTH-011 | P2 | N | SQL-ish email `' OR 1=1--@x.com` | Generic failure; no 500 |
| AUTH-012 | P2 | N | Script tag in email field | Rendered as text in any error; no XSS |
| AUTH-013 | P2 | E | Unicode email local part | Rejected by email validation or generic failure; no crash |
| AUTH-014 | P2 | F | Toggle password visibility (eye icon) | Characters shown/hidden; cursor position kept |
| AUTH-015 | P3 | U | Tab order | Email → password → eye → sign in → forgot link |
| AUTH-016 | P2 | F | Press Enter in password field | Submits the form |
| AUTH-017 | P2 | F | Double-click "Sign in securely" | One request; button shows spinner and is disabled while busy |
| AUTH-018 | P1 | F | Sign in, reload the page | Still signed in (cookie session) |
| AUTH-019 | P1 | F | Sign out from the sidebar profile button | Returns to login; back button does not show workspace content |
| AUTH-020 | P1 | S | After sign-out, open `/api/workspace` directly | 401 |
| AUTH-021 | P1 | S | After sign-out, POST a command with a stale cookie | 401 and nothing changes |
| AUTH-022 | P2 | F | Sign in with `?tenant=<own tenant>` in the URL | Lands on that tenant, query preserved through the redirect |
| AUTH-023 | P1 | S | Sign in with `?tenant=<tenant you are not a member of>` | Falls back to your own company; no data from the other tenant |
| AUTH-024 | P2 | E | `?tenant=not-a-uuid` | Ignored; own company shown |
| AUTH-025 | P2 | E | `?tenant=` (empty) | Ignored |
| AUTH-026 | P2 | F | Member of a demo company and an own company, no `?tenant` | Lands on the own (non-demo) company |
| AUTH-027 | P2 | F | Member of two non-demo companies, no `?tenant` | Lands on the first by membership order; switcher lists both |
| AUTH-028 | P1 | F | Account with no memberships | "No workspace assigned" screen with Sign out |
| AUTH-029 | P2 | F | Member whose membership is inactive | Treated as no membership for that company |
| AUTH-030 | P2 | F | Member whose tenant snapshot is missing | "Workspace unavailable" screen, no stack trace |
| AUTH-031 | P1 | F | "Forgot your password?" with a valid email | Confirmation text shown; reset email arrives with link to `/auth/callback?next=/account/reset` |
| AUTH-032 | P2 | N | Forgot password with empty email | Validation; no request |
| AUTH-033 | P2 | S | Forgot password with unknown email | Same confirmation text (no enumeration) |
| AUTH-034 | P2 | E | Forgot password twice quickly | Second request accepted or rate-limited with a clear message; no 500 |
| AUTH-035 | P1 | F | Open reset link | Reset page "Choose a password of at least 8 characters" |
| AUTH-036 | P1 | F | Set new password of 8 chars | Saved; can sign in with it; old password fails |
| AUTH-037 | P1 | N | New password of 7 chars | Refused with length message |
| AUTH-038 | P2 | N | New password empty | Blocked |
| AUTH-039 | P2 | E | New password 72+ chars | Accepted or refused with a clear message; never silently truncated |
| AUTH-040 | P2 | E | New password equal to old password | Accepted (no history policy) or clear refusal |
| AUTH-041 | P1 | N | Open reset page without a valid session | "Expired" state with link back to login |
| AUTH-042 | P2 | N | Reuse the reset link after success | Expired state |
| AUTH-043 | P2 | E | Reset link opened in a different browser | Works (token in link) or expired state; never a blank page |
| AUTH-044 | P2 | F | `/auth/callback` without `code` | Redirects to login without error |
| AUTH-045 | P2 | N | `/auth/callback?code=garbage` | Redirects to login; no 500 |
| AUTH-046 | P2 | S | `/auth/callback?next=https://evil.com` | Open redirect refused; stays on the app |
| AUTH-047 | P2 | S | `/auth/callback?next=//evil.com` | Same |
| AUTH-048 | P3 | F | `/auth/signout` via GET | Method not allowed or no-op; POST only signs out |
| AUTH-049 | P2 | F | Sign out in one tab, act in another tab | Other tab's next command gets 401 and the UI shows the login |
| AUTH-050 | P2 | F | Session expiry after the refresh token lapses | Next navigation returns to login; no infinite spinner |
| AUTH-051 | P2 | F | Two accounts in two browsers simultaneously | Independent sessions; each sees only its memberships |
| AUTH-052 | P2 | F | Same account in two tabs | Both work; commands from both apply |
| AUTH-053 | P3 | U | Login page at 390px wide | Single column, inputs 16px font, no zoom on focus, no horizontal scroll |
| AUTH-054 | P3 | U | Login right-hand panel at <900px | Hidden; form fills the width |
| AUTH-055 | P3 | U | Brand mark and "SahulatERP" wordmark | Gradient mark, violet "ERP" |
| AUTH-056 | P3 | U | Benefit list on the right | Three plain lines, no fake statistics |
| AUTH-057 | P3 | U | No "Working prototype" or "simulated" copy anywhere on login | Confirmed absent |
| AUTH-058 | P3 | U | Reduced-motion OS setting | No slide animations on login |
| AUTH-059 | P2 | F | Password manager autofill | Both fields filled; sign in works |
| AUTH-060 | P2 | F | Browser back after signing in | Does not return to the login form with the app signed in |
| AUTH-061 | P2 | E | Sign in while offline | Clear network error; retry works when online |
| AUTH-062 | P2 | E | Sign in while Supabase auth is slow (>10s) | Spinner persists; no duplicate submit; eventually resolves |
| AUTH-063 | P2 | S | Inspect network: password sent only over HTTPS to Supabase | No password in URL or logs |
| AUTH-064 | P2 | S | Response headers of `/` | No service-role key or secrets in HTML/JS |
| AUTH-065 | P2 | S | Cookies | HttpOnly/secure session cookies; no token in localStorage |
| AUTH-066 | P1 | S | Reset-password flow for a user, then sign in as another user in same browser | No cross-user leakage |
| AUTH-067 | P2 | F | Member created by `npm run member:create` with MEMBER_DEMO=1 | Can sign in; sees own company and demo company |
| AUTH-068 | P2 | F | `member:create` for an existing email | Password updated; no second company created |
| AUTH-069 | P2 | N | `member:create` without MEMBER_PASSWORD | Script fails with a clear message |
| AUTH-070 | P2 | F | `company:reset` for a member | Next sign-in shows setup card; account unchanged |
| AUTH-071 | P2 | N | `company:reset` for an email with no account | Script error "No account for …" |
| AUTH-072 | P2 | N | `company:reset` for a member with two own companies | Script refuses ("Expected exactly one own company") |
| AUTH-073 | P3 | U | Error message wording for wrong password | Plain English, no Supabase internals |
| AUTH-074 | P3 | U | Focus ring on inputs | Violet ring, visible with keyboard |
| AUTH-075 | P3 | U | Dark-mode OS setting | App stays light (light-only product); theme-color matches |
| AUTH-076 | P2 | E | Email 254 chars | Accepted by validation or clear error |
| AUTH-077 | P2 | E | Paste email with newline | Newline stripped or rejected; no crash |
| AUTH-078 | P3 | E | Emoji as password | Works if it was set that way |
| AUTH-079 | P2 | S | 20 failed logins in a minute | Rate limit or lockout message from Supabase surfaced cleanly |
| AUTH-080 | P2 | F | Auditor signs in to a company still in setup | "… is being set up" screen with Sign out, never the wizard |
| AUTH-081 | P2 | F | Non-owner role signs in to a company in setup | Setup card shown (any member can finish setup) |
| AUTH-082 | P2 | F | Sign-in landing when `?tenant` is a demo company you belong to | Demo company opens; sidebar shows "Demo workspace" |
| AUTH-083 | P3 | U | Loading state on first paint before hydration | Buttons disabled until hydrated; no lost clicks |
| AUTH-084 | P2 | F | Refresh on `/account/reset` after a successful change | Shows expired/complete state, not the form |
| AUTH-085 | P2 | S | Reset page with another user's recovery token | Only that token's user is changed |
| AUTH-086 | P3 | E | Browser with cookies disabled | Login fails with a clear message; no loop |
| AUTH-087 | P3 | E | Browser with JavaScript disabled | Static login renders; submit does nothing harmful |
| AUTH-088 | P2 | F | Sign in with an email that has a plus tag `a+qa@x.com` | Works |
| AUTH-089 | P3 | U | Forgot-password confirmation copy | Says to check email; does not reveal whether the account exists |
| AUTH-090 | P2 | F | Sign out while a command is in flight | Command may complete server-side; UI returns to login without error |
| AUTH-091 | P2 | S | `/api/branding/logo` while signed out | 401 |
| AUTH-092 | P2 | S | `/print/sales_invoice/<id>` while signed out | Login or 401, never the document |
| AUTH-093 | P2 | F | Deep link `/print/...` then sign in | After sign-in the user reaches the app (returning to the deep link is acceptable) |
| AUTH-094 | P3 | U | Page title on login | "SahulatERP · Your business, connected" |
| AUTH-095 | P3 | U | Favicon present | Yes |
| AUTH-096 | P2 | E | Very slow network (3G throttle) | Login usable; no duplicate submissions |
| AUTH-097 | P2 | F | Sign in, change password elsewhere, continue | Existing session continues until refresh fails, then login |
| AUTH-098 | P2 | S | Member removed from a company while signed in | Next load falls back to remaining companies or "No workspace assigned" |
| AUTH-099 | P3 | U | Screen reader on login | Inputs labelled "Email address", "Password"; button text read |
| AUTH-100 | P2 | F | Full round trip: sign up by script → sign in → setup → sign out → forgot → reset → sign in | All steps succeed end to end |

Covered by automation: `owner-workspace.spec.ts`, `qa-regression.spec.ts` (sign-in), unit `access.test.ts`.

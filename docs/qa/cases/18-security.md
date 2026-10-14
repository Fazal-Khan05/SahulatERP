# 18 — Security, tenancy, roles, API (SEC)

API: `POST /api/workspace` with header `x-tenant-id`, body `{type, payload, idempotencyKey, confirmPassword?}`; server checks membership, role, module gate, password where required, then runs the engine and commits with revision check. Service-role key is server-only.

| ID | P | T | Case | Expected |
|---|---|---|---|---|
| SEC-001 | P1 | S | POST command for a tenant you are not a member of | 401/403; no change |
| SEC-002 | P1 | S | POST with missing `x-tenant-id` | 400 |
| SEC-003 | P1 | S | POST with another member's tenant and your valid session | Refused |
| SEC-004 | P1 | S | Read workspace of another tenant via page `?tenant=` | Falls back; no data |
| SEC-005 | P1 | S | RLS: query `workspace_snapshots` with anon key and user JWT for other tenant | 0 rows |
| SEC-006 | P1 | S | RLS: `memberships` lists only own | Yes |
| SEC-007 | P1 | S | RLS: `tenants` only member tenants | Yes |
| SEC-008 | P1 | S | Storage: list `branding/<other tenant>/` with user JWT | Denied |
| SEC-009 | P1 | S | Storage: download other tenant logo path | Denied |
| SEC-010 | P1 | S | Service-role key absent from client bundle | grep built JS: none |
| SEC-011 | P1 | S | `NEXT_PUBLIC_*` contains only URL and publishable key | Yes |
| SEC-012 | P1 | S | Commands never executed with service role before membership check | Code review + test: unauthenticated POST never touches DB |
| SEC-013 | P1 | S | Role gate: Auditor POST any mutating command | "Your role does not permit this action." |
| SEC-014 | P1 | S | Salesperson POST `save_item` | Refused |
| SEC-015 | P1 | S | Salesperson POST `create_document` purchase | "Your role cannot create purchase documents." |
| SEC-016 | P1 | S | Warehouse Manager POST `create_receipt` | Refused |
| SEC-017 | P1 | S | Recovery Officer POST supplier payment | "Recovery officers cannot pay suppliers." |
| SEC-018 | P1 | S | Payroll Administrator POST `submit_document` | Refused |
| SEC-019 | P1 | S | Sales Manager POST `set_period` | Refused |
| SEC-020 | P1 | S | Accountant POST `set_period` reopen | "Only the owner can reopen an accounting period." |
| SEC-021 | P1 | S | Module gate: Payroll off → `create_payroll` | 400 module-off message |
| SEC-022 | P1 | S | Module gate: Sales off → `create_document` sales_invoice | Refused |
| SEC-023 | P1 | S | Module gate: Collections off → `update_cheque` | Refused |
| SEC-024 | P1 | S | Password gate: `set_modules` removing a module without password | 401 |
| SEC-025 | P1 | S | Password gate with wrong password | 401 "Password incorrect." |
| SEC-026 | P1 | S | Password gate adding a module | No password needed |
| SEC-027 | P2 | S | Password verified against the caller's own account only | Another member's password fails |
| SEC-028 | P1 | S | Branch scoping: member with branchIds [A] POSTs for warehouse in B | "This warehouse is outside your permitted branches." |
| SEC-029 | P1 | S | Branch scoping on page load | Only branch A documents/stock returned |
| SEC-030 | P1 | S | Salesperson page load | Only own sales docs, customers, own commissions; employees salaries zero; no journals/audit/payroll |
| SEC-031 | P1 | S | Warehouse Manager page load | Warehouse docs, suppliers; no receipts/journals |
| SEC-032 | P1 | S | Recovery Officer page load | Sales docs, receipts, follow-ups; no stock moves |
| SEC-033 | P1 | S | Payroll Administrator page load | Payrolls, employees with salaries, sales invoices only |
| SEC-034 | P1 | S | Auditor page load | Everything read-only |
| SEC-035 | P2 | S | `bankAccounts` sent to all roles (names only) | Balances not derivable without journals |
| SEC-036 | P1 | S | Idempotency: same key twice | Second returns same result; no duplicate |
| SEC-037 | P1 | S | Idempotency key < 8 chars | Validation |
| SEC-038 | P2 | S | Idempotency key 101 chars | Validation |
| SEC-039 | P2 | S | Same key, different payload | Original result returned (or conflict) — assert |
| SEC-040 | P2 | S | Idempotency across tenants (same key) | Independent |
| SEC-041 | P1 | S | Revision conflict: two clients commit from same revision | One succeeds; other retried by client; final state has both |
| SEC-042 | P2 | S | `commit_workspace` with non-object data | Rejected by RPC |
| SEC-043 | P2 | S | Unknown command type | 400 validation |
| SEC-044 | P2 | S | Payload 5 MB | 413 or validation; no crash |
| SEC-045 | P2 | S | Malformed JSON | 400 |
| SEC-046 | P2 | S | Content-Type text/plain | 400 |
| SEC-047 | P2 | S | GET /api/workspace | 405 or 401 |
| SEC-048 | P2 | S | CSRF: cross-site POST with cookies | Blocked by SameSite / origin check (assert) |
| SEC-049 | P2 | S | CORS from another origin | No permissive headers |
| SEC-050 | P2 | S | Security headers (X-Frame-Options/CSP) | Present or documented |
| SEC-051 | P2 | S | XSS via every free-text field (name, notes, memo, footer, reason) | Escaped in lists, dialogs, print |
| SEC-052 | P2 | S | HTML in CSV import cells | Escaped |
| SEC-053 | P2 | S | CSV injection `=cmd()` in export | Prefixed/quoted on export (assert) |
| SEC-054 | P2 | S | Path traversal in branding upload | Ignored |
| SEC-055 | P2 | S | Upload executable renamed .png | Type sniffed/refused |
| SEC-056 | P2 | S | Logo signed URL reuse after expiry | Fails |
| SEC-057 | P2 | S | `/api/branding/logo?tenant=other` | 401 |
| SEC-058 | P2 | S | `/api/demo-reset` on non-demo | Refused |
| SEC-059 | P2 | S | `/api/demo-reset` as non-owner | Refused |
| SEC-060 | P2 | S | Rate limiting on commands (200/min) | Throttled gracefully or documented |
| SEC-061 | P2 | S | Session fixation: sign in doesn't reuse pre-login session id | Yes |
| SEC-062 | P2 | S | Logout invalidates refresh token | Yes |
| SEC-063 | P2 | S | Password reset token single-use | Yes |
| SEC-064 | P2 | S | Secrets in repo | None (`.env*` ignored; scan) |
| SEC-065 | P2 | S | Audit log cannot be edited via API | No command |
| SEC-066 | P2 | S | Audit records actor id, type, time, not payload secrets | Yes |
| SEC-067 | P2 | S | Error responses don't leak stack traces | Yes |
| SEC-068 | P2 | S | 500 on engine exception returns generic message | And logs server-side |
| SEC-069 | P2 | S | Dependency audit `npm audit` | No high/critical |
| SEC-070 | P2 | S | Supabase RLS policies present on every table (migration review) | Yes |
| SEC-071 | P2 | S | `private.sync_projection` not callable by anon | Yes |
| SEC-072 | P2 | S | `commit_workspace` callable only with service role | Yes |
| SEC-073 | P2 | S | Demo reset guard trigger prevents tenant delete without flag | Yes |
| SEC-074 | P2 | S | Member removed → immediate effect on next request | Yes |
| SEC-075 | P2 | S | Role changed → next request uses new role | Yes |
| SEC-076 | P2 | S | View-as-role preview cannot elevate | Server uses real role |
| SEC-077 | P2 | S | Branch ids changed → scoping updates | Yes |
| SEC-078 | P2 | S | Document id of another tenant in `submit_document` | "Document not found." |
| SEC-079 | P2 | S | Party id of another tenant | Not found |
| SEC-080 | P2 | S | Enumerate ids by guessing (uuid) | Infeasible; still scoped |
| SEC-081 | P2 | S | Print route with other tenant id | Not found |
| SEC-082 | P2 | S | Scripts (`member:create`, `company:reset`) require env secrets | Fail without |
| SEC-083 | P2 | S | `company:reset` never touches demo or others | Verified by tenant filter |
| SEC-084 | P2 | S | `qa:tenant` only touches QA tenant id | Yes |
| SEC-085 | P2 | S | Vercel env has no service key exposed as NEXT_PUBLIC | Yes |
| SEC-086 | P2 | S | HTTPS only; HSTS | Yes |
| SEC-087 | P2 | S | Cookie secure flags in prod | Yes |
| SEC-088 | P2 | S | Clickjacking: app in iframe | Blocked or acceptable |
| SEC-089 | P2 | S | Open redirect in `next` param | Blocked |
| SEC-090 | P2 | S | Large number of memberships (100) | Page still loads |
| SEC-091 | P2 | S | Unicode normalisation attack on names (duplicate check) | Documented behaviour |
| SEC-092 | P2 | S | Command replay from old revision | Rejected/retried; no double posting |
| SEC-093 | P2 | S | Timeout mid-commit | Either committed or not; retry with key safe |
| SEC-094 | P2 | S | Server clock vs Asia/Karachi dates | `today()` uses Karachi |
| SEC-095 | P2 | S | Log review: no PII in logs | Yes |
| SEC-096 | P2 | S | Backup/restore of snapshot table | Restore reproduces projection via rebuild |
| SEC-097 | P2 | S | Penetration smoke with OWASP ZAP baseline | No high alerts |
| SEC-098 | P2 | S | Auth brute force | Supabase limits |
| SEC-099 | P2 | S | Role matrix document vs code | Matches `access.ts` |
| SEC-100 | P1 | S | End to end: eight roles each run a scripted set of allowed/denied commands | Matrix matches |

Covered by automation: unit `database.test.ts` (RLS, storage, commit), `access.test.ts`, `modules.test.ts`; `onboarding.spec.ts` (gates).

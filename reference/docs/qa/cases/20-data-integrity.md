# 20 — Data integrity, concurrency, failure recovery, migrations (DAT)

Runtime truth is the per-tenant snapshot (`workspace_snapshots.data`), committed atomically with a relational projection by `commit_workspace(p_tenant, p_expected, p_data, p_rebuild)`. Engine is pure: `execute(workspace, command, actor)`.

| ID | P | T | Case | Expected |
|---|---|---|---|---|
| DAT-001 | P1 | D | Money stored as 4-dp decimal strings everywhere | No floats in snapshot |
| DAT-002 | P1 | D | Sum of 0.1 ten times | Exactly 1.0000 |
| DAT-003 | P1 | D | Allocation of 100 across 3 lines | 33.3334/33.3333/33.3333 (last-line remainder); sum exact |
| DAT-004 | P1 | D | Quantity precision 4 dp | 0.00005 rounds consistently |
| DAT-005 | P1 | D | FX precision 4 dp | 280.12345 → 280.1235 (assert rounding mode) |
| DAT-006 | P1 | D | Tax rounding per line then summed | Totals consistent with print |
| DAT-007 | P2 | D | Negative zero never stored | "-0.0000" absent |
| DAT-008 | P2 | D | Very large values (1e11) | Stored; one-trillion guard |
| DAT-009 | P1 | D | Idempotency: retry create_document same key | One document |
| DAT-010 | P1 | D | Retry submit same key | One journal/stock move |
| DAT-011 | P1 | D | Retry with network error after server commit | Client retry returns original result |
| DAT-012 | P1 | D | Two users commit concurrently | Revision conflict handled; both applied in sequence |
| DAT-013 | P1 | D | 10 concurrent invoice creations | 10 distinct numbers; no gaps |
| DAT-014 | P1 | D | Concurrent receipt and return on same invoice | Outstanding never negative; one refused if exceeding |
| DAT-015 | P1 | D | Concurrent stock out from two tabs | Second refused if insufficient |
| DAT-016 | P2 | D | Concurrent set_stock_quantity with stale expected | "Stock changed since you opened this item…" |
| DAT-017 | P2 | D | Concurrent module toggle and command in gated module | Deterministic: refused or applied by order |
| DAT-018 | P1 | D | commit_workspace rejects stale `p_expected` | Yes |
| DAT-019 | P1 | D | commit_workspace is one transaction (snapshot + projection) | Failure in projection rolls back snapshot |
| DAT-020 | P1 | D | Projection tables after every command equal snapshot (counts, sums) | Verified by SQL |
| DAT-021 | P2 | D | `p_rebuild=true` after manual projection corruption | Restored |
| DAT-022 | P2 | D | Snapshot stored as JSON string (legacy) | Migration normalises; RPC rejects non-object |
| DAT-023 | P2 | D | Migration dry-run on hosted copy | Succeeds |
| DAT-024 | P2 | D | Migrations idempotent (run twice) | No error |
| DAT-025 | P2 | D | Codec defaults for old snapshots (no modules/setup/branding/bankAccounts) | Filled; setup.complete = demo or hasData |
| DAT-026 | P2 | D | Snapshot with unknown extra keys | Preserved or dropped consistently |
| DAT-027 | P2 | D | Snapshot schema_version bump path | Documented |
| DAT-028 | P2 | D | Backup/restore of one tenant | Restored tenant reconciles |
| DAT-029 | P2 | D | Restore then rebuild projection | Equal |
| DAT-030 | P1 | D | Invariant sweep after restore | Balanced and reconciled |
| DAT-031 | P2 | D | Audit entries append-only; count equals commands | Yes |
| DAT-032 | P2 | D | Audit includes failed commands? | Documented (no) |
| DAT-033 | P2 | D | Revision monotonic +1 per commit | Yes |
| DAT-034 | P2 | D | Timestamps ISO with timezone | Yes |
| DAT-035 | P2 | D | `today()` in Asia/Karachi at 23:30 local vs UTC | Karachi date used |
| DAT-036 | P2 | D | Document dates stored as YYYY-MM-DD | Yes |
| DAT-037 | P2 | D | Numbering per year per prefix | Resets 1 Jan |
| DAT-038 | P2 | D | Numbering with cancelled docs | Number kept; no reuse |
| DAT-039 | P2 | D | Numbering width 4 then 10,000th doc | 5 digits; still sorts |
| DAT-040 | P2 | D | IDs unique (uuid) | No collisions in 100k |
| DAT-041 | P2 | D | Party rename does not alter document references | ids stable |
| DAT-042 | P2 | D | Item rename | Lines keep itemId; print shows new name (document) |
| DAT-043 | P2 | D | Warehouse rename | Stable |
| DAT-044 | P2 | D | Archived flags survive edits | Yes |
| DAT-045 | P2 | D | Hidden module data survives on/off cycles | Yes |
| DAT-046 | P2 | D | Company reset script leaves other tenants untouched | Verified counts |
| DAT-047 | P2 | D | QA tenant reset leaves others | Verified |
| DAT-048 | P2 | D | Demo reset restores exact seed (hash) | Yes |
| DAT-049 | P2 | D | Snapshot size growth 10k documents | < 20 MB; page load acceptable or documented limit |
| DAT-050 | P2 | X | Command latency with 10k docs | < 1 s |
| DAT-051 | P2 | X | Page load with 10k docs | < 4 s |
| DAT-052 | P2 | D | Engine purity: same input twice | Same output |
| DAT-053 | P2 | D | Engine never mutates input on failure | Workspace unchanged after thrown error |
| DAT-054 | P2 | D | Partial failure in multi-step UI flows (save_party ok, create_document fails) | Party exists; user told; no orphan document |
| DAT-055 | P2 | D | Product saved, opening stock fails | Product exists; message; stock 0 |
| DAT-056 | P2 | D | Submit fails after create (one-step) | Draft kept; retry updates same draft |
| DAT-057 | P2 | D | Walk-in account creation then document fails | Walk-in account exists (acceptable); documented |
| DAT-058 | P2 | D | Browser closed mid-command | Server completes; reload shows result |
| DAT-059 | P2 | D | Server restart mid-commit | Transaction atomic |
| DAT-060 | P2 | D | DB unreachable | 500 with generic message; retry later works |
| DAT-061 | P2 | D | Storage unreachable on logo upload | Error; branding unchanged |
| DAT-062 | P2 | D | Supabase auth slow | UI waits; no duplicate |
| DAT-063 | P2 | D | Clock skew client vs server | Dates from client date fields; server validates format only |
| DAT-064 | P2 | D | Period lock enforced server-side regardless of client date | Yes |
| DAT-065 | P2 | D | Role enforced server-side regardless of UI | Yes |
| DAT-066 | P2 | D | Module gate server-side | Yes |
| DAT-067 | P2 | D | Journal source uniqueness server-side | Yes |
| DAT-068 | P2 | D | Stock non-negative server-side | Yes |
| DAT-069 | P2 | D | Credit limit server-side | Yes |
| DAT-070 | P2 | D | Allocation sums server-side | Yes |
| DAT-071 | P2 | D | Validation errors return message and no change | Yes |
| DAT-072 | P2 | D | Unknown field in payload ignored | Yes |
| DAT-073 | P2 | D | Null vs empty string normalisation | Trimmed strings |
| DAT-074 | P2 | D | Unicode normalisation of names | NFC consistent (or documented) |
| DAT-075 | P2 | D | Whitespace-only inputs | Rejected where required |
| DAT-076 | P2 | D | Extremely long strings capped by schema | Yes |
| DAT-077 | P2 | D | Deep JSON nesting attack | Rejected by schema |
| DAT-078 | P2 | D | Prototype pollution keys `__proto__` | Ignored |
| DAT-079 | P2 | D | Duplicate lines in arrays caught (allocations, returns, lines) | Yes |
| DAT-080 | P2 | D | Order of lines preserved | Yes |
| DAT-081 | P2 | D | Snapshot JSON stable key order (diffability) | Not required; documented |
| DAT-082 | P2 | D | Projection `companies.setup_complete` mirrors snapshot | Yes |
| DAT-083 | P2 | D | Projection `enabled_modules` mirrors | Yes |
| DAT-084 | P2 | D | Projection journals balanced per journal (SQL check) | Yes |
| DAT-085 | P2 | D | Projection documents totals = snapshot | Yes |
| DAT-086 | P2 | D | Unit tests run against PGlite with real migrations | Pass |
| DAT-087 | P2 | D | pgcrypto available in test DB | Yes |
| DAT-088 | P2 | D | Playwright suites independent of order | Pass in any order |
| DAT-089 | P2 | D | Playwright global warm-up prevents compile 500s | Yes |
| DAT-090 | P2 | D | Client retries once on ≥500 with same key | Yes |
| DAT-091 | P2 | D | No retry on 4xx | Yes |
| DAT-092 | P2 | D | Error notice wording from server passes through | Yes |
| DAT-093 | P2 | D | Workspace in client refreshed from command result | Yes |
| DAT-094 | P2 | D | Stale tab commits from old revision | Conflict → retry with fresh workspace → applied |
| DAT-095 | P2 | D | 1,000 commands sequentially | All applied; revision 1000 |
| DAT-096 | P2 | D | Fuzz: 500 random valid commands | Invariants hold |
| DAT-097 | P2 | D | Fuzz: 500 random invalid commands | All refused; state unchanged |
| DAT-098 | P2 | D | Vercel deploy rollback | Previous build works with current snapshots (codec backward compatible) |
| DAT-099 | P2 | D | Forward compatibility: new field unknown to old client | Ignored safely |
| DAT-100 | P1 | D | Full invariant suite after everything in files 01–19 | Balanced, reconciled, no duplicates, no negatives |

Covered by automation: unit `database.test.ts`, `documents.test.ts`, `workflows.test.ts`, `fixes.test.ts`; Playwright retry logic in `tests/e2e/global-setup.ts` and client `postCommand`.

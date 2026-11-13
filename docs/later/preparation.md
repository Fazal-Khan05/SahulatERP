# From the preparation for building in three tracks (2026-11-13)

## Later

- **Who is signed in is taken on trust inside the database (for Step 47).** Tried on a local
  database on 2026-11-13: a session connected as `app_runtime` ran
  `set_config('app.user_id', <the owner's id>, true)` and from then on read and wrote as the
  owner.

  *How it works today.* `withTenant()` puts the signed-in user's id and the company's id into
  two settings for the length of the transaction. Four functions read them
  (`app.current_user_id`, `app.tenant_id`, `app.tenant_role`, `app.tenant_branch_ids`), and
  every policy and every guard asks those four. The database checks that the user named is a
  member of the company named. It cannot check that the user named is the one who is signed in.

  *Who can use it.* Only something that can run SQL of its own choosing as `app_runtime`: a
  person holding the web app's database address and password, or a way to inject SQL through
  the app (none is known; queries are built with parameters). A signed-in member cannot do it
  from the screens.

  *Why rewriting every table's rules does not help.* Every rule already asks the same four
  functions. A stricter rule still believes whatever they answer. This item was therefore
  dropped from the preparation; `docs/LATER.md` ("From Step 18") describes the same weakness
  from the side of one table.

  *The fix, in one place.* The app proves the identity instead of stating it:
  1. `withTenant()` calls one function, `app.enter(user, tenant, expires, signature)`, where the
     signature is an HMAC over those values and the transaction's id, made with a secret the web
     app holds.
  2. The database keeps the same secret where `app_runtime` cannot read it and checks the
     signature inside `app.enter` (SECURITY DEFINER), which then records "this transaction is
     user U in company T" where only that function can write.
  3. The four functions answer from that record and no longer from the two settings.

  Nothing else changes: no policy, no guard, no command. This closes injected SQL claiming to
  be someone else. It does not close a stolen copy of the web app's settings, which would hold
  the signing secret too; closing that as well means the database checking the member's own
  sign-in token from Supabase, which is more work and can be weighed in Step 47.

  This is my reading and has not been reviewed by anyone else.

- **The shared development database will be behind `main` between a merge and the founder's
  session applying the migration.** Vercel deploys `main` at once. A migration that only adds
  things is harmless in that gap; one that the new code cannot run without is not. Until there
  is a better way (Step 51 sets up the real hosting), apply the migration first and merge
  straight after, for a step whose screens need it at once.

- **`npm run db:put-back` handles the usual case: one migration of yours that main lacks.** With
  two or more, the first is given the snapshot of all your table changes and the rest are made
  as hand-written ones. That is correct for the database and for the next generated migration,
  but it has only been rehearsed with one.

- **An audit row whose action only looks like one the database writes is accepted.**
  `'journal.post '` with a space at the end goes in as the app's role, and so would a look-alike
  of a kind a later step reserves. It was so before the preparation (found by its reviewer). The
  fix is a format rule on `audit_log.action` (lower-case words joined by full stops, nothing
  else), after checking that every action the app writes fits it.

- **CI still runs no database tests** (noted from Step 2). With three people merging, the
  check on GitHub proves types, lint, the pure tests and the migrations folder; the database
  and browser tests are run by the person merging, on their own database, before the pull
  request. A database for CI would make that automatic.

## Decided while preparing

- The standard chart, the kinds of numbered document, the audit rows only the database writes
  and the check that every journal has a document each used to be one function listing
  everything. Each now asks functions that a step adds for itself
  (`drizzle/0019_journal_documents.sql`). Decided by Claude as part of the preparation the
  founder approved on 2026-11-13.

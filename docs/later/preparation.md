# From the preparation for building in three tracks (2026-11-13)

## Later

- **Who is signed in is now proven to the database** (`drizzle/0031_identity_proof.sql`, built on
  2026-11-17 at the founder's word, ahead of Step 47). The item below describes the weakness as
  it was and the fix as it was planned; it was built that way, with three differences: the
  signature covers the user, the company and an expiry time but not the transaction's id (the
  app would need one more round trip to learn it; the signature is passed as a parameter, which
  other sessions cannot read, and is kept out of the app's own error messages, so a session of
  the app's role has nothing to replay); the record is a row for each
  database connection in `app.identity_sessions`; and the check needs no extension (the key is
  stored as the two halves HMAC hashes with). It also closes the Step 25 reviewer's finding
  (one statement answered for two companies, `docs/later/step-25.md`), because the functions
  that answer are STABLE and see the record only as it was when the statement began.

  It was reviewed by an independent reviewer on 2026-11-17, who tried it as a member with SQL of
  their own on a database with a key installed and could not act as another user, nor have one
  statement answered for two companies (materialised CTEs, cursors, DO blocks, savepoints). What
  the review did find was put right before the migration went anywhere: a transaction open since
  before the key was installed went on being believed (now a flag every transaction sees at
  once, `app.identity_proof_flag`, raised before the key goes in, and a row written without a
  proof stops counting when one is wanted; a second look by the same reviewer found those last
  two points); rubbish left in the old settings broke the connection's
  later transactions; `service_role` was not shut out by name; and the app's error for a
  refused proof carried the signature in its text.

  Known and accepted, from the same review:
  - **Whoever can read every table can read the key**: `postgres`, Supabase's own roles, and
    `supabase_read_only_user`, which the Supabase tools connect as (the shared project was
    checked on 2026-11-17). The key is of use only together with a way to run SQL as the app's
    role. Never select from `app.identity_keys` through the Supabase tools or in a chat: the two
    halves in it are as good as the secret. A backup of the database carries it too.
  - **The app cannot read in a read-only transaction**, because saying who it is writes a row.
    So no read-only copy of the database for reports, and if Supabase turns a full database
    read-only the app shows nothing instead of reading. Weigh with Step 51.
  - **Speed.** A lookup of who is asking took about 17 millionths of a second on the reviewer's
    machine. While some other session holds an old picture of the database (a backup, a long
    report), the row of each connection cannot be tidied and lookups slow down: about 19 times
    after 20,000 transactions on one connection, back to normal when the picture is let go.
    Every transaction, a page that only reads included, now uses up a transaction number. If
    this ever shows, keep one row for each transaction instead of one for each connection, and
    give the app's role a limit on idle transactions (the item on time limits, below).
  - **`npm run check` catches the plain cases only**: a migration or a file that writes the
    settings by name. It reads text; it is a reminder, not a guarantee.

  What is left, for Step 47:
  - **A database with no key installed still takes the app's word**, by the two settings or by
    an unsigned `app.enter`. That is what let the migration go in before the new app was
    deployed, and lets a development database run without a secret. Once every database the
    tests use has a key (`npm run db:identity`), take the fallback out of `app.identity_now()`
    and refuse an unsigned `app.enter` outright.
  - **Going live** (Step 51): the deployed app needs `IDENTITY_SIGNING_SECRET` and the database
    the same key installed, in that order; `npm run db:identity -- status` says whether they
    match. A deployment without the secret is shown nothing.
  - **A stolen copy of the web app's settings** holds the signing secret as well as the database
    password, as before. Closing that means the database checking the member's own sign-in token.
  - **Changing the key**: install the new one in the second slot, give the app the new secret,
    redeploy, then remove the old slot.

- **Who is signed in was taken on trust inside the database (as it was until 2026-11-17).** Tried on a local
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

- **Supabase's own function `public.rls_auto_enable` on the first project** is SECURITY DEFINER,
  owned by postgres, with `search_path=pg_catalog` (so the temporary schema is still looked in
  first). It is not ours and `drizzle/0023_safe_search_path.sql` leaves it alone; with the app's
  roles unable to make temporary objects it cannot be reached that way. The second project does
  not have it. Worth a look in Step 47 (is it callable by `app_runtime`, and is it still needed).

## Decided while preparing

- The standard chart, the kinds of numbered document, the audit rows only the database writes
  and the check that every journal has a document each used to be one function listing
  everything. Each now asks functions that a step adds for itself
  (`drizzle/0019_journal_documents.sql`). Decided by Claude as part of the preparation the
  founder approved on 2026-11-13.

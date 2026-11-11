# Later

Things noticed while building a step that belong to a later one, or to nobody yet.

## From Step 2

- **Member management has no screen.** An owner can invite, but cannot change a member's role or
  branches, deactivate a member or cancel an invitation. `app_runtime` has no UPDATE on
  `memberships` or `invitations` yet; the screen needs a migration that grants and polices it.
- **Invitations are sent by hand.** An owner's invitation is recorded in the app and sent when
  someone runs `npm run invites:send` on a machine that holds the service-role key. The worker
  exists since Step 4; make sending an invitation a job kind once the worker runs somewhere
  permanent (`scripts/lib/invitations.mjs` is written to be called from a handler).
- **Someone who already has an account cannot be invited into another company yet.** The
  invitation is recorded but stays waiting: `invites:send` never adds an existing account to a
  company without that person's consent (an owner could otherwise attach anyone to their company
  by knowing an email address). It needs an accept step in the app. Decide then whether a sign-in
  is written to every company the person belongs to, as now, or only to the one they open.
- **Auth emails need a custom SMTP provider before real customers.** On the free plan with
  Supabase's own sender: emails go only to addresses on the Supabase team, about two an hour, and
  the email templates cannot be edited (the Management API refuses). So invite and reset links use
  Supabase's default style: Supabase checks the one-time token when the link is opened and passes
  the session to `/auth/confirm` in the address fragment. With custom SMTP, switch the templates to
  token-hash links and add a confirm button, so a mail scanner that opens the link first cannot
  use it up.
- **`service_role` still has every privilege on public tables** (Supabase's default; it also
  bypasses row-level security). Nothing uses the Data API for application tables, so these grants
  can be revoked and the public schema taken off the Data API.
- **CI does not run the database or browser tests.** `npm run check` skips the policy tests when
  the database URLs are absent, and CI does not run `npm run test:e2e`. Both need a database CI
  can use; today they run locally against the dev project.
- **Preview deployments use the dev database**, the same one as production while building.
- **Pages are slow because of distance to the database, not because of the queries.** The
  database is in Mumbai (ap-south-1); Vercel runs the functions in Washington (iad1), and from the
  founder's Mac one round trip measured 200 to 450 ms. A transaction costs a round trip each for
  begin, the request context and commit, and every query with parameters costs two (the pooler
  needs `prepare: false`). Step 3 cut the frame of every page to about five round trips, but a
  page still makes ten or more. Move the function region to Mumbai (bom1); the rest belongs to the
  Step 50 performance pass.
- **`memberships.user_id` has no foreign key to `auth.users`.** Deliberate: it keeps the app's
  tables independent of Supabase's schema for exports and restores. Revisit with Step 48.
- **Dates are shown in Pakistan time** (`src/lib/format.ts`) until a tenant can choose a time zone.
- **Choosing a new password does not ask for the old one** when already signed in. Step 47
  (password policy, session timeout, 2FA) should require a recent sign-in.
- **A session that was ended elsewhere keeps working until its token expires** (up to an hour):
  requests verify the token's signature, not whether Supabase still lists the session.
  Deactivating a membership takes effect at once, because the database checks it on every query.
  Also for Step 47.
- **The forgot-password form has no limit of its own.** Supabase limits reset emails per address
  and per project; on the free sender a few requests use up the hour's quota for everyone.

## From Step 3

- **The shell was built from the mock-ups as they stand.** `docs/UI-NOTES.md` has no reviewer
  comments yet; the founder asked for Step 3 to start anyway. What the reviews change will have to
  be changed in the shell (`src/app/(app)/layout.tsx`, `navFor` in `src/modules/tenant/rules.ts`).
- **Three roles have no mock-up.** The menus for Sales Manager, Payroll Administrator and Auditor,
  the module list, which modules start on (payroll and FBR start off) and the dependency rules
  between modules are a first proposal in `rules.ts`; the founder should check them.
- **Menu entries for screens that are not built are shown greyed, not as links.** The step that
  builds a screen gives its entry an address in `roleNav` (`rules.ts`).
- **Every role's home is the same placeholder** (who you are, an empty "Needs attention"). Each
  role's own figures arrive with the modules that produce them.
- **The logo is stored in the `settings` row** (PNG, JPEG or WebP, 256 KB at most). The `files`
  table exists since Step 4, but only owners and auditors may read files and every member needs
  the logo, so it stays here until file access is widened; `/branding/logo` can keep its address.
- **`settings.fbr_enabled` from the data-model table is the `fbr` module switch**, a row in
  `modules_enabled`, not a column. Step 43 should read that.
- **The dependency rules are checked by the command, not by the database.** Two owners switching
  modules in the same instant could leave a module on without one it needs.
- **The inbox has no rows and no table yet.** The first step that produces something to act on
  decides how items are stored or derived.

## From Step 4

- **The worker is started by hand** with `npm run worker` on a machine that has
  `MIGRATION_DATABASE_URL`. Nothing runs jobs on Vercel. It gets a permanent home with the Railway
  service in Step 51; until then a queued job waits for someone to start the worker.
- **The worker is plain JavaScript** (`scripts/lib/worker.mjs`), so it cannot import the
  TypeScript modules. The first job that needs business rules (the FBR submission, a report)
  needs the worker built or run with a TypeScript loader; decide then, with the founder, since a
  loader is a new dependency.
- **Only one kind of job exists: `system.ping`**, which does nothing. Each step that needs
  background work adds its kind to `JOB_KINDS` (`src/modules/jobs/rules.ts`) and its handler to
  `scripts/lib/job-handlers.mjs`. A handler must be safe to run twice.
- **Dead jobs are not shown anywhere.** A job that fails five times is marked dead and stays in
  the table. The inbox ("FBR submissions failed") is where they should surface.
- **Files are capped at 4 MB and go through the app.** Larger scans need a direct upload to the
  object store with a signed upload link; do it with the move to R2.
- **Only owners add files, and only owners and auditors read them**, in the database and in
  Supabase Storage alike. Steps that attach files to documents must widen both.
- **Files cannot be renamed or deleted, and an upload that fails leaves a "pending" row** that is
  never listed. A clean-up job for old pending rows belongs with the nightly jobs.
- **The `authenticated` role can now reach the `app` schema**, because Supabase Storage's policies
  call `app.storage_role`. Every other function there has its EXECUTE revoked from PUBLIC, and a
  test fails if a later one does not. A new function in `app` must `REVOKE ALL ... FROM PUBLIC`.
- **An owner talking to Supabase Storage directly can create any object name inside their own
  company's folder**, not only `<company id>/<file id>`. It stays inside their company; tighten
  the storage policy to that exact shape when the policies are next changed.
- **The move to R2** is a second implementation of `ObjectStore` in `src/lib/storage/` plus
  copying the objects; keys (`<company id>/<file id>`) stay the same.
- **The database tests take about three minutes locally** and run one file at a time, because of
  the distance to the database. CI skips them.

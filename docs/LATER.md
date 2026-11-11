# Later

Things noticed while building a step that belong to a later one, or to nobody yet.

## From Step 2

- **Member management has no screen.** An owner can invite, but cannot change a member's role or
  branches, deactivate a member or cancel an invitation. `app_runtime` has no UPDATE on
  `memberships` or `invitations` yet; the screen needs a migration that grants and polices it.
- **Invitations are sent by hand.** An owner's invitation is recorded in the app and sent when
  someone runs `npm run invites:send` on a machine that holds the service-role key. Move it to the
  worker in Step 4 (`scripts/lib/invitations.mjs` is written to be called from there).
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
- **Every database transaction is four network round trips** (begin, set the request context,
  the query, commit). The database is in Mumbai (ap-south-1) and Vercel runs the functions in
  Washington (iad1), so every page waits on that distance several times over. Move the function
  region to Mumbai (bom1), and look at sending the context and the first query together in the
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

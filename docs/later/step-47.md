# Step 47: two-step sign-in, session limits, sign-in history, password policy, secrets audit

Built by the Builder on 2026-11-18, while the founder was away; his answers relayed by the
coordinator: two-step sign-in by an authenticator app (TOTP), no SMS; `otpauth` approved. No
migration.

## What was built

- **Two-step sign-in with an authenticator app** (Google Authenticator, Microsoft Authenticator,
  Authy, any TOTP app). The secret and the check of each code are Supabase Auth's own (its TOTP
  factors, free on every plan): the secret never reaches this app's database, and a session that
  has given a code carries `aal2` in its signed token.
  - After the password: an account with an app gives its code (`/two-step`); an account without
    one is offered the setup (`/two-step/setup`). **That is the plan's test, "A member without 2FA
    is prompted on next login".**
  - **Owners and accountants must have it** (and anyone allowed to create a company, who is about
    to be an owner): they cannot pass the setup by, and no page of a company where they are owner
    or accountant opens until a code was given in that session. Everyone else may say "Not now"
    and is asked again at the next sign-in.
  - Each member can set it up, or (if no role of theirs needs it) turn it off, on **Your account**
    (`/account`, linked from the top bar).
  - An email link (invite, password reset) does not get round it: an account with an app gives
    its code before choosing a password.
  - **A lost phone**: `npm run two-step:remove -- member@example.com --yes` removes the app from
    the account and ends every session of it, for whoever looks after the product, after making sure outside the app that the
    member asked. Recorded in each of the member's companies as "Had two-step sign-in removed by
    support". Supabase has no recovery codes on its free plan that this could rely on, so there
    are none.
- **Session limits.** A session ends after **60 minutes without use** and **12 hours after the
  password was entered**, however busy. The idle time is a cookie the server signs for the
  session (with a key derived from `IDENTITY_SIGNING_SECRET`), kept as long as the session's own
  cookies; one missing, forged, moved forward or from another session counts as idle unless the
  password was given in the last two minutes. The full length is read from the verified token's
  proofs (`amr`). The sign-in page says why the member was signed out. **Sign out everywhere**
  on Your account ends every session of the account.
- **Changing the password, or setting up an authenticator app, needs a recent proof**: a
  password or email link from the last 10 minutes (an authenticator code does not count), or the
  current password (closes the item in docs/LATER.md).
- **Password policy**: at least 12 characters (was 10), no rules about kinds of character; refused
  when made of fewer than 5 different characters, one of the most used passwords (a short list
  with Pakistani favourites), the product's name, or the name part of the member's own email. A
  password chosen before still works.
- **Sign-in history** (Settings, Sign-ins; owner and auditor): every sign-in, sign-out, wrong
  code, code given, password change, two-step on or off, with how (password, invitation link,
  reset link), the device ("Chrome on Windows") and the address. Also in the activity log.

## Decided for Fazal, to confirm

1. Two-step is **required for owners and accountants**, offered to everyone else. (The go-live
   list asks for it on "every owner and accountant login".) A company cannot yet choose to require
   it of every member; easy to add as a setting.
2. **60 minutes idle, 12 hours in all.** An office that leaves the app open all day signs in twice.
3. **10 minutes** for "recent" before a password change.
4. **12 characters** minimum.
5. The sign-in history keeps the **IP address**. It is personal data, kept in the audit log the
   owner and auditor read, never in logs. Without it a sign-in from somewhere else cannot be
   spotted.
6. No recovery codes; a lost phone goes through `npm run two-step:remove`.

## Things to know

- **A session that has given a code is not asked of Supabase Auth again** on each page; only its
  signed token is checked. So a session ended elsewhere ("Sign out everywhere", a support removal)
  runs on until its token expires (an hour by Supabase's default) or the idle or full limit ends
  it. A session that has not given a code asks Supabase Auth on every page, and is cut at once.
- **The database does not know about the second step.** The app proves who is signed in to the
  database (0031), but not whether a code was given. A member's role is checked by the database;
  the two-step requirement by the app. To make the database enforce it, `app.enter` would carry
  the level, signed: possible later.
- The sign-in history's device and address are what the browser and the network said. The
  address is the first in `X-Forwarded-For`, which Vercel sets.
- A member can write sign-in history rows about themselves only (the audit policy holds the actor
  to who is signed in), and only by running their own SQL as the app's role.
- `auth.two_step_reset` is written by the support script as `postgres`; a member could write a row
  with that name about themselves with SQL of their own (as with every `auth.*` row). Reserving it
  needs a migration adding it to the protected audit rows; noted, not done.
- The browser tests now give every test account an authenticator app (`e2e/support/admin.ts`) and
  `signIn` gives its code; a code is never given twice, so a test signing the same account in
  twice within 30 seconds waits for the next code.
- A bug found on the way: a cookie set by the proxy on a server action's reply made Next.js draw
  the page again inside the reply, which dropped where the form was to go next (the setup
  wizard stayed on its page). The idle cookie is never written on an action's reply.

## The independent attack review (2026-11-18)

A reviewer who had not seen the work attacked it on a local database with hosted sign-in, as
someone holding a member's password, a stolen session cookie, or their own cookies to edit.
**Nothing critical or high.** Two medium and three low findings, all put right:

- **Medium: the idle limit could be skipped.** The cookie was unsigned and ended with the browser:
  leaving it out, or setting a time in the future, kept a session alive for ever; closing the
  window lost it. Now signed for the session, kept as long as the session, and a missing or bad
  one counts as idle.
- **Medium: the recent-proof rule could be passed with a code.** Someone holding an old session of
  a member without an app could set up their own app, give its code, and then change the password
  without the old one. Now a code does not count as a recent proof, and setting up an app needs a
  recent password or the current one.
- **Low: the setup's finishing step could be used to guess codes for an app already in use**
  without a wrong code being recorded. Now it takes only a factor this account has just started
  setting up, and refuses a session that owes a code. The key is no longer sent back to the server.
- **Low: the company logo was served to an owner or accountant who had not given a code.** Now
  refused until the code.
- **Low: removing a lost phone did not end its sessions.** The support script now ends every
  session of the account.

What held: the token's `amr` is `[{method, timestamp}]` and the password's time does not move on
refresh (anything else fails closed); a forged copy of the account in the cookie changes nothing
(the app asks Supabase Auth); every page, export, PDF, file and action of a company goes through
the role check; Supabase itself refuses a second app or a password change at `aal1` on an account
with an app; turning off two-step through Supabase directly drops the session to `aal1` at its
next refresh, and the app then asks for the setup again; no open redirect; no secret, code or
address in the logs.

**Not closable in the app, noted for Fazal:** whoever holds a stolen session can still call
Supabase Auth directly with it, and Supabase lets a session change its own password without a
recent proof (its "secure password change" setting asks for one only after 24 hours). And a
stolen session refreshed directly at Supabase outlives the 12 hours, though the app refuses it.
Ending sessions older than 12 hours at the source (a job deleting old `auth.sessions` rows, or
Supabase Pro's time-boxed sessions) would close both; left for the founder to choose, as it
deletes rows in Supabase's own tables.

## The secrets audit (2026-11-18)

- **Git history**, every branch: no service-role key (`sb_secret_`), no JWT, no database address
  with a password, no `SUPABASE_SERVICE_ROLE_KEY=` or `IDENTITY_SIGNING_SECRET=` with a value, no
  private key, no GitHub or Stripe token. Only `.env.example` (names, no values) is tracked; every
  other `.env*` is ignored.
- **What reaches the browser**: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`
  and `NEXT_PUBLIC_APP_URL` only, all meant to be public. No client component reads
  `process.env`.
- **The service-role key** is read only by the operator scripts (`scripts/lib/admin.mjs`), the
  demo seed and the browser tests' support; never by the web app (`src/`).
- **The secrets and where they live**: the database addresses (`DATABASE_URL` for the app's role,
  `MIGRATION_DATABASE_URL` for `postgres`), `SUPABASE_SERVICE_ROLE_KEY`, `IDENTITY_SIGNING_SECRET`.
  In `.env.local` on the founder's Mac and the Builder's working copy, and in Vercel's settings.
  The web app (`src/`) needs only `DATABASE_URL` and `IDENTITY_SIGNING_SECRET`; Vercel's list of
  settings was not read (it needs the founder's sign-in), so whether it also holds the
  service-role key or the `postgres` address is for him to check, and to remove if so.
- **Shared database** (read only): the identity key is installed; the app's role cannot read
  `app.identity_keys`; one SECURITY DEFINER function in `app` or `public` may be run by anyone,
  Supabase's own `public.rls_auto_enable`. It is the function behind Supabase's `ensure_rls` event
  trigger (which turns row-level security on for a new table), so it cannot be called as a plain
  function; harmless, and worth keeping (closes the item in `docs/later/preparation.md`).
- **Closed on 2026-11-24 by the security clean-up** (`docs/later/security-clean-up.md`); as it
  stood then: a database with no identity key still takes the
  app's word. The local databases and the second development project have no key, and the tests
  run there; taking the fallback out waits until every database the tests use has one.

## Left out: needs the founder's account or money

- **Supabase dashboard (free, his account):** raise Supabase Auth's own minimum password length
  to 12 (the app refuses shorter, but Supabase's own API would take one); consider a shorter
  token life than an hour (JWT expiry), which shortens how long a session ended elsewhere runs on.
  Check that TOTP is switched on under Authentication, Multi-factor (it is by default).
- **Vercel settings (his account):** check that the project holds no `SUPABASE_SERVICE_ROLE_KEY`
  or `MIGRATION_DATABASE_URL`; the web app never reads them.
- **Supabase Pro (money):** leaked-password protection (HaveIBeenPwned), and Supabase's own
  session limits (time-boxed and inactivity timeouts), which would end a session at the source
  instead of in the app.
- **SMS codes**: left out at the founder's word.

# The security clean-up after Step 47

Built by the Builder on 2026-11-24, while the founder was asleep, at his word relayed by the
coordinator: five things earlier reviews had found and left, in one joint migration. None of the
five had been closed by Step 47 (its notes say so of the fourth; the one item it did close,
Supabase's `public.rls_auto_enable`, is not among them).

Each is something only a person running SQL of their own as the app's database role could use:
someone holding the web app's database address and password, or a way to inject SQL through the
app (none is known). A signed-in member cannot do any of it from the screens.

## 1. A member could take a document number and throw it away

*As it was* (found by the reviewer of Step 24): any member but the auditor could call
`app.next_document_number('PO', ...)` directly, leaving a gap in a series that is promised to
have none. The function was open to the app's role because a manual journal took its number
through it from the app.

*Now*: the app's role cannot call it at all. Every other caller is a database function that
posts a document and runs as the owner (17 of them, checked), so nothing else changes. The one
number the app still takes for itself is a manual journal's, through a new function,
`app.next_journal_number(date)`, for an owner or an accountant only; and the database refuses
to end a transaction in which a journal number was taken unless a journal of the company
carries it. Taken and not used, the number goes back.

`app.next_document_number` itself is not rewritten (it is on the list of functions that never
are): only who may call it changed.

## 2. An audit row could carry a name that only looks like one the database writes

*As it was*: the audit rows only the database may write (`journal.post`, `sales_order.submit`
and the rest) are protected by their exact names. `'journal.post '` with a space at the end, or
with a capital, or with a letter from another alphabet, went in as the app's role.

*Now*: an audit action has one shape, lower-case words joined by full stops and no more than 80
characters, and the table refuses anything else. Every action the app writes fits (97 in the
code; all 764,591 rows of the Step 50 company; the full test run).

Rows already in the log are not checked (`NOT VALID`): the log cannot be changed, so an old row
that did not fit could not be put right, and the migration must not fail on one. On the shared
development database every existing row was checked before the migration was sent (see "How it
was checked").

## 3. The app's database role had no time limits

*As it was*: a statement that ran away, a statement waiting for a lock that never came, and a
transaction left open all waited for ever. A transaction left open while holding a document
number stops everyone in that company from posting that kind of document.

*Now*, for the app's role in this database: a statement is ended after 60 seconds, a wait for a
lock after 15, and a transaction that has done nothing for 60 seconds is closed.

**What this does not do.** These are the role's starting values. A session running SQL of its
own can set them aside for itself, and can still lock a table: the app's role has to be able to
write the tables it writes, and whoever can write a table can lock it. So this bounds accidents
and forgotten transactions, not an attacker. Closing that needs the app's role to stop being
something a person can connect as (a pooler that accepts only the app, or the database
checking the member's own sign-in token); weigh with Step 51.

The values are for the founder to confirm. The longest report on the Step 50 company takes 2.2
seconds; an export or an import that needed more than 60 seconds for one statement would be
cut, and none does today.

## 4. A database with no key took the app's word

*As it was*: until a key was installed, `app.enter` accepted a call with no proof and the old
settings were still believed. That is what let the proof go in before the app that signs was
deployed, and let a development database run without a secret. It also meant a database that
lost its key believed anyone.

*Now*: `app.enter` always wants a valid proof, and only what was proven is believed. A database
with nothing installed shows nothing to anyone. The question "is a proof wanted?" has one
answer, so the function and the flag that answered it are gone.

**What every working copy has to do**, because the tests run on databases that had no key:
- A local database: `npm run db:local -- <name>` now installs what `.env.local` signs with, and
  says so. Run it once for each local database after this migration reaches it.
- The second development project (the Finisher's): `npm run db:identity -- generate-key` (or
  `generate`), then `npm run db:identity -- install`, **before** this migration is applied
  there. After it, a database with nothing installed fails every database test.
- The shared development database already has its key and is not affected.

## 5. Whoever can read every table of the database could read the key

*As it was*: the proof was signed with a secret the app and the database both hold. The
database's copy sits in `app.identity_keys`, which the app's role cannot read but the owner,
Supabase's own roles and the read-only user the Supabase tools connect as can. A backup carries
it too. With it, and a way to run SQL as the app's role, anyone could say they were anybody.

No way of storing a shared secret closes this: to check the signature the database must hold
what makes it.

*Now, built and not yet switched on*: the app can sign with a **private key**, and the database
checks with the **public half**, which is no secret. Whoever reads the database can check a
proof and cannot make one. The check is RSA with SHA-256 (what Node calls `RSA-SHA256`), done in
the database with its own whole-number arithmetic, so it needs no extension: about a
millisecond, and a proof shown again on the same connection is not worked out again (the app
shows one proof for a minute).

The database accepts both ways at once, and the two are over different texts, so one is never
taken for the other. That is what lets the change be made with no moment in which the site
shows nothing.

**The switch is the founder's**, because it changes a setting of the deployed site:

1. `npm run db:identity -- generate-key` writes `IDENTITY_SIGNING_KEY` to `.env.local` (never
   shown), and `npm run db:identity -- install` puts its public half in the shared database.
   The site goes on as it is: the database now accepts both.
2. Put the same `IDENTITY_SIGNING_KEY` in the site's settings on Vercel and redeploy. Check the
   site. `npm run db:identity -- status` says whether what a working copy signs with is believed.
3. `npm run db:identity -- retire-secret --yes` removes the shared secret from the database. It
   refuses unless the key of this working copy is already installed.
4. Take `IDENTITY_SIGNING_SECRET` out of Vercel and out of every `.env.local`.

Until step 3, this item is open exactly as before: the secret is still in the database.

For going live (Step 51): the real site should start with a key and never have a shared secret;
and its private key should live only in the host's settings, not on a developer's computer.

**The risk taken on here**: checking a signature is written by hand, in SQL. The usual way for
such a check to go wrong is reading the padding apart; this one never reads it, it builds the
whole of what a valid signature must give and compares the two. It is tried against Node's own
signatures and against thirteen things that resemble one (another key, another hash, the other
padding, a bit changed, zero, one, the modulus, the signature plus the modulus, too short, too
long), and it was read by an independent reviewer. It only ever adds a second way in beside the
first; if it were ever doubted, removing the public key (`remove-key`) turns it off.

## Decided without the founder (to confirm)

- The three time limits, and that they are the role's defaults in each database, not a
  cluster-wide setting.
- That old audit rows are left unchecked.
- That a local database gets what `.env.local` signs with. While that is still the shared
  secret, a local database on a developer's computer holds a copy of it, readable by anyone at
  that computer, as `.env.local` is. Moving to the private key ends that: a local database then
  holds only the public half.
- That the fifth item is built to be switched on later, not left out.
- RSA with keys of 2048 bits (3072 and 4096 are accepted), exponent 65537, PKCS #1 v1.5 padding.

## How it was checked

__CHECKED__

# The security clean-up after Step 47

Built by the Builder on 2026-11-24, while the founder was asleep, at his word relayed by the
coordinator: five things earlier reviews had found and left, in one joint migration. None of the
five had been closed by Step 47 (its notes say so of the fourth; the one item it did close,
Supabase's `public.rls_auto_enable`, is not among them).

Each is something only a person running SQL of their own as the app's database role could use:
someone holding the web app's database address and password, or a way to inject SQL through the
app (none is known). A signed-in member cannot do any of it from the screens.

## 1. A member could take a document number and throw it away, and an owner could name one

*As it was* (found by the reviewer of Step 24): any member but the auditor could call
`app.next_document_number('PO', ...)` directly, leaving a gap in a series that is promised to
have none. The function was open to the app's role because a manual journal took its number
through it from the app.

And behind that (found by this migration's own reviewer): the function the app writes a journal
through, `app.post_journal`, wrote on the journal whatever number the caller named. An owner or
an accountant running SQL of their own could post a manual journal under a number that was
never taken; the series then stopped at that number for good, because the next real one found
it used. The same way, they could put another series' next number on an opening journal and
stop that series (cash transfers, say).

*Now*: the app's role cannot call `app.next_document_number` at all. Every other caller is a
database function or trigger that writes a document and runs as the owner (19 of them,
checked), so nothing else changes. And `app.post_journal` gives the number itself: a manual
journal takes the next JV number in the statement that writes the journal, no other journal
written that way carries a number of its own, and a caller that names a number is refused. The
app reads a manual journal's number back from the journal it has just posted.

So there is no longer any way for the app's role to take a number without the document it is
for, or to choose one.

`app.next_document_number` itself is not rewritten (it is on the list of functions that never
are): only who may call it changed. `app.post_journal` (0018) is written again with that one
change.

**Between applying the migration and deploying the app that goes with it, posting a manual
journal fails** (the earlier app names the number, which is now refused; the later app needs the
migration). Nothing else is affected. Apply, then merge straight after.

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
lock after 15, a transaction that has done nothing for 60 seconds is closed, and (on Postgres
17 and later, which the shared database is) a transaction is ended after 5 minutes whatever it
is doing.

**What this does not do.** These are the role's starting values. A session running SQL of its
own can set them aside for itself, and can still lock a table: the app's role has to be able to
write the tables it writes, and whoever can write a table can lock it. So this bounds accidents
and forgotten transactions, not an attacker. Closing that needs the app's role to stop being
something a person can connect as (a pooler that accepts only the app, or the database
checking the member's own sign-in token); weigh with Step 51.

The values are for the founder to confirm. The longest report on the Step 50 company takes 2.2
seconds; an export or an import that needed more than 60 seconds for one statement, or five
minutes in one transaction, would be cut, and none does today.

## 4. A database with no key took the app's word

*As it was*: until a key was installed, `app.enter` accepted a call with no proof and the old
settings were still believed. That is what let the proof go in before the app that signs was
deployed, and let a development database run without a secret. It also meant a database that
lost its key believed anyone.

*Now*: `app.enter` always wants a valid proof, and only what was proven is believed. A database
with nothing installed shows nothing to anyone. The question "is a proof wanted?" has one
answer, so the function and the flag that answered it are gone.

**And who is signed in can be said only in an ordinary transaction** (read committed, which is
all the app ever opens). Found by this migration's reviewer: a transaction that keeps the
picture of the database it began with (repeatable read, serializable), or borrows another's,
went on seeing a key after it had been removed, and a proof made with the removed key was
taken. In an ordinary transaction every statement sees the database as it is now. Three tests
of other steps used such a transaction to show a guard refusing an old picture (SE056); they
are now refused one step earlier, on saying who they are, and say so.

**What every working copy has to do**, because the tests run on databases that had no key:
- A local database: `npm run db:local -- <name>` now installs what `.env.local` signs with, and
  says so. Run it once for each local database after this migration reaches it.
- The second development project (the Finisher's): a shared secret installed **before** this
  migration is applied there (the commands are under "A database that does not have this
  migration yet", below). After it, a database with nothing installed fails every database test.
- The shared development database already has its key and is not affected.

**The file that reverses this migration refuses to run on a database with no shared secret
installed.** Found by the reviewer: the functions it puts back take anyone's word when no
shared secret is there, which is exactly the state this migration aims for once the secret is
retired. It would have turned a database that believes only a key into one that believes
everybody.

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
   refuses unless the key of this working copy is already installed. From then on nothing new
   is believed by the secret, and a transaction already open is stopped at its next statement
   (a statement already running finishes; a cursor already open can still be read from): each
   transaction remembers
   which key its proof was checked against, and the database asks every time whether that key
   is still installed. (Found by the reviewer, and then by trying it: a transaction that had
   said who it was with the secret went on being believed for as long as it was held open, and
   closing the app's connections from outside cannot be relied on.) A transaction caught in
   the middle is stopped with an error, not carried on as nobody: a command half-way through
   must not end half-done. So take a key or a secret out only once the app has stopped signing
   with it; then the only transactions it stops are ones that should not be there.
4. Take `IDENTITY_SIGNING_SECRET` out of Vercel and out of every `.env.local`.

Until step 3, this item is open exactly as before: the secret is still in the database.

`install` puts in only the key's public half when a working copy has a key; a secret still in
its `.env.local` is left out unless asked for (`install --with-secret`), and a working copy
that has only the old secret is refused by a database that holds a key and no secret. Found by
the reviewer: otherwise any working copy with an old line would have put the retired secret back.

The app now opens every transaction as read committed outright, and no longer leaves it to the
connection's default: a connection someone had left set to another default would otherwise
have made the next person's pages come back with nothing (the reviewer's second look).

Known and left: the table of public keys takes any odd number of the right length. It is
written only by the owner of the database, through `install`, which puts in a real key's.

For going live (Step 51): the real site should start with a key and never have a shared secret;
and its private key should live only in the host's settings, not on a developer's computer.

**The risk taken on here**: checking a signature is written by hand, in SQL. The usual way for
such a check to go wrong is reading the padding apart; this one never reads it, it builds the
whole of what a valid signature must give and compares the two. It is tried against Node's own
signatures and against thirteen things that resemble one (another key, another hash, the other
padding, a bit changed, zero, one, the modulus, the signature plus the modulus, too short, too
long), and it was read by an independent reviewer. It only ever adds a second way in beside the
first; if it were ever doubted, removing the public key (`remove-key`) turns it off.

## If the site shows nothing after this migration

`npm run db:identity -- remove <slot> --yes` used to mean "back to taking the app's word". It
no longer does: with nothing installed, nobody is believed. **Never use it to back out.**

1. Look first: `npm run db:identity -- status`, with the settings the site runs with. It says
   what the database holds, and whether an app with these settings is believed.
2. If the database holds nothing, or not what the site signs with: `npm run db:identity -- install`
   with the site's `IDENTITY_SIGNING_SECRET` in `.env.local` puts it in, and the site works from
   the next request. Nothing else needs touching.
3. If the database holds the right thing and the site still shows nothing, the migration is at
   fault. Back out in this order:
   1. Put the previous deployment of the site back (Vercel, Promote the one before).
   2. Run `drizzle/down/0044_security_clean_up.sql` as `postgres`, after showing it and getting a
      yes: `psql "$MIGRATION_DATABASE_URL" -v ON_ERROR_STOP=1 -f drizzle/down/0044_security_clean_up.sql`.
      It refuses unless a shared secret is installed (step 2), because what it puts back takes
      anyone's word when there is none.
   Either order keeps sign-in working, since both versions of the app sign with the shared
   secret and both versions of the database check it. Only posting a manual journal fails
   while the app and the database are of different versions.

## A database that does not have this migration yet (the second development project)

It must be given something to check a proof against before the migration reaches it. Before the
migration a database can only check a shared secret, so, in the working copy whose `.env.local`
points at it, with main merged in:

```
npm run db:identity -- status      # what the database holds, and what this working copy signs with
npm run db:identity -- generate    # only if status says IDENTITY_SIGNING_SECRET is not set here
npm run db:identity -- install     # puts the secret into the database
npm run db:identity -- status      # must end: "An app started with these settings is believed by this database."
npm run db:migrate                 # now the migration
```

A local database: `npm run db:local -- <name>` does the install; then `npm run db:migrate` for
one that already existed.

## Decided without the founder (to confirm)

- The three time limits, and that they are the role's defaults in each database, not a
  cluster-wide setting.
- That old audit rows are left unchecked.
- That a local database gets what `.env.local` signs with. While that is still the shared
  secret, each local database on a developer's computer holds a copy of it, and the local
  server asks for no password: any program running on that computer can read it there, whatever
  the permissions on `.env.local`. It is the same secret the shared development database
  accepts. This is a reason to move the working copies to a private key soon: a local database
  then holds only the public half. The live site (Step 51) must never share a secret or a key
  with a developer's computer.
- That nobody can say who they are in a repeatable-read or serializable transaction. The app
  opens none. A report that wanted one picture of the database across several questions would
  have to ask them in one statement, or through a function.
- That `app.post_journal` is written again, and that the three other steps' tests that named
  journal numbers now take the numbers the database gives (Step 35's sample bank statement names
  `JV-2627-00003` where it named `JV-2627-90003`).
- The fourth time limit (five minutes for a transaction).
- Two things the reviewer noted that are left as they are: an audit action that is a different
  word (`journal.posts`, `journal.post.x`) is a different word, shown as written; and
  `accounts.seed`, which the database writes itself, is not on the reserved list (as before this
  migration; a one-line function for whichever step next touches the chart).
- That the fifth item is built to be switched on later, not left out.
- RSA with keys of 2048 bits (3072 and 4096 are accepted), exponent 65537, PKCS #1 v1.5 padding.

## How it was checked

- **Independent review.** A reviewer who had not seen the work, with SQL of their own as the
  app's role on a database of their own, and a throwaway secret and key so that the real ones
  were never touched. Without the secret or the key they could not become anyone, reach another
  company, or have a signature taken that Node's own check refuses (6,446 signatures and
  near-misses at three key sizes, no disagreement). Nothing critical or high. Three medium
  findings, all put right and tested: the journal number an owner could name (item 1); a
  removed key still taken by a transaction keeping an old picture (item 4); the reversing file
  believing anyone on a key-only database (item 4). And smaller ones, put right: `install`
  putting a retired secret back; the key check failing (safely) in a session that had changed
  how it reads backslashes; no time limit on the migration's own wait for a lock; no time limit
  on a whole transaction.
- The same reviewer looked twice more, at each round of changes, the last time at the final
  text with real separate sessions: a key taken out while a transaction is open (four ways),
  whether the stop can be turned on anyone else, the reversing file, and `install` in all
  sixteen combinations of what a working copy has and what a database holds. Nothing broke.
  Their closing judgement: nothing here should stop it going to the shared development database.
- Not covered by a test: that the app's saying "read committed" outright gets it past a
  connection left with another default (the reviewer tried it by hand, and it does).
- Local database: migration rules, types, lint and the full test run pass; and the full test
  run passes again with the app signing by private key against a database holding only the
  public half.
- The file that reverses the migration was run on a scratch copy: every function it puts back
  is byte for byte what it was; and on a copy with no shared secret it refuses.
- The shared development database, read only, before the migration was sent: none of its 283
  audit rows would fail the new shape; its owner may set the app's role's limits; every caller
  of the numbering function runs as the owner; it is Postgres 17.6.
- The full browser suite against the shared database runs after the migration is applied there.

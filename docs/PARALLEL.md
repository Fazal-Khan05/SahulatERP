# Building in three tracks

Steps 0 to 20 were built one after another. Steps 21 to 46 can be built by three people at
once, each with their own Claude Code session. This file is how that works without the three
getting in each other's way. Read it before starting a step in a track.

Building alone, one step after another, needs none of this: do the next step as before, start
its migration with `-- track: joint`, and keep its notes in `docs/later/step-NN.md`. The parts
under "Adding to a list the whole app shares" are still the way to add a journal kind, a locked
account, a numbered document or protected audit rows.

The promise it keeps: when a track's work is merged into `main`, nothing another track did is
lost, changed or broken, and nobody has to untangle a conflict by hand.

## The tracks

Do the steps of your track in the order written. A step in brackets waits for another track
(see "Waits").

| Track | What it is | Steps, in order | Its file in `src/tracks` |
| --- | --- | --- | --- |
| A | Selling and collecting | 21, 22, 23, 32, 33, 43, 44, 45, (46) | `selling.ts` |
| B | Stock and buying | 30, 24, 25, 26, 27, 28, 29, (31) | `stock.ts` |
| C | Bank, commissions and payroll | 37, 40, 34, (35), (38), (39), (41), 42 | `money.ts` |
| joint | Everyone, one step at a time, after the tracks | 36, 47, 48, 49, 50, 51, 52 | none |

Accounting-check steps (see docs/PROMPTS.md): 32 is in track A; 25 and 28 in track B; 41 in
track C.

### Waits

A step that needs something from another track waits until that step is **merged into main**.

| Step | Track | Waits for |
| --- | --- | --- |
| 31 | B | 21 (A): returned goods are part of stock movement and item profit |
| 34 | C | 25 (B): an expense withholds tax with the rules Step 25 builds |
| 35 | C | 32 (A) and 26 (B): bank reconciliation matches receipts and supplier payments |
| 38 | C | 21 and 32 (A): commission is reversed on a return and released on a collection |
| 39 | C | 23 (A): statements are printed with the print and PDF parts Step 23 builds |
| 41 | C | 23 (A) and 38 (C) |
| 46 | A | 25 (B): the sales-tax return needs purchases and input tax |

If your next step is waiting, do the next one in your track that is not, and come back.

### Things one track builds and another uses

- **Exchange gain or loss** is built by track A in Step 22 (settling a foreign-currency
  invoice). Track B uses the same rule in Step 26 and does not write a second one.
- **Stock** belongs to track B: the tables `stock_moves` and `stock_balances` and the function
  `app.move_stock`. Track A's sales return (Step 21) puts goods back by calling
  `app.move_stock` as it stands. If it needs changing, track B changes it (see "Changing
  something shared").
- **Reacting to another track's document.** Commission is accrued when an invoice is posted and
  reversed when a cheque bounces, in the same transaction. Track C does this with a trigger of
  its own on track A's table, added in track C's migration. It never edits track A's posting
  function. The same goes for any track that must act when another track's document changes.
  The track that owns the table lists, in its step notes, the columns and status changes others
  may rely on, and does not rename them afterwards.

## What belongs to whom

| | Track A | Track B | Track C |
| --- | --- | --- | --- |
| Modules (`src/modules/…`) | `sales`, and new ones for receipts, recovery and FBR | `inventory`, and new ones for purchases and imports | new ones for bank and cash, commissions and payroll |
| Screens (`src/app/(app)/…`) | `sales`, and new folders of its own | new folders of its own | new folders of its own |
| Shared lists | `src/tracks/selling.ts` | `src/tracks/stock.ts` | `src/tracks/money.ts` |
| Needs attention | `inbox/_sources/selling.ts` | `inbox/_sources/stock.ts` | `inbox/_sources/money.ts` |
| Database tables | `sales_*`, and new ones of its own | `stock_*`, and new ones of its own | new ones of its own |
| Database error codes | `SE100` to `SE199` | `SE200` to `SE299` | `SE300` to `SE399` |
| Git branch | `track-a` | `track-b` | `track-c` |

Everything else is shared and finished: `src/modules/{tenant,ledger,numbering,tax,parties,items,prices,currencies,reports,setup,opening,manual-journals,jobs,files}`,
`src/db`, `src/lib`, `src/components`, `tests/support`, `e2e/support`, and every migration up
to `0019`. A track reads and calls these freely. It does not edit them, with the one exception
described under "Changing something shared".

New folders and new tables get names nobody else would pick: say what they are (`receipts`,
`purchase_orders`, `payroll_runs`), not something general (`documents`, `entries`).

## Adding to a list the whole app shares

Seven lists used to be written in one place each, so every step edited the same lines. Each now
reads from the three track files, and a track adds to its own file only.

| You need | In your file in `src/tracks` | In your migration |
| --- | --- | --- |
| A permission (`can(role, "receipt.manage")`) | add it to `permissions` | policies on your own tables |
| A menu entry to lead somewhere | set its address in `links` (the entry is already in the menu, greyed out) | |
| A report on the Reports page | add it to `reports` | |
| Something in "Needs attention" | return it from `waiting` in your `inbox/_sources` file | |
| A journal for a new kind of document | | `app.journal_backed_<source type>(journal)`, and `app.reversal_backed_<source type>(reversal, original)` if it can be reversed |
| A locked account that the standard chart lacks | add it to `controls` | `app.chart_extra_<name>()`, and an `INSERT` that gives the account to companies that already have a chart |
| A new kind of numbered document | add its two letters to `documents` | `app.document_type_<two letters>()` |
| Audit rows that only your database functions write | | `app.audit_reserved_<thing>(action)` |

The opening comment of `drizzle/0019_journal_documents.sql` describes the five database
functions, and each has a test that shows one being added: search the tests for `_zz`.
Every function a migration creates is followed by `REVOKE ALL ON FUNCTION app.<name>(...) FROM
PUBLIC;`: a new function can otherwise be called by anyone. `npm run check` refuses a migration
that leaves it out.

A file in `src/tracks` holds plain lists and nothing else. It imports types only (`import type`),
never a value from a module: the modules read these files, and a file that read a module back
would go round in a circle.
The standard chart already has locked accounts for advances, goods received not invoiced,
withholding, payroll, commission, bank charges, exchange differences and stock adjustments, so a
new one is rarely needed: look in `drizzle/0018_sales_invoices.sql` first.

The menu's words and order (`src/modules/tenant/rules.ts`) stay as they are. If a track needs a
menu entry that does not exist, that is a shared change.

## Working rules

1. **Your own branch.** `track-a`, `track-b` or `track-c`, made from `main`. Never commit to
   `main` directly.
2. **Your own database.** Each person has a Supabase project of their own (the free plan allows
   it) and puts its details in their own `.env.local`; `.env.example` lists what is needed, and
   `npm run db:migrate` then `npm run db:runtime-password` set it up. Nobody but the founder
   holds the connection details of the shared development database, and it receives only what
   is on `main`: the founder's session runs `npm run db:migrate` against it after each merge.
3. **Take main in every day**, and always before starting a step: `git fetch`, then
   `git merge origin/main`. Small merges often are easy; one big merge at the end is not. If
   main has a migration you do not have and you have one main does not, a plain merge is the
   wrong tool: see "When main has a migration you do not".
4. **Merge a step when it is done**, not several at once. One person merges at a time: say so
   to the other two before you start and when you have finished.
5. **Every migration from `0020` on says whose it is.** Its opening comment has a line of its
   own: `-- track: A` (or `B`, `C`, `joint`). `npm run check` refuses it otherwise.
6. **Never change a function, policy or trigger that another track wrote**: not by writing it
   out again, not by altering or dropping it. `npm run check` finds this when the tracks meet.
   The functions that hold the shared lists are never changed by a track: add a function of
   your own, as the table above says. A trigger of your own on another track's table has a name
   that starts with what it is for (`receipts_commission`, not `receipts_after`).
7. **Notes go in a file of the step's own**: `docs/later/step-NN.md`, not `docs/LATER.md`. Tax
   questions for an adviser go in the same file under their own heading, not in
   `docs/RATES-REVIEW.md`. Both of those files are for the founder's session to gather into at
   the end.
8. **`docs/PLAN.md` is marked at the merge**, as the last thing after main has been taken in,
   so two people never mark neighbouring lines from old copies of the file.
9. **Tests clean up after themselves** by removing the companies they made. The list of tables
   to empty is read from the database, so there is nothing to add when you add a table. It
   relies on the rule in CLAUDE.md: every table has `tenant_id`. Two tables that each point at
   the other need one of the two keys `DEFERRABLE`, or their rows cannot be removed.
10. Everything in CLAUDE.md still holds, in every track.

## Merging a step into main

1. `git fetch`, `git merge origin/main`. If main has a migration you do not have and you have
   one main does not, do "When main has a migration you do not" below instead of a plain merge.
2. `npm run db:migrate` on your own database, then `npm run check` and `npm run test:e2e`.
   Everything passes, including the other tracks' tests.
3. Mark the step done in `docs/PLAN.md`. Commit.
4. Push your branch and open a pull request into `main`. When its check is green, merge it.
5. Tell the founder, whose session then applies the migration to the shared database, and tell
   the other two that main has moved.

## When main has a migration you do not

You made `0020_receipts`; meanwhile someone merged their own `0020_purchase_orders`. The two have
the same number, and yours was made without knowing the other's tables. Do not rename files by
hand. Two things go wrong silently if you do: a database skips a migration whose date is older
than one it already has, and the next migration you generate would try to create the other
track's tables again.

```bash
npm run db:set-aside
```

It takes your migration out of the folder and prints what comes next. First:

```bash
npm run db:undo-aside
```

It names the database in your `.env.local` and shows which down file it would run there to take
your migration out again; it runs it only when you repeat the command with `-- --yes`. That
database must be **your own**. Then commit, `git merge origin/main`, and

```bash
npm run db:put-back
```

which makes your migration again as the next number, on top of main's, with the SQL you wrote.
If it prints "LOOK AT THIS BEFORE GOING ON", main changed a table your migration also touches:
read what it shows and decide whether your SQL needs it. Then:

```bash
npm run check:migrations
```

```bash
npm run db:migrate
```

and run the tests. Each of the three commands can be run again if it stopped half-way. This was
rehearsed on 2026-11-13 with two made-up migrations: a plain merge conflicted in the journal and
the snapshot; this way merged cleanly and both applied in order, also after a put-back that was
stopped half-way.

`npm run check:migrations` is part of `npm run check`, so GitHub runs it on every push. It
refuses: a migration out of order or with a date older than its neighbour, two with one number,
a file the journal does not name, a snapshot that does not follow the one before, a down file
that names the wrong migration, a migration still set aside, a migration that does not say
whose it is, a new function left callable by anyone, and a function, policy or trigger changed
by two tracks. It reads the SQL as text, so it cannot see everything: a `-- track: joint` line is
taken on trust, and it does not compare the tables in the code with the migrations.

## Changing something shared

Sometimes a track really does need a change in shared code: a new column on `customers`, a new
entry in the menu, a fix in the posting engine. Two tracks making such changes on their own
branches is exactly how conflicts happen, so it goes through main, alone:

1. Tell the other two what you are about to change and why.
2. Make only that change, on a short branch from the latest `main` (not on your track branch).
   If it has a migration, its line is `-- track: joint`.
3. `npm run check`, pull request, merge, and the founder's session applies it to the shared
   database.
4. Everyone takes main in before going on.

If `npm run check` says two tracks changed the same function, policy or trigger, the later
migration must contain everything the earlier one put there. Once it does, add the line the
message gives you (`-- builds on 00NN_name: app.function`) to the later migration.

## Known and accepted

- **Who is signed in is taken on trust inside the database.** A session running as the app's
  role could claim to be another member. Rewriting every table's rules would not close this,
  because the claim itself is what is trusted. The fix is central and belongs to Step 47; it is
  written up in `docs/later/preparation.md`. No track should try to fix it on its own.

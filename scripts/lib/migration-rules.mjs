// What must be true of the migrations folder, checked on every push (npm run check). Pure: the
// caller reads the files. The rules exist because three people now add migrations at once
// (docs/PARALLEL.md), and each of these mistakes is silent until it reaches a real database:
//
//   - drizzle applies a migration only if its "when" is later than the last one applied, so a
//     migration merged with an older "when" than its neighbour is skipped without a word;
//   - a snapshot that does not follow the one before it makes the next generated migration
//     create tables that already exist;
//   - a function written out again by two people from the same starting point loses, in
//     whichever migration runs second, everything the first one added.

/** The first migration built in a track. Every migration from here on says whose it is. */
export const FIRST_TRACKED = 20;
export const TRACK_NAMES = ["A", "B", "C", "joint"];

/** The four that only ask (drizzle/0019_journal_documents.sql). A track adds a function of its own instead. */
export const NEVER_REWRITTEN = ["app.check_journal_backed", "app.seed_accounts", "app.next_document_number", "app.check_audit_row", "app.audit_action_reserved"];

const NO_SNAPSHOT = "00000000-0000-0000-0000-000000000000";
const number = (idx) => String(idx).padStart(4, "0");

/** Without comments, so that a function named in a comment is not taken for one being written. */
function code(sql) {
  return sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, "");
}

const NAME = '"?([a-z0-9_]+)"?';
const IN_PUBLIC = '(?:"?public"?\\s*\\.\\s*)?';
const FUNCTION = new RegExp(`\\b(CREATE(?:\\s+OR\\s+REPLACE)?|ALTER|DROP)\\s+(?:FUNCTION|PROCEDURE)\\s+(?:IF\\s+EXISTS\\s+)?"?app"?\\s*\\.\\s*${NAME}`, "gi");
const POLICY = new RegExp(`\\b(?:CREATE|ALTER|DROP)\\s+POLICY\\s+(?:IF\\s+EXISTS\\s+)?${NAME}\\s+ON\\s+${IN_PUBLIC}${NAME}`, "gi");
const TRIGGER = new RegExp(`\\b(?:CREATE(?:\\s+OR\\s+REPLACE)?(?:\\s+CONSTRAINT)?|DROP)\\s+TRIGGER\\s+(?:IF\\s+EXISTS\\s+)?${NAME}\\b[^;]*?\\bON\\s+${IN_PUBLIC}${NAME}`, "gi");

/**
 * The functions, policies and triggers a migration creates, changes or drops:
 * "app.post_journal", "policy sales_documents_select on sales_documents",
 * "trigger sales_documents_check on sales_documents".
 */
export function definitions(sql) {
  const text = code(sql);
  const found = new Set();
  for (const match of text.matchAll(FUNCTION)) found.add(`app.${match[2]}`.toLowerCase());
  for (const match of text.matchAll(POLICY)) found.add(`policy ${match[1]} on ${match[2]}`.toLowerCase());
  for (const match of text.matchAll(TRIGGER)) found.add(`trigger ${match[1]} on ${match[2]}`.toLowerCase());
  return [...found].sort();
}

/** The functions in schema app that a migration creates (not ones it only changes or drops). */
function created(sql) {
  return [...new Set([...code(sql).matchAll(FUNCTION)].filter((match) => /^CREATE/i.test(match[1])).map((match) => `app.${match[2]}`.toLowerCase()))];
}

/** Whether the migration takes the function away from everyone: REVOKE ... app.name ... FROM PUBLIC. */
function revoked(sql, thing) {
  const name = thing.slice(4);
  return new RegExp(`\\bREVOKE\\b[^;]*"?app"?\\s*\\.\\s*"?${name}"?\\s*\\([^;]*\\bFROM\\b[^;]*\\bPUBLIC\\b`, "i").test(code(sql));
}

/** The track a migration says it belongs to, from a line "-- track: A" among its opening comments. */
export function trackOf(sql) {
  for (const line of sql.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    if (!trimmed.startsWith("--")) break;
    const match = /^--\s*track:\s*(\S+)\s*$/i.exec(trimmed);
    if (match) return TRACK_NAMES.find((name) => name.toLowerCase() === match[1].toLowerCase()) ?? match[1];
  }
  return null;
}

/**
 * The migrations folder as read from disk: the journal's entries; every drizzle/NNNN_name.sql
 * and every drizzle/down/NNNN_name.sql by its name without ".sql"; the id and prevId of every
 * drizzle/meta/NNNN_snapshot.json by "NNNN".
 *
 * @typedef {object} MigrationFiles
 * @property {{ idx: number, when: number, tag: string }[]} journal
 * @property {Record<string, string>} sql
 * @property {Record<string, string>} down
 * @property {Record<string, { id: string, prevId: string }>} snapshots
 * @property {boolean} [aside] whether drizzle/.aside exists
 */

/**
 * @param {MigrationFiles} files
 * @returns {string[]} what is wrong, in words; empty when nothing is
 */
export function checkMigrations({ journal, sql, down, snapshots, aside = false }) {
  const problems = [];
  if (aside) problems.push("A migration is set aside (drizzle/.aside) and has not been put back. After merging main, run: npm run db:put-back");
  const tags = new Set(journal.map((entry) => entry.tag));

  // ── the journal: one unbroken, ordered list ─────────────────────────────────────────────────
  journal.forEach((entry, position) => {
    if (entry.idx !== position) problems.push(`${entry.tag}: the journal gives it idx ${entry.idx}, but it is entry ${position}. Entries are numbered from 0 without gaps.`);
    if (!new RegExp(`^${number(position)}_[a-z0-9_]+$`).test(entry.tag)) problems.push(`${entry.tag}: entry ${position} of the journal must be named ${number(position)}_<name>.`);
    const before = journal[position - 1];
    if (before && !(entry.when > before.when)) {
      problems.push(`${entry.tag}: its "when" (${entry.when}) is not later than that of ${before.tag} (${before.when}). A database that already has ${before.tag} would skip ${entry.tag} without saying so. Give it a new "when" (docs/PARALLEL.md, "When main has a migration you do not").`);
    }
  });
  if (tags.size !== journal.length) problems.push("The journal names the same migration twice.");

  // ── the files the journal names, and no others ──────────────────────────────────────────────
  for (const entry of journal) {
    if (!(entry.tag in sql)) problems.push(`${entry.tag}: the journal names it, but drizzle/${entry.tag}.sql is missing.`);
    if (!(entry.tag in down)) problems.push(`${entry.tag}: drizzle/down/${entry.tag}.sql is missing. Every migration has a file that reverses it.`);
  }
  for (const name of Object.keys(sql)) if (!tags.has(name)) problems.push(`drizzle/${name}.sql is not in the journal, so it would never be applied.`);
  for (const name of Object.keys(down)) if (!tags.has(name)) problems.push(`drizzle/down/${name}.sql reverses a migration the journal does not have.`);

  // ── a down file removes its own migration's row, by that migration's "when" ─────────────────
  for (const entry of journal) {
    const text = down[entry.tag];
    if (text === undefined || entry.idx === 0) continue;
    const named = [...text.matchAll(/__drizzle_migrations\s+WHERE\s+created_at\s*=\s*(\d+)/gi)].map((match) => Number(match[1]));
    if (named.length !== 1 || named[0] !== entry.when) {
      problems.push(`drizzle/down/${entry.tag}.sql must remove exactly the row with created_at = ${entry.when} (the migration's "when"); it names ${named.length === 0 ? "none" : named.join(", ")}.`);
    }
  }

  // ── snapshots: one for each migration, each following the one before ────────────────────────
  const seen = new Map();
  journal.forEach((entry, position) => {
    const snapshot = snapshots[number(position)];
    if (!snapshot) {
      problems.push(`${entry.tag}: drizzle/meta/${number(position)}_snapshot.json is missing.`);
      return;
    }
    if (seen.has(snapshot.id)) problems.push(`${entry.tag}: its snapshot has the same id as that of ${seen.get(snapshot.id)}.`);
    seen.set(snapshot.id, entry.tag);
    const expected = position === 0 ? NO_SNAPSHOT : snapshots[number(position - 1)]?.id;
    if (expected !== undefined && snapshot.prevId !== expected) {
      problems.push(`${entry.tag}: its snapshot does not follow the one before it (prevId ${snapshot.prevId}, expected ${expected}). The next generated migration would be wrong. Make the migration again on top of main (docs/PARALLEL.md).`);
    }
  });
  for (const name of Object.keys(snapshots)) if (Number(name) >= journal.length) problems.push(`drizzle/meta/${name}_snapshot.json belongs to no migration in the journal.`);

  // ── from the first tracked migration on: whose it is, and what it may write out again ───────
  /** @type {Map<string, { tag: string, idx: number, track: string | null }>} */
  const lastWriter = new Map();
  for (const entry of journal) {
    const text = sql[entry.tag];
    if (text === undefined) continue;
    const tracked = entry.idx >= FIRST_TRACKED;
    const track = tracked ? trackOf(text) : null;
    if (tracked && !TRACK_NAMES.includes(track ?? "")) {
      problems.push(`${entry.tag}: its opening comment must say whose it is, on a line of its own: "-- track: A", "-- track: B", "-- track: C" or "-- track: joint".`);
    }
    const fresh = created(text);
    for (const thing of definitions(text)) {
      const before = lastWriter.get(thing);
      lastWriter.set(thing, { tag: entry.tag, idx: entry.idx, track });
      // A new function can be called by anyone until that is taken away.
      if (tracked && !before && fresh.includes(thing) && !NEVER_REWRITTEN.includes(thing) && !revoked(text, thing)) {
        problems.push(`${entry.tag}: creates ${thing} and leaves it callable by anyone. Follow it with: REVOKE ALL ON FUNCTION ${thing}(...) FROM PUBLIC;`);
      }
      if (!tracked || track === "joint") continue;
      if (NEVER_REWRITTEN.includes(thing)) {
        problems.push(`${entry.tag}: changes ${thing}. That function only asks; add a function of your own instead (the opening comment of drizzle/0019_journal_documents.sql says which).`);
        continue;
      }
      // Written before by another track: the one that runs second must have been written on top of the first.
      if (before && before.idx >= FIRST_TRACKED && before.track !== track && !builtOn(text, before.tag, thing)) {
        problems.push(
          `${entry.tag} (track ${track}) changes ${thing}, and so did ${before.tag} (track ${before.track}). Whatever ${before.tag} put there is lost unless this one was written on top of it. Check that it was, then add this line to ${entry.tag}: "-- builds on ${before.tag}: ${thing}"`,
        );
      }
    }
  }
  return problems;
}

function builtOn(sql, tag, thing) {
  const wanted = `builds on ${tag}: ${thing}`.toLowerCase();
  return sql.split("\n").some((line) => line.trim().startsWith("--") && line.toLowerCase().replace(/\s+/g, " ").includes(wanted));
}

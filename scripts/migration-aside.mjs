// npm run db:set-aside, npm run db:undo-aside, merge main, npm run db:put-back.
//
// For when main has a migration your branch does not, and your branch has one main does not
// (docs/PARALLEL.md, "When main has a migration you do not"). Both were made on top of the same
// earlier migration, so they have the same number, and yours was generated without knowing the
// other's tables. Merging them by hand goes wrong quietly: a wrong order is skipped by the
// database without a word, and a stale snapshot makes the next migration create tables twice.
//
//   set-aside   takes your migration out of the folder (kept in drizzle/.aside), so that the
//               folder is exactly as main's was when you started and main merges in cleanly.
//   undo-aside  takes the set-aside migration out of YOUR OWN database again, with its down
//               file, so that main's migration and then yours can go in, in that order. It
//               shows what it would do; it does it only with --yes.
//   put-back    after the merge: makes your migration again as the next number, on top of
//               main's, with a new snapshot and a new "when", and with the SQL you wrote.
//
// Each can be run again if it stopped half-way. None runs git commit or git merge: you do those
// between them. Only undo-aside touches a database.
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const drizzle = join(root, "drizzle");
const aside = join(drizzle, ".aside");
const journalPath = join(drizzle, "meta", "_journal.json");
const listPath = join(aside, "aside.json");

const readJournal = () => JSON.parse(readFileSync(journalPath, "utf8"));
const readList = () => JSON.parse(readFileSync(listPath, "utf8"));
const writeList = (items) => writeFileSync(listPath, `${JSON.stringify(items, null, 2)}\n`);
const number = (idx) => String(idx).padStart(4, "0");
const nameOf = (tag) => tag.slice(5);
const stop = (message) => {
  console.error(`\n${message}\n`);
  process.exit(1);
};

/** The journal on main, as last fetched. */
function mainJournal() {
  try {
    execFileSync("git", ["fetch", "--quiet", "origin", "main"], { cwd: root, stdio: "ignore" });
  } catch {
    console.warn("Could not reach GitHub; comparing with main as it was last fetched.");
  }
  try {
    return JSON.parse(execFileSync("git", ["show", "origin/main:drizzle/meta/_journal.json"], { cwd: root, encoding: "utf8" })).entries;
  } catch {
    return stop("Could not read main's migrations (git show origin/main:drizzle/meta/_journal.json).");
  }
}

function setAside() {
  const journal = readJournal();
  let items;
  if (existsSync(listPath)) {
    // An earlier run wrote the list and stopped, or finished: finish it, which changes nothing if it had.
    items = readList();
    if (items.some((item) => item.newTag)) stop("A put-back is under way (drizzle/.aside). Run: npm run db:put-back");
  } else {
    const main = mainJournal();
    const mainTags = new Set(main.map((entry) => entry.tag));
    const localTags = new Set(journal.entries.map((entry) => entry.tag));
    const mine = journal.entries.filter((entry) => !mainTags.has(entry.tag));
    const theirs = main.filter((entry) => !localTags.has(entry.tag));
    if (mine.length === 0) return console.log("You have no migration that main lacks. Nothing to set aside: merge main as usual.");
    if (theirs.length === 0) return console.log("Main has no migration that you lack. Nothing to set aside: merge main as usual.");
    // Everything of yours must come after everything you share with main.
    const shared = journal.entries.length - mine.length;
    if (journal.entries.slice(shared).some((entry) => mainTags.has(entry.tag))) stop("Your migrations are not the last ones in the journal. Do not go on by hand: ask for help.");
    // Nothing is moved until everything that must be there is seen to be there.
    for (const entry of mine) {
      for (const file of [join(drizzle, `${entry.tag}.sql`), join(drizzle, "down", `${entry.tag}.sql`)]) if (!existsSync(file)) stop(`${file} is missing. Nothing was changed.`);
      if (!readFileSync(join(drizzle, "down", `${entry.tag}.sql`), "utf8").includes(String(entry.when))) stop(`drizzle/down/${entry.tag}.sql does not name its migration's "when" (${entry.when}). Nothing was changed.`);
    }
    items = mine.map((entry, position) => ({ name: nameOf(entry.tag), tag: entry.tag, idx: entry.idx, when: entry.when, file: `${position + 1}-${nameOf(entry.tag)}` }));
    // Copied first, listed second, removed last: stopping anywhere loses nothing.
    mkdirSync(aside, { recursive: true });
    for (const item of items) {
      copyFileSync(join(drizzle, `${item.tag}.sql`), join(aside, `${item.file}.up.sql`));
      copyFileSync(join(drizzle, "down", `${item.tag}.sql`), join(aside, `${item.file}.down.sql`));
    }
    writeList(items);
    console.log(`Main has ${theirs.map((entry) => entry.tag).join(", ")}, which you do not.`);
  }
  const tags = new Set(items.map((item) => item.tag));
  journal.entries = journal.entries.filter((entry) => !tags.has(entry.tag));
  writeFileSync(journalPath, `${JSON.stringify(journal, null, 2)}\n`);
  for (const item of items) {
    rmSync(join(drizzle, `${item.tag}.sql`), { force: true });
    rmSync(join(drizzle, "down", `${item.tag}.sql`), { force: true });
    rmSync(join(drizzle, "meta", `${number(item.idx)}_snapshot.json`), { force: true });
  }

  console.log(`Set aside: ${items.map((item) => item.tag).join(", ")}.\n`);
  console.log("Next, in this order:");
  console.log("  1. npm run db:undo-aside");
  console.log("     (takes your migration out of YOUR OWN database again; it shows what it would do first)");
  console.log('  2. git add -A && git commit -m "Set my migration aside to merge main"');
  console.log("  3. git merge origin/main");
  console.log("  4. npm run db:put-back");
}

async function undoAside() {
  if (!existsSync(listPath)) stop("Nothing is set aside.");
  const items = readList().filter((item) => !item.newTag).reverse();
  const url = process.env.MIGRATION_DATABASE_URL;
  if (!url) stop("MIGRATION_DATABASE_URL is not set (it is read from .env.local). Nothing was run.");
  const { hostname, port, pathname } = new URL(url);
  const where = `${hostname}${port ? `:${port}` : ""}${pathname}`;
  const { default: postgres } = await import("postgres");
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    const applied = [];
    for (const item of items) {
      const rows = await sql`select 1 from drizzle.__drizzle_migrations where created_at = ${item.when}`;
      if (rows.length > 0) applied.push(item);
    }
    if (applied.length === 0) return console.log(`The database at ${where} does not have your set-aside migration. Nothing to undo.`);
    console.log(`The database at ${where} has: ${applied.map((item) => item.tag).join(", ")}.`);
    if (!process.argv.includes("--yes")) {
      console.log("\nTo take it out again, these files would be run there, in this order:");
      for (const item of applied) console.log(`  drizzle/.aside/${item.file}.down.sql`);
      console.log("\nThey remove what the migration made, with any rows in it. This must be YOUR OWN database, never the shared one.");
      console.log("If it is, run:  npm run db:undo-aside -- --yes");
      return;
    }
    for (const item of applied) {
      await sql.unsafe(readFileSync(join(aside, `${item.file}.down.sql`), "utf8"));
      console.log(`Undone: ${item.tag}`);
    }
  } finally {
    await sql.end();
  }
}

/** The statements of a generated migration, each on one line. */
const statements = (text) =>
  text
    .split("--> statement-breakpoint")
    .map((statement) => statement.replace(/\s+/g, " ").trim())
    .filter((statement) => statement !== "");

function putBack() {
  if (!existsSync(listPath)) stop("Nothing is set aside. Run npm run db:set-aside first, then merge main.");
  const items = readList();
  const main = mainJournal();
  const mainTags = new Set(main.map((entry) => entry.tag));
  const have = new Set(readJournal().entries.map((entry) => entry.tag));
  const lacking = main.filter((entry) => !have.has(entry.tag));
  if (lacking.length > 0) stop(`Main is not merged in yet: you lack ${lacking.map((entry) => entry.tag).join(", ")}. Run: git merge origin/main`);

  // Everything is looked at before anything is made.
  const pending = items.filter((item) => !item.newTag);
  for (const item of pending) {
    for (const end of ["up", "down"]) if (!existsSync(join(aside, `${item.file}.${end}.sql`))) stop(`drizzle/.aside/${item.file}.${end}.sql is missing. Do not go on by hand: ask for help.`);
    if (!readFileSync(join(aside, `${item.file}.down.sql`), "utf8").includes(String(item.when))) stop(`drizzle/.aside/${item.file}.down.sql does not name its migration's "when" (${item.when}). Do not go on by hand: ask for help.`);
  }
  // What the journal holds beyond main must be what earlier runs of this command put back, plus
  // at most one entry that such a run made and did not get to record.
  const done = new Set(items.filter((item) => item.newTag).map((item) => item.newTag));
  const unrecorded = readJournal().entries.filter((entry) => !mainTags.has(entry.tag) && !done.has(entry.tag));
  const adopted = unrecorded.length === 1 && pending[0] && nameOf(unrecorded[0].tag) === pending[0].name ? unrecorded[0] : null;
  if (unrecorded.length > (adopted ? 1 : 0)) {
    stop(`The journal holds migrations that are neither on main nor put back by this command: ${unrecorded.map((entry) => entry.tag).join(", ")}. Do not go on by hand: ask for help.`);
  }

  const differences = [];
  for (const item of pending) {
    let entry = item === pending[0] ? adopted : null;
    if (!entry) {
      const before = readJournal().entries.length;
      // Made again by drizzle-kit, on top of main: the right number, snapshot and "when".
      const generate = (extra) => spawnSync("npx", ["drizzle-kit", "generate", ...extra, "--name", item.name], { cwd: root, stdio: "inherit" });
      const failed = `drizzle-kit could not make ${item.name} again. Nothing of yours is lost: it is still in drizzle/.aside. Put right what it complained of and run npm run db:put-back again.`;
      if (generate([]).status !== 0) stop(failed);
      // A migration with hand-written SQL only changes no table, so drizzle-kit has nothing to generate.
      if (readJournal().entries.length === before && generate(["--custom"]).status !== 0) stop(failed);
      entry = readJournal().entries.at(-1);
      if (readJournal().entries.length !== before + 1 || nameOf(entry.tag) !== item.name) stop(`drizzle-kit did not make ${item.name} as expected. Nothing of yours is lost: it is still in drizzle/.aside. Do not go on by hand: ask for help.`);
    }

    const renamed = (text) => text.replaceAll(item.tag, entry.tag);
    const up = renamed(readFileSync(join(aside, `${item.file}.up.sql`), "utf8"));
    const whole = up.replace(/\s+/g, " ");
    const missing = statements(readFileSync(join(drizzle, `${entry.tag}.sql`), "utf8")).filter((statement) => !statement.startsWith("--") && !whole.includes(statement));
    if (missing.length > 0) differences.push({ tag: entry.tag, missing });
    const down = renamed(readFileSync(join(aside, `${item.file}.down.sql`), "utf8")).replaceAll(String(item.when), String(entry.when));
    writeFileSync(join(drizzle, `${entry.tag}.sql`), up);
    writeFileSync(join(drizzle, "down", `${entry.tag}.sql`), down);
    item.newTag = entry.tag;
    writeList(items);
    console.log(`\n${item.tag} is now ${entry.tag}.`);
  }
  rmSync(aside, { recursive: true });

  if (differences.length > 0) {
    console.log("\nLOOK AT THIS BEFORE GOING ON. Made again on top of main, drizzle-kit wrote statements that your migration does not have:");
    for (const { tag, missing } of differences) {
      console.log(`\n  drizzle/${tag}.sql lacks:`);
      for (const statement of missing) console.log(`    ${statement.slice(0, 200)}`);
    }
    console.log("\nThat happens when main changed a table your migration also touches. Your SQL was kept as you wrote it; decide whether it needs these.");
  }
  console.log("\nNext:");
  console.log("  1. npm run check:migrations");
  console.log("  2. npm run db:migrate      (your own database: main's migration, then yours)");
  console.log("  3. run the tests, then commit");
}

const command = process.argv[2];
if (command === "set-aside") setAside();
else if (command === "undo-aside") await undoAside();
else if (command === "put-back") putBack();
else stop("Usage: node scripts/migration-aside.mjs set-aside | undo-aside [--yes] | put-back");

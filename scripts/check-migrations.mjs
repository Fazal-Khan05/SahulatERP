// npm run check:migrations — is the migrations folder in order? Reads drizzle/ and says what is
// wrong, in words. Part of npm run check, so it runs on every push. It reads files only: no
// database, no network.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { checkMigrations } from "./lib/migration-rules.mjs";

const root = join(import.meta.dirname, "..", "drizzle");
const read = (...parts) => readFileSync(join(root, ...parts), "utf8");
const named = (folder) => Object.fromEntries(readdirSync(join(root, folder)).filter((file) => file.endsWith(".sql")).map((file) => [file.slice(0, -4), read(folder, file)]));

const journal = JSON.parse(read("meta", "_journal.json")).entries;
const snapshots = Object.fromEntries(
  readdirSync(join(root, "meta"))
    .filter((file) => /^\d{4}_snapshot\.json$/.test(file))
    .map((file) => {
      const { id, prevId } = JSON.parse(read("meta", file));
      return [file.slice(0, 4), { id, prevId }];
    }),
);

const problems = checkMigrations({ journal, sql: named("."), down: named("down"), snapshots, aside: existsSync(join(root, ".aside")) });
if (problems.length === 0) {
  console.log(`Migrations in order: ${journal.length}, the last is ${journal.at(-1)?.tag}.`);
} else {
  console.error(`The migrations folder is not in order (${problems.length}):\n`);
  for (const problem of problems) console.error(`  - ${problem}\n`);
  console.error("docs/PARALLEL.md says how each of these is put right.");
  process.exit(1);
}

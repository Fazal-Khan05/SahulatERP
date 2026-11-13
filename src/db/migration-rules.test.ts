import { describe, expect, it } from "vitest";
import { checkMigrations, definitions, trackOf } from "../../scripts/lib/migration-rules.mjs";

// npm run check:migrations, on folders made up for the purpose. Each test is one of the
// mistakes that three people adding migrations at once can make (docs/PARALLEL.md).

type Folder = Parameters<typeof checkMigrations>[0];

const ZERO = "00000000-0000-0000-0000-000000000000";
const tag = (idx: number, name: string) => `${String(idx).padStart(4, "0")}_${name}`;

/** A folder in order: `count` migrations, the ones from 20 on belonging to the tracks given. */
function folder(count: number, tracked: Record<number, { track: string; sql?: string }> = {}): Folder {
  const journal = Array.from({ length: count }, (_, idx) => ({ idx, when: 1000 + idx, tag: tag(idx, `m${idx}`) }));
  const sql: Record<string, string> = {};
  const down: Record<string, string> = {};
  const snapshots: Record<string, { id: string; prevId: string }> = {};
  for (const entry of journal) {
    const own = tracked[entry.idx];
    sql[entry.tag] = (entry.idx >= 20 ? `-- Step.\n-- track: ${own?.track ?? "A"}\n` : "-- Earlier.\n") + (own?.sql ?? "CREATE TABLE x ();\n");
    down[entry.tag] = entry.idx === 0 ? "DELETE FROM drizzle.__drizzle_migrations;" : `DELETE FROM drizzle.__drizzle_migrations WHERE created_at = ${entry.when};`;
    snapshots[entry.tag.slice(0, 4)] = { id: `id-${entry.idx}`, prevId: entry.idx === 0 ? ZERO : `id-${entry.idx - 1}` };
  }
  return { journal, sql, down, snapshots };
}

describe("the migrations folder", () => {
  it("is in order when every migration follows the one before", () => {
    expect(checkMigrations(folder(23, { 20: { track: "A" }, 21: { track: "B" }, 22: { track: "joint" } }))).toEqual([]);
  });

  it("refuses a migration that a database would skip: a 'when' not later than the one before", () => {
    const files = folder(22);
    files.journal[21].when = files.journal[20].when - 5;
    files.down[files.journal[21].tag] = `DELETE FROM drizzle.__drizzle_migrations WHERE created_at = ${files.journal[21].when};`;
    const problems = checkMigrations(files);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("would skip 0021_m21 without saying so");
  });

  it("refuses two migrations with one number, a gap, a stray file and a missing one", () => {
    const twice = folder(21);
    twice.journal.push({ idx: 21, when: 5000, tag: "0020_other" });
    twice.sql["0020_other"] = "-- track: B\n";
    twice.down["0020_other"] = "DELETE FROM drizzle.__drizzle_migrations WHERE created_at = 5000;";
    twice.snapshots["0021"] = { id: "id-other", prevId: "id-20" };
    expect(checkMigrations(twice).join("\n")).toContain("entry 21 of the journal must be named 0021_<name>");

    const stray = folder(21);
    stray.sql["0021_forgotten"] = "-- track: B\n";
    expect(checkMigrations(stray)).toEqual(["drizzle/0021_forgotten.sql is not in the journal, so it would never be applied."]);

    const missing = folder(21);
    delete missing.sql["0020_m20"];
    delete missing.down["0019_m19"];
    expect(checkMigrations(missing)).toEqual([
      "0019_m19: drizzle/down/0019_m19.sql is missing. Every migration has a file that reverses it.",
      "0020_m20: the journal names it, but drizzle/0020_m20.sql is missing.",
    ]);
  });

  it("refuses a down file that would remove another migration's row", () => {
    const files = folder(21);
    files.down["0020_m20"] = "DELETE FROM drizzle.__drizzle_migrations WHERE created_at = 1019;";
    expect(checkMigrations(files)).toEqual(['drizzle/down/0020_m20.sql must remove exactly the row with created_at = 1020 (the migration\'s "when"); it names 1019.']);
  });

  it("refuses a snapshot that does not follow the one before it", () => {
    const files = folder(22);
    // As after a merge: 0021 was generated on top of 0019, before 0020 arrived.
    files.snapshots["0021"].prevId = "id-19";
    const problems = checkMigrations(files);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("0021_m21: its snapshot does not follow the one before it");
  });

  it("takes a migration that names no track as built alone, and refuses a track that does not exist", () => {
    const files = folder(22);
    // Built alone, one step after another: no line, and free to change what an earlier step wrote.
    const rewrite = "CREATE OR REPLACE FUNCTION app.post_delivery(p uuid) RETURNS void LANGUAGE sql AS 'select 1';\nREVOKE ALL ON FUNCTION app.post_delivery(uuid) FROM PUBLIC;\n";
    files.sql["0020_m20"] = `-- Step 21.\n${rewrite}`;
    files.sql["0021_m21"] = `-- Step 22.\n${rewrite}`;
    expect(checkMigrations(files)).toEqual([]);
    expect(trackOf(files.sql["0020_m20"])).toBeNull();
    // A line after the SQL has begun is not read as the migration's track.
    expect(trackOf("-- Step 21.\nCREATE TABLE y ();\n-- track: A\n")).toBeNull();
    files.sql["0020_m20"] = "-- Step 21.\n-- track: D\nCREATE TABLE y ();\n";
    expect(checkMigrations(files)).toHaveLength(1);
    expect(checkMigrations(files)[0]).toContain('names a track that does not exist ("D")');
    // A track still may not change what a migration built alone before it wrote... unless it says so.
    files.sql["0020_m20"] = `-- Step 21.\n${rewrite}`;
    files.sql["0021_m21"] = `-- Step 22.\n-- track: B\n${rewrite}`;
    expect(checkMigrations(files)).toHaveLength(1);
  });

  it("refuses a function two tracks have each written out again, until the second says it was written on top of the first", () => {
    const rewrite = "CREATE OR REPLACE FUNCTION app.post_delivery(p uuid) RETURNS void LANGUAGE sql AS 'select 1';\nREVOKE ALL ON FUNCTION app.post_delivery(uuid) FROM PUBLIC;\n";
    const files = folder(23, { 20: { track: "B", sql: rewrite }, 21: { track: "B", sql: rewrite }, 22: { track: "A", sql: rewrite } });
    const problems = checkMigrations(files);
    // The same track writing its own function again is its own business.
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("0022_m22 (track A) changes app.post_delivery, and so did 0021_m21 (track B)");
    files.sql["0022_m22"] = `-- track: A\n-- builds on 0021_m21: app.post_delivery\n${rewrite}`;
    expect(checkMigrations(files)).toEqual([]);
    // Naming an older migration than the last one to write it is not enough.
    files.sql["0022_m22"] = `-- track: A\n-- builds on 0020_m20: app.post_delivery\n${rewrite}`;
    expect(checkMigrations(files)).toHaveLength(1);
  });

  it("holds policies to the same rule, and lets the joint steps at the end write anything", () => {
    const policy = 'DROP POLICY sales_documents_select ON public.sales_documents;\nCREATE POLICY "sales_documents_select" ON "sales_documents" FOR SELECT TO app_runtime USING (true);\n';
    expect(checkMigrations(folder(22, { 20: { track: "A", sql: policy }, 21: { track: "C", sql: policy } }))).toHaveLength(1);
    expect(checkMigrations(folder(22, { 20: { track: "A", sql: policy }, 21: { track: "joint", sql: policy } }))).toEqual([]);
  });

  it("never lets a track write out again one of the functions that only ask", () => {
    const files = folder(21, { 20: { track: "C", sql: "CREATE OR REPLACE FUNCTION app.seed_accounts(p_template text) RETURNS integer LANGUAGE sql AS 'select 1';\n" } });
    const problems = checkMigrations(files);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("add a function of your own instead");
    // Its own function beside them is what is asked for.
    const own = "CREATE FUNCTION app.chart_extra_payroll() RETURNS TABLE (code text) LANGUAGE sql AS 'select 1';\n";
    expect(checkMigrations(folder(21, { 20: { track: "C", sql: `${own}REVOKE ALL ON FUNCTION app.chart_extra_payroll() FROM PUBLIC;\n` } }))).toEqual([]);
    // Dropping or altering one of the four is refused like writing it out again.
    expect(checkMigrations(folder(21, { 20: { track: "C", sql: "DROP FUNCTION app.check_audit_row();\n" } }))).toHaveLength(1);
    expect(checkMigrations(folder(21, { 20: { track: "C", sql: "ALTER FUNCTION app . next_document_number(text, date) SECURITY INVOKER;\n" } }))).toHaveLength(1);
  });

  it("refuses a new function left callable by anyone", () => {
    const create = "CREATE FUNCTION app.journal_backed_receipt(p public.journals) RETURNS boolean LANGUAGE sql SECURITY DEFINER AS 'select true';\n";
    const problems = checkMigrations(folder(21, { 20: { track: "A", sql: create } }));
    expect(problems).toEqual(["0020_m20: creates app.journal_backed_receipt and leaves it callable by anyone. Follow it with: REVOKE ALL ON FUNCTION app.journal_backed_receipt(...) FROM PUBLIC;"]);
    // One REVOKE may name several functions; a REVOKE of another function does not count.
    const two = `${create}CREATE FUNCTION app.reversal_backed_receipt(r public.journals, o public.journals) RETURNS boolean LANGUAGE sql AS 'select true';\n`;
    expect(checkMigrations(folder(21, { 20: { track: "A", sql: `${two}REVOKE ALL ON FUNCTION\n  app.journal_backed_receipt(public.journals), app.reversal_backed_receipt(public.journals, public.journals)\n  FROM PUBLIC;\n` } }))).toEqual([]);
    expect(checkMigrations(folder(21, { 20: { track: "A", sql: `${two}REVOKE ALL ON FUNCTION app.reversal_backed_receipt(public.journals, public.journals) FROM PUBLIC;\n` } }))).toHaveLength(1);
    // The joint steps are held to this too.
    expect(checkMigrations(folder(21, { 20: { track: "joint", sql: create } }))).toHaveLength(1);
  });

  it("holds triggers to the same rule: two tracks may not each replace one trigger", () => {
    const trigger = (fn: string) => `DROP TRIGGER receipts_after ON public.receipts;\nCREATE CONSTRAINT TRIGGER receipts_after AFTER INSERT OR UPDATE OF status ON public.receipts DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.${fn}();\n`;
    const problems = checkMigrations(folder(22, { 20: { track: "A", sql: trigger("a") }, 21: { track: "C", sql: trigger("c") } }));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("changes trigger receipts_after on receipts");
    // A trigger of its own name on another track's table is what a track is meant to add.
    expect(checkMigrations(folder(22, { 20: { track: "A", sql: trigger("a") }, 21: { track: "C", sql: trigger("c").replaceAll("receipts_after", "receipts_commission") } }))).toEqual([]);
  });

  it("refuses a folder with a migration still set aside", () => {
    expect(checkMigrations({ ...folder(21), aside: true })).toEqual(["A migration is set aside (drizzle/.aside) and has not been put back. After merging main, run: npm run db:put-back"]);
  });

  it("reads what a migration writes, and not what its comments mention", () => {
    expect(
      definitions(`-- CREATE OR REPLACE FUNCTION app.mentioned() is not written here.
        CREATE FUNCTION app.journal_backed_receipt(p public.journals) RETURNS boolean LANGUAGE sql AS 'select true';
        create or replace function "app"."move_stock"() returns void language sql as 'select 1';
        /* CREATE FUNCTION app.also_mentioned() */
        ALTER POLICY receipts_update ON receipts USING (true);
        DROP FUNCTION IF EXISTS app.old_one(uuid);
        CREATE OR REPLACE
          FUNCTION app.spread_over_lines() RETURNS void LANGUAGE sql AS 'select 1';
        CREATE TRIGGER receipts_check BEFORE INSERT OR UPDATE ON public.receipts FOR EACH ROW EXECUTE FUNCTION app.check_receipt();
        CREATE POLICY receipts_select ON public.receipts FOR SELECT USING (true);`),
    ).toEqual([
      "app.journal_backed_receipt",
      "app.move_stock",
      "app.old_one",
      "app.spread_over_lines",
      "policy receipts_select on receipts",
      "policy receipts_update on receipts",
      "trigger receipts_check on receipts",
    ]);
  });
});

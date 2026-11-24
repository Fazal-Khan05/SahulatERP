import postgres from "postgres";
import { describe, expect, it } from "vitest";

// The app's database role has time limits of its own (the security clean-up after Step 47):
// a statement that runs away, a wait for a lock that never comes, and a transaction left open
// are each ended by the database. They are the role's defaults in this database, so every
// connection of the app starts with them. A session that sets them aside for itself can: they
// bound accidents, not someone running SQL of their own.

const url = process.env.DATABASE_URL;

describe.skipIf(!url)("the app's role and its time limits", () => {
  it("starts every connection with a limit on a statement, on waiting for a lock, and on a transaction left open", async () => {
    const sql = postgres(url!, { max: 1, onnotice: () => {} });
    try {
      const [limits] = await sql`
        select current_user as role,
               (select setting::int from pg_settings where name = 'statement_timeout') as statement_ms,
               (select setting::int from pg_settings where name = 'lock_timeout') as lock_ms,
               (select setting::int from pg_settings where name = 'idle_in_transaction_session_timeout') as idle_ms`;
      expect(limits).toEqual({ role: "app_runtime", statement_ms: 60_000, lock_ms: 15_000, idle_ms: 60_000 });
      // And they bite: a statement over its limit is ended (tried with a short limit of its own).
      const slow = sql.begin(async (tx) => {
        await tx`set local statement_timeout = '200ms'`;
        await tx`select pg_sleep(2)`;
      });
      await expect(slow).rejects.toMatchObject({ code: "57014" });
    } finally {
      await sql.end();
    }
  }, 30_000);
});

import { constants, createHmac, createPublicKey, createSign, generateKeyPairSync, randomBytes, randomUUID, sign as signWith, type KeyObject } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { audit, closeDb, withTenant } from "@/db";
import { identityMessage } from "@/db/identity-proof";
import { adminSql, deleteTenants, hasAdminDb, type AdminSql } from "../../../tests/support/admin-db";
import { enterAs } from "../../../tests/support/identity";
import { getLogo, loadWorkspace } from "./queries";
import { auditLog, branches, invitations, memberships, modulesEnabled, settings, tenants } from "./schema";

// Row-level security, exercised through the real code path: the app_runtime role, the
// transaction pooler and withTenant(). Rows are seeded and removed over the migration
// connection. Skipped when the database URLs are absent (CI has none).

const hasDb = hasAdminDb() && Boolean(process.env.DATABASE_URL);

const PREFIX = "zz-policy-test";
const tenantA = randomUUID();
const tenantB = randomUUID();
const ownerA = randomUUID();
const ownerB = randomUUID();
const salesA = randomUUID();
const auditorA = randomUUID();
const inactiveA = randomUUID();
const outsider = randomUUID();
const branchA1 = randomUUID();
const branchA2 = randomUUID();
const branchB1 = randomUUID();

let admin: AdminSql;
const createdTenants: string[] = [tenantA, tenantB];

/** The Postgres error code of a failed query, through Drizzle's wrapper. */
async function codeOf(run: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await run();
    return undefined;
  } catch (error) {
    const e = error as { code?: string; cause?: { code?: string } };
    return e.cause?.code ?? e.code ?? "unknown";
  }
}

const CHECK = "23514"; // check_violation
const DENIED = "42501"; // insufficient_privilege: a missing grant or a row-level security refusal

describe.skipIf(!hasDb)("row-level security as app_runtime", () => {
  beforeAll(async () => {
    admin = adminSql();
    // Leftovers from a run that crashed before its cleanup.
    const stale = await admin<{ id: string }[]>`select id from public.tenants where name like ${PREFIX + "%"}`;
    await deleteTenants(
      admin,
      stale.map((r) => r.id),
    );

    await admin`insert into public.tenants (id, name, created_by) values
      (${tenantA}, ${PREFIX + " A"}, ${ownerA}), (${tenantB}, ${PREFIX + " B"}, ${ownerB})`;
    await admin`insert into public.branches (id, tenant_id, name, created_by) values
      (${branchA1}, ${tenantA}, 'A1', ${ownerA}),
      (${branchA2}, ${tenantA}, 'A2', ${ownerA}),
      (${branchB1}, ${tenantB}, 'B1', ${ownerB})`;
    await admin`insert into public.memberships (tenant_id, user_id, email, role, branch_ids, active, created_by) values
      (${tenantA}, ${ownerA}, 'owner-a@policy.test', 'owner', null, true, ${ownerA}),
      (${tenantB}, ${ownerB}, 'owner-b@policy.test', 'owner', null, true, ${ownerB}),
      (${tenantA}, ${salesA}, 'sales-a@policy.test', 'salesperson', ${[branchA1]}::uuid[], true, ${ownerA}),
      (${tenantA}, ${auditorA}, 'auditor-a@policy.test', 'auditor', null, true, ${ownerA}),
      (${tenantA}, ${inactiveA}, 'inactive-a@policy.test', 'accountant', null, false, ${ownerA})`;
    await admin`insert into public.invitations (tenant_id, email, role, created_by) values
      (${tenantA}, 'invited-a@policy.test', 'accountant', ${ownerA}),
      (${tenantB}, 'invited-b@policy.test', 'accountant', ${ownerB})`;
    await admin`insert into public.audit_log (tenant_id, actor_user_id, actor_role, action, entity) values
      (${tenantA}, ${ownerA}, 'owner', 'test.seed', 'tenant'),
      (${tenantB}, ${ownerB}, 'owner', 'test.seed', 'tenant')`;
    await admin`insert into public.settings (tenant_id, product_name, created_by, updated_by) values
      (${tenantB}, 'Beta Books', ${ownerB}, ${ownerB})`;
    await admin`insert into public.modules_enabled (tenant_id, module, enabled, created_by, updated_by) values
      (${tenantB}, 'payroll', true, ${ownerB}, ${ownerB})`;
  });

  afterAll(async () => {
    await deleteTenants(admin, createdTenants);
    await admin.end();
    await closeDb();
  });

  it("connects as app_runtime, which cannot bypass row-level security", async () => {
    const rows = await withTenant(outsider, null, (tx) =>
      tx.execute(sql`select current_user as name,
        (select rolbypassrls or rolsuper from pg_roles where rolname = current_user) as privileged`),
    );
    expect(rows[0]).toEqual({ name: "app_runtime", privileged: false });
  });

  it("refuses ids that are not uuids before touching the database", async () => {
    await expect(withTenant("not-a-uuid", null, async () => 1)).rejects.toThrow(/userId/);
    await expect(withTenant(ownerA, "x' or '1'='1", async () => 1)).rejects.toThrow(/tenantId/);
  });

  it("shows nothing to a user with no membership", async () => {
    const seen = await withTenant(outsider, tenantA, async (tx) => ({
      tenants: await tx.select().from(tenants),
      memberships: await tx.select().from(memberships),
      branches: await tx.select().from(branches),
      invitations: await tx.select().from(invitations),
      audit: await tx.select().from(auditLog),
    }));
    expect(seen).toEqual({ tenants: [], memberships: [], branches: [], invitations: [], audit: [] });
  });

  it("shows an owner their own company and nothing of the other", async () => {
    const seen = await withTenant(ownerA, tenantA, async (tx) => ({
      tenants: await tx.select().from(tenants),
      memberships: await tx.select().from(memberships),
      branches: await tx.select().from(branches),
      invitations: await tx.select().from(invitations),
      audit: await tx.select().from(auditLog),
    }));
    expect(seen.tenants.map((t) => t.id)).toEqual([tenantA]);
    expect(seen.memberships).toHaveLength(4);
    expect(seen.branches.map((b) => b.name).sort()).toEqual(["A1", "A2"]);
    expect(seen.invitations.map((i) => i.email)).toEqual(["invited-a@policy.test"]);
    for (const rows of [seen.memberships, seen.branches, seen.invitations, seen.audit]) {
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((r) => r.tenantId === tenantA)).toBe(true);
    }
  });

  it("returns zero rows of another company when the tenant id is forged", async () => {
    const seen = await withTenant(ownerA, tenantB, async (tx) => ({
      tenants: await tx.select().from(tenants),
      memberships: await tx.select().from(memberships),
      branches: await tx.select().from(branches),
      invitations: await tx.select().from(invitations),
      audit: await tx.select().from(auditLog),
      direct: await tx.select().from(branches).where(eq(branches.id, branchB1)),
    }));
    // Their own membership and company stay visible (the switcher needs them); nothing of B is.
    expect(seen.tenants.map((t) => t.id)).toEqual([tenantA]);
    expect(seen.memberships.map((m) => [m.tenantId, m.userId])).toEqual([[tenantA, ownerA]]);
    expect(seen.branches).toEqual([]);
    expect(seen.invitations).toEqual([]);
    expect(seen.audit).toEqual([]);
    expect(seen.direct).toEqual([]);
  });

  it("refuses to insert a row into another company", async () => {
    const intoB = { tenantId: tenantB, name: "smuggled", createdBy: ownerA };
    // From the owner's own company, and with the other company's id forged as the context.
    for (const context of [tenantA, tenantB]) {
      expect(await codeOf(() => withTenant(ownerA, context, (tx) => tx.insert(branches).values(intoB)))).toBe(DENIED);
      expect(
        await codeOf(() =>
          withTenant(ownerA, context, (tx) =>
            tx.insert(invitations).values({ tenantId: tenantB, email: "x@policy.test", role: "auditor", createdBy: ownerA }),
          ),
        ),
      ).toBe(DENIED);
      expect(
        await codeOf(() =>
          withTenant(ownerA, context, (tx) =>
            audit(tx, { userId: ownerA, tenantId: tenantB, role: "owner" }, { action: "test.forged", entity: "tenant" }),
          ),
        ),
      ).toBe(DENIED);
    }
    const leaked = await admin`select 1 from public.branches where tenant_id = ${tenantB} and name = 'smuggled'`;
    expect(leaked).toHaveLength(0);
  });

  // drizzle/0019_journal_documents.sql: a later step names the audit rows its own database
  // functions write, with a function of its own, and the app's role can then no longer write them.
  it("keeps the audit rows a later step's database functions write out of the app's hands", async () => {
    const write = (action: string) => codeOf(() => withTenant(ownerA, tenantA, (tx) => audit(tx, { userId: ownerA, tenantId: tenantA, role: "owner" }, { action, entity: "tenant" })));
    expect(await write("zz_test.post")).toBeUndefined();
    await admin.unsafe("drop function if exists app.audit_reserved_zz_test(text)");
    await admin.unsafe("create function app.audit_reserved_zz_test(p_action text) returns boolean language sql immutable as 'select p_action in (''zz_test.post'', ''zz_test.bounce'')'");
    // As a step would leave it: nobody but its owner may call it. The check still can.
    await admin.unsafe("revoke all on function app.audit_reserved_zz_test(text) from public");
    try {
      expect(await write("zz_test.post")).toBe(DENIED);
      expect(await write("zz_test.bounce")).toBe(DENIED);
      // The app's own rows about the same thing, and rows about anything else, go in as before.
      expect(await write("zz_test.note")).toBeUndefined();
      expect(await write("zz_testing.post")).toBeUndefined();
      expect(await write("test.ok")).toBeUndefined();
      // A temporary table of the session's own called "text" once hid the function from the
      // check. The app's role can no longer make one (drizzle/0023_safe_search_path.sql), asked
      // before or after the check was first used in the session.
      const hidden = (askFirst: boolean) =>
        codeOf(() =>
          withTenant(ownerA, tenantA, async (tx) => {
            if (askFirst) await tx.execute(sql`select app.audit_action_reserved('zz_test.post')`);
            await tx.execute(sql`create temp table text (x int) on commit drop`);
            await audit(tx, { userId: ownerA, tenantId: tenantA, role: "owner" }, { action: "zz_test.post", entity: "tenant" });
          }),
        );
      expect(await hidden(true)).toBe(DENIED);
      expect(await hidden(false)).toBe(DENIED);
      expect((await admin`select 1 from public.audit_log where tenant_id = ${tenantA} and action in ('zz_test.post', 'zz_test.bounce')`).length).toBe(1);
    } finally {
      await admin.unsafe("drop function if exists app.audit_reserved_zz_test(text)");
    }
    expect(await write("zz_test.post")).toBeUndefined();
    // The rows the database has written itself since Step 18 are still its own.
    expect(await write("journal.post")).toBe(DENIED);
    expect(await write("sales_order.submit")).toBe(DENIED);
  });

  // drizzle/0023_safe_search_path.sql. With an empty search path Postgres looks for a type first
  // in the session's temporary schema. A session of the app's role could make a temporary type
  // called "uuid" whose check called a function of its own; app.tenant_id(), which every policy
  // asks, then ran that function as postgres. Two things each close it, and both are held here.
  it("gives a session of the app's role no way to run its own code as the owner of the database functions", async () => {
    // 1. The app's role makes no temporary object of any kind.
    const [rights] = await admin`select has_database_privilege('app_runtime', current_database(), 'TEMPORARY') as app_runtime, has_database_privilege('anon', current_database(), 'TEMPORARY') as anon, has_database_privilege('authenticated', current_database(), 'TEMPORARY') as authenticated`;
    expect({ ...rights }).toEqual({ app_runtime: false, anon: false, authenticated: false });
    const attempt = (statement: string) => codeOf(() => withTenant(ownerA, tenantA, (tx) => tx.execute(sql.raw(statement))));
    expect(await attempt("create temp table zz_probe (x int) on commit drop")).toBe(DENIED);
    expect(await attempt("create function pg_temp.zz_probe() returns boolean language sql as 'select true'")).toBe(DENIED);
    expect(await attempt("create domain pg_temp.uuid as pg_catalog.uuid check (true)")).toBe(DENIED);
    // 2. Every function in schema app looks in pg_catalog first and the temporary schema last,
    //    whoever wrote it and in whichever step. Read from the database's own list, so a function
    //    added later with an empty path, or none, fails here.
    const unsafe = await admin`
      select p.oid::regprocedure::text as fn, coalesce(array_to_string(p.proconfig, ' | '), 'no search_path set') as has
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'app' and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c = 'search_path=pg_catalog, pg_temp')
      order by 1`;
    expect(unsafe.map((f) => `${f.fn}: ${f.has}`)).toEqual([]);
  });

  // drizzle/0031_identity_proof.sql and the security clean-up after Step 47. The app used to tell
  // the database who was signed in by writing two settings, which any session of the app's role
  // can write. The database now wants a signature: made with a secret it shares with the web
  // app, or with a private key whose public half it holds. The keys are put in here inside one
  // transaction that is rolled back, so no other test and no other session ever sees them; that
  // transaction is the migration connection's, and the functions answer the same whoever asks.
  const publicHalf = (key: KeyObject) => {
    const modulus = Buffer.from(createPublicKey(key).export({ format: "jwk" }).n as string, "base64url");
    return { modulus: BigInt(`0x${modulus.toString("hex")}`).toString(10), bytes: modulus.length };
  };
  const newKey = (bits = 2048) => generateKeyPairSync("rsa", { modulusLength: bits, publicExponent: 65537 }).privateKey;

  it("takes nobody's word for who is signed in", async () => {
    const secret = randomBytes(32);
    const padded = Buffer.concat([secret, Buffer.alloc(32)]);
    const inner = Buffer.from(padded.map((b) => b ^ 0x36));
    const outer = Buffer.from(padded.map((b) => b ^ 0x5c));
    const sign = (user: string, tenant: string | null, expires: number, key: Buffer = secret) =>
      createHmac("sha256", key).update(identityMessage(user, tenant, expires)).digest("hex");
    const key = newKey();
    const signed = (user: string, tenant: string | null, expires: number, by: KeyObject = key, version: 1 | 2 = 2) =>
      createSign("RSA-SHA256").update(identityMessage(user, tenant, expires, version)).sign(by).toString("hex");
    const soon = Math.floor(Date.now() / 1000) + 300;
    const undone = new Error("undo");
    const seen: Record<string, unknown> = {};

    await admin
      .begin(async (tx) => {
        await tx`delete from app.identity_keys`;
        await tx`delete from app.identity_public_keys`;
        const who = async () => ({ ...(await tx`select app.current_user_id() as "user", app.tenant_id() as tenant, app.tenant_role() as role, (select count(*)::int from app.member_tenant_ids()) as companies`)[0] });
        const enter = (user: string, tenant: string | null, expires: number, signature: string) =>
          tx.savepoint((sp) => sp`select app.enter(${user}::uuid, ${tenant}::uuid, ${expires}::bigint, ${signature}::text)`).then(
            () => undefined,
            (error: { code?: string }) => error.code,
          );

        // A database with nothing installed believes nobody: not the settings, not a call with
        // no proof, not a proof that would be right if its key were here.
        await tx`select set_config('app.user_id', ${ownerA}, true), set_config('app.tenant_id', ${tenantA}, true)`;
        seen.noKey = [await who(), await enter(ownerA, tenantA, 0, ""), await enter(ownerA, tenantA, soon, sign(ownerA, tenantA, soon)), await enter(ownerA, tenantA, soon, signed(ownerA, tenantA, soon)), await who()];

        // ── the shared secret ──
        await tx`insert into app.identity_keys (slot, inner_key, outer_key) values (1, ${inner}, ${outer})`;
        seen.settings = await who();
        // No proof, somebody else's proof, a proof for another company, one made with another
        // secret, one that is out of date and one that claims to be good for an hour.
        seen.refused = [
          await enter(ownerA, tenantA, 0, ""),
          await enter(ownerA, tenantA, soon, sign(ownerB, tenantB, soon)),
          await enter(ownerA, tenantA, soon, sign(ownerA, tenantB, soon)),
          await enter(ownerA, tenantA, soon, sign(ownerA, tenantA, soon, randomBytes(32))),
          await enter(ownerA, tenantA, soon - 400, sign(ownerA, tenantA, soon - 400)),
          await enter(ownerA, tenantA, soon + 3600, sign(ownerA, tenantA, soon + 3600)),
          await enter(ownerA, tenantA, soon, sign(ownerA, tenantA, soon).toUpperCase()),
          // With no public key installed, a proof signed with a private key is nothing.
          await enter(ownerA, tenantA, soon, signed(ownerA, tenantA, soon)),
        ];
        seen.afterRefusals = await who();
        // The real thing is believed, and a signed move to no company or to a company the user
        // is not in gives what it should.
        seen.entered = await enter(ownerA, tenantA, soon, sign(ownerA, tenantA, soon));
        seen.owner = await who();
        await enter(ownerA, null, soon, sign(ownerA, null, soon));
        seen.nowhere = await who();
        await enter(ownerA, tenantB, soon, sign(ownerA, tenantB, soon));
        seen.elsewhere = await who();

        // ── the public key, with the secret gone: nothing left in the database can sign ──
        await tx`delete from app.identity_keys`;
        const mine = publicHalf(key);
        await tx`insert into app.identity_public_keys (slot, modulus, bytes) values (1, ${mine.modulus}::numeric, ${mine.bytes})`;
        const other = newKey();
        const good = signed(ownerA, tenantA, soon);
        const flipped = good.slice(0, 200) + (good[200] === "0" ? "1" : "0") + good.slice(201);
        seen.keyRefused = [
          await enter(ownerA, tenantA, soon, sign(ownerA, tenantA, soon)), // the secret's signature, now that the secret is gone
          await enter(ownerA, tenantA, soon, signed(ownerB, tenantB, soon)),
          await enter(ownerA, tenantA, soon, signed(ownerA, tenantB, soon)),
          await enter(ownerA, tenantA, soon, signed(ownerA, tenantA, soon, other)),
          await enter(ownerA, tenantA, soon, signed(ownerA, tenantA, soon, key, 1)), // the right key over the other way's text
          await enter(ownerA, tenantA, soon - 400, signed(ownerA, tenantA, soon - 400)),
          await enter(ownerA, tenantA, soon + 3600, signed(ownerA, tenantA, soon + 3600)),
          await enter(ownerA, tenantA, soon, flipped),
          await enter(ownerA, tenantA, soon, good.toUpperCase()),
          await enter(ownerA, tenantA, soon, good.slice(2)),
          await enter(ownerA, tenantA, soon, "00".repeat(256)),
          await enter(ownerA, tenantA, soon, signed(ownerA, tenantA, soon, newKey(3072))),
        ];
        seen.afterKeyRefusals = await who();
        seen.keyEntered = await enter(ownerA, tenantA, soon, good);
        seen.keyOwner = await who();
        // Shown again on the same connection it is not worked out again, and is good for the same
        // user and company only: the same signature does not carry anyone else in.
        seen.again = [await enter(ownerA, tenantA, soon, good), await enter(ownerB, tenantA, soon, good), await enter(ownerA, tenantB, soon, good), await enter(ownerA, tenantA, soon + 1, good)];
        seen.afterAgain = await who();
        await enter(ownerA, null, soon, signed(ownerA, null, soon));
        seen.keyNowhere = await who();
        // A second key in the other slot is accepted beside the first (how a key is changed).
        const next = publicHalf(other);
        await tx`insert into app.identity_public_keys (slot, modulus, bytes) values (2, ${next.modulus}::numeric, ${next.bytes})`;
        seen.both = [await enter(ownerB, tenantB, soon, signed(ownerB, tenantB, soon, other)), (await who()).user, await enter(ownerA, tenantA, soon, signed(ownerA, tenantA, soon)), (await who()).user];
        throw undone;
      })
      .catch((error) => {
        if (error !== undone) throw error;
      });

    const nobody = { user: null, tenant: null, role: null, companies: 0 };
    expect(seen.noKey).toEqual([nobody, DENIED, DENIED, DENIED, nobody]);
    expect(seen.settings).toEqual(nobody);
    expect(seen.refused).toEqual(Array(8).fill(DENIED));
    expect(seen.afterRefusals).toEqual(nobody);
    expect(seen.entered).toBeUndefined();
    expect(seen.owner).toEqual({ user: ownerA, tenant: tenantA, role: "owner", companies: 1 });
    expect(seen.nowhere).toEqual({ user: ownerA, tenant: null, role: null, companies: 1 });
    expect(seen.elsewhere).toEqual({ user: ownerA, tenant: null, role: null, companies: 1 });
    expect(seen.keyRefused).toEqual(Array(12).fill(DENIED));
    // A refusal leaves the transaction as whoever it last proved it was: the move to company B above.
    expect(seen.afterKeyRefusals).toEqual({ user: ownerA, tenant: null, role: null, companies: 1 });
    expect(seen.keyEntered).toBeUndefined();
    expect(seen.keyOwner).toEqual({ user: ownerA, tenant: tenantA, role: "owner", companies: 1 });
    expect(seen.again).toEqual([undefined, DENIED, DENIED, DENIED]);
    expect(seen.afterAgain).toEqual({ user: ownerA, tenant: tenantA, role: "owner", companies: 1 });
    expect(seen.keyNowhere).toEqual({ user: ownerA, tenant: null, role: null, companies: 1 });
    expect(seen.both).toEqual([undefined, ownerB, undefined, ownerA]);
    // Neither key ever left that transaction.
    expect(await admin`select 1 from app.identity_keys where inner_key = ${inner}`).toHaveLength(0);
    expect(await admin`select 1 from app.identity_public_keys where modulus = ${publicHalf(key).modulus}::numeric`).toHaveLength(0);

    // The app's roles reach neither the keys nor the record of who each transaction is, and
    // cannot ask the functions behind the five that answer.
    const attempt = (statement: string) => codeOf(() => withTenant(ownerA, tenantA, (tx) => tx.execute(sql.raw(statement))));
    expect(await attempt("select 1 from app.identity_keys")).toBe(DENIED);
    expect(await attempt("select 1 from app.identity_public_keys")).toBe(DENIED);
    expect(await attempt("insert into app.identity_public_keys (slot, modulus, bytes) values (2, 3, 256)")).toBe(DENIED);
    expect(await attempt("select 1 from app.identity_sessions")).toBe(DENIED);
    expect(await attempt("update app.identity_sessions set user_id = user_id")).toBe(DENIED);
    expect(await attempt("delete from app.identity_keys")).toBe(DENIED);
    expect(await attempt("select * from app.identity_now()")).toBe(DENIED);
    expect(await attempt("select app.identity_signature_valid(3, 256, ''::bytea, ''::bytea)")).toBe(DENIED);
    expect(await attempt("select app.identity_number(''::bytea)")).toBe(DENIED);
    const [reach] = await admin`
      select bool_or(has_table_privilege(r, 'app.identity_keys', 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
                  or has_table_privilege(r, 'app.identity_public_keys', 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
                  or has_table_privilege(r, 'app.identity_sessions', 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
                  or has_function_privilege(r, 'app.identity_signature_valid(numeric, integer, bytea, bytea)', 'EXECUTE')
                  or has_function_privilege(r, 'app.identity_number(bytea)', 'EXECUTE')
                  or has_function_privilege(r, 'app.identity_now()', 'EXECUTE')) as any,
             bool_or(has_function_privilege(r, 'app.enter(uuid, uuid, bigint, text)', 'EXECUTE')) filter (where r <> 'app_runtime') as others_enter
      from unnest(array['app_runtime', 'anon', 'authenticated', 'service_role', 'public']) r`;
    expect({ ...reach }).toEqual({ any: false, others_enter: false });
    // What asked "is a proof wanted?" is gone: one is always wanted.
    expect(await admin`select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'app' and p.proname = 'identity_proof_wanted' union all select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'app' and c.relname = 'identity_proof_flag'`).toHaveLength(0);
  });

  it("checks a private key's signature whole, and takes nothing that only resembles one", async () => {
    const key = newKey();
    const { modulus, bytes } = publicHalf(key);
    const message = Buffer.from(identityMessage(ownerA, tenantA, 1_800_000_000, 2));
    const valid = async (signature: Buffer, over: Buffer = message, n: string = modulus, length: number | null = bytes) =>
      (await admin<{ ok: boolean | null }[]>`select app.identity_signature_valid(${n}::numeric, ${length}::int, ${over}::bytea, ${signature}::bytea) as ok`)[0].ok;
    const good = createSign("RSA-SHA256").update(message).sign(key);
    expect(await valid(good)).toBe(true);
    // Twenty more texts, each with its own signature: all taken, and none taken for another's.
    for (let n = 0; n < 20; n += 1) {
      const text = Buffer.from(`sahulaterp-identity-v2|${randomBytes(8).toString("hex")}|${n}`);
      const signature = createSign("RSA-SHA256").update(text).sign(key);
      expect([await valid(signature, text), await valid(signature, message), await valid(good, text)], String(n)).toEqual([true, false, false]);
    }
    const asNumber = (buffer: Buffer) => BigInt(`0x${buffer.toString("hex")}`);
    const asBytes = (value: bigint, length: number) => Buffer.from(value.toString(16).padStart(length * 2, "0"), "hex");
    const n = BigInt(modulus);
    const refused: Record<string, Buffer> = {
      "one bit changed": Buffer.from(good.map((b, at) => (at === 100 ? b ^ 1 : b))),
      "another key's": createSign("RSA-SHA256").update(message).sign(newKey()),
      "the same key, another hash (SHA-1)": createSign("RSA-SHA1").update(message).sign(key),
      "the same key, another hash (SHA-512)": createSign("RSA-SHA512").update(message).sign(key),
      "the same key, the other padding (PSS)": signWith("sha256", message, { key, padding: constants.RSA_PKCS1_PSS_PADDING }),
      "nothing": Buffer.alloc(0),
      "all zeros": Buffer.alloc(bytes),
      "one": asBytes(BigInt(1), bytes),
      "the modulus less one": asBytes(n - BigInt(1), bytes),
      "the modulus": asBytes(n, bytes),
      // The same number as the real signature once the modulus is taken off: too big, or too long.
      "the signature plus the modulus, a byte longer": asBytes(asNumber(good) + n, bytes + 1),
      "a byte short": good.subarray(1),
      "a byte long": Buffer.concat([Buffer.alloc(1), good]),
    };
    for (const [what, signature] of Object.entries(refused)) expect(await valid(signature), what).toBe(false);
    // A key of another size is asked for by its own size only; and nothing missing is taken for anything.
    const big = newKey(3072);
    const bigHalf = publicHalf(big);
    const bigSignature = createSign("RSA-SHA256").update(message).sign(big);
    expect([await valid(bigSignature, message, bigHalf.modulus, bigHalf.bytes), await valid(bigSignature, message, bigHalf.modulus, 256), await valid(good, message, modulus, 384), await valid(good, message, modulus, 100), await valid(good, message, modulus, null)]).toEqual([true, false, false, false, false]);
    // The table takes only a modulus of the length it says, and odd.
    const plant = (value: string, length: number) => codeOf(() => admin.begin(async (tx) => {
      await tx`delete from app.identity_public_keys`;
      await tx`insert into app.identity_public_keys (slot, modulus, bytes) values (1, ${value}::numeric, ${length})`;
      throw Object.assign(new Error("undo"), { code: "undone" });
    }));
    expect([await plant(modulus, 256), await plant("3", 256), await plant((n + BigInt(1)).toString(), 256), await plant(modulus, 384), await plant(modulus, 128), await plant(`${modulus}.5`, 256)]).toEqual(["undone", CHECK, CHECK, CHECK, CHECK, CHECK]);
  });

  // Found by the reviewer of the security clean-up: a transaction that keeps the picture of the
  // database it began with went on seeing a key after it was removed, and took a proof made with
  // it; so did a new transaction that borrowed that picture. Who is signed in can now be said
  // only in an ordinary transaction, where every statement sees the database as it is.
  it("lets nobody say who they are in a transaction that keeps an old picture of the database", async () => {
    const direct = postgres(process.env.DATABASE_URL!, { max: 2 });
    try {
      for (const level of ["repeatable read", "serializable"] as const) {
        const refused = await direct.begin(`isolation level ${level}`, async (tx) => tx.savepoint((sp) => enterAs(sp, ownerA, tenantA)).then(() => "believed", (error: { code?: string; message?: string }) => `${error.code}: ${error.message}`));
        expect(refused, level).toBe("42501: The database did not accept who is signed in: who is signed in is said in a read committed transaction");
      }
      // One that borrows another's picture is one of those; and nobody is anybody in it.
      const borrowed = await direct.begin("isolation level repeatable read", async (lender) => {
        const [{ snapshot }] = await lender<{ snapshot: string }[]>`select pg_export_snapshot() as snapshot`;
        return direct.begin("isolation level repeatable read", async (tx) => {
          await tx.unsafe(`set transaction snapshot '${snapshot.replace(/[^0-9A-Fa-f-]/g, "")}'`);
          const entered = await tx.savepoint((sp) => enterAs(sp, ownerA, tenantA)).then(() => "believed", (error: { code?: string }) => error.code);
          const [who] = await tx`select app.current_user_id() as "user", (select count(*)::int from public.branches) as branches`;
          return { entered, ...who };
        });
      });
      expect(borrowed).toEqual({ entered: DENIED, user: null, branches: 0 });
      // The level cannot be changed once the transaction has said who it is.
      const changed = await direct.begin(async (tx) => {
        await enterAs(tx, ownerA, tenantA);
        return tx.savepoint((sp) => sp`set transaction isolation level repeatable read`).then(() => "changed", (error: { code?: string }) => error.code);
      });
      expect(changed).toBe("25001");
    } finally {
      await direct.end();
    }
  });

  it("believes who a transaction is only until that transaction ends", async () => {
    // One connection, so the second transaction is the same database session as the first.
    const direct = postgres(process.env.DATABASE_URL!, { max: 1 });
    try {
      const first = await direct.begin(async (tx) => {
        await enterAs(tx, ownerA, tenantA);
        return (await tx`select app.current_user_id() as "user", app.tenant_role() as role`)[0];
      });
      expect({ ...first }).toEqual({ user: ownerA, role: "owner" });
      const second = await direct.begin(async (tx) => (await tx`select app.current_user_id() as "user", app.tenant_id() as tenant, (select count(*)::int from public.branches) as branches`)[0]);
      expect({ ...second }).toEqual({ user: null, tenant: null, branches: 0 });
      // A transaction that is rolled back leaves nothing behind either.
      await direct.begin(async (tx) => {
        await enterAs(tx, ownerB, tenantB);
        throw new Error("undo");
      }).catch(() => undefined);
      const third = await direct.begin(async (tx) => (await tx`select app.current_user_id() as "user"`)[0]);
      expect(third.user).toBeNull();
    } finally {
      await direct.end();
    }
  });

  it("is not put off by rubbish a session left in the old settings", async () => {
    // A setting made for the whole session stays on a pooled connection for whoever comes next.
    const direct = postgres(process.env.DATABASE_URL!, { max: 1 });
    try {
      await direct`select set_config('app.user_id', 'not an id', false), set_config('app.tenant_id', 'x', false)`;
      const proven = await direct.begin(async (tx) => {
        await enterAs(tx, ownerA, tenantA);
        return (await tx`select app.current_user_id() as "user", app.tenant_role() as role`)[0];
      });
      expect({ ...proven }).toEqual({ user: ownerA, role: "owner" });
      const unproven = await direct.begin(async (tx) => (await tx`select app.current_user_id() as "user", app.tenant_id() as tenant, (select count(*)::int from public.branches) as branches`)[0]);
      expect({ ...unproven }).toEqual({ user: null, tenant: null, branches: 0 });
    } finally {
      await direct.end();
    }
  });

  // Before the security clean-up, a database with no key installed took the app's word, and
  // marked what it wrote down that way as not proven. Nothing not proven is believed now,
  // wherever it came from: a row left by a transaction that was open while the migration went
  // in, say. (The row is written here as the owner of the database; the app's role cannot.)
  it("believes only what was proven", async () => {
    const direct = postgres(process.env.DATABASE_URL!, { max: 1 });
    try {
      const seen = await direct.begin(async (tx) => {
        const [{ pid, xid }] = await tx<{ pid: number; xid: string }[]>`select pg_backend_pid() as pid, pg_current_xact_id()::text as xid`;
        const who = () => tx`select app.current_user_id() as "user", app.tenant_role() as role, (select count(*)::int from public.branches) as branches`.then((rows) => ({ ...rows[0] }));
        const write = (proven: boolean) => admin`
          insert into app.identity_sessions (pid, xid, user_id, tenant_id, proven) values (${pid}, ${xid}::xid8, ${ownerA}, ${tenantA}, ${proven})
          on conflict (pid) do update set xid = excluded.xid, user_id = excluded.user_id, tenant_id = excluded.tenant_id, proven = excluded.proven, proof = null, proof_expires = null`;
        await write(false);
        const unproven = await who();
        // The same row marked proven is believed, so it was the mark that decided.
        await write(true);
        const proven = await who();
        // And a call with no proof is refused, whatever the row says.
        const unsigned = await tx.savepoint((sp) => sp`select app.enter(${ownerA}::uuid, ${tenantA}::uuid, 0, '')`).then(() => undefined, (error: { code?: string }) => error.code);
        return { unproven, proven, unsigned };
      });
      expect(seen.unproven).toEqual({ user: null, role: null, branches: 0 });
      expect(seen.proven).toMatchObject({ user: ownerA, role: "owner" });
      expect(seen.unsigned).toBe(DENIED);
    } finally {
      await admin`delete from app.identity_sessions where user_id = ${ownerA} and proof is null`;
      await direct.end();
    }
  });

  it("lets an owner add a branch and writes the audit row in the same transaction", async () => {
    const id = await withTenant(ownerA, tenantA, async (tx) => {
      const [row] = await tx.insert(branches).values({ tenantId: tenantA, name: "A3", createdBy: ownerA }).returning();
      await audit(
        tx,
        { userId: ownerA, tenantId: tenantA, role: "owner" },
        { action: "branch.create", entity: "branch", entityId: row.id, after: { name: row.name } },
      );
      return row.id;
    });
    const logged = await admin`select actor_user_id, actor_role, action, after from public.audit_log where entity_id = ${id}`;
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({ actor_user_id: ownerA, actor_role: "owner", action: "branch.create", after: { name: "A3" } });
  });

  it("rolls the change back when the audit row is refused", async () => {
    const code = await codeOf(() =>
      withTenant(ownerA, tenantA, async (tx) => {
        await tx.insert(branches).values({ tenantId: tenantA, name: "never-kept", createdBy: ownerA });
        // An audit row claiming a different actor is refused, which aborts the whole transaction.
        await audit(tx, { userId: ownerB, tenantId: tenantA, role: "owner" }, { action: "branch.create", entity: "branch" });
      }),
    );
    expect(code).toBe(DENIED);
    const kept = await admin`select 1 from public.branches where tenant_id = ${tenantA} and name = 'never-kept'`;
    expect(kept).toHaveLength(0);
  });

  it("limits a branch-scoped member to their branches", async () => {
    const seen = await withTenant(salesA, tenantA, (tx) => tx.select().from(branches));
    expect(seen.map((b) => b.name)).toEqual(["A1"]);
  });

  it("keeps owner-only actions from other roles", async () => {
    expect(
      await codeOf(() =>
        withTenant(salesA, tenantA, (tx) => tx.insert(branches).values({ tenantId: tenantA, name: "by-sales", createdBy: salesA })),
      ),
    ).toBe(DENIED);
    expect(
      await codeOf(() =>
        withTenant(auditorA, tenantA, (tx) =>
          tx.insert(invitations).values({ tenantId: tenantA, email: "y@policy.test", role: "auditor", createdBy: auditorA }),
        ),
      ),
    ).toBe(DENIED);
    const seen = await withTenant(salesA, tenantA, async (tx) => ({
      memberships: await tx.select().from(memberships),
      invitations: await tx.select().from(invitations),
      audit: await tx.select().from(auditLog),
    }));
    expect(seen.memberships.map((m) => m.userId)).toEqual([salesA]);
    expect(seen.invitations).toEqual([]);
    expect(seen.audit).toEqual([]);
  });

  it("lets an auditor read the audit log and the members behind it, in their company only", async () => {
    const seen = await withTenant(auditorA, tenantA, async (tx) => ({
      audit: await tx.select().from(auditLog),
      memberships: await tx.select().from(memberships),
    }));
    expect(seen.audit.length).toBeGreaterThan(0);
    expect(seen.audit.every((r) => r.tenantId === tenantA)).toBe(true);
    expect(seen.memberships).toHaveLength(4);
    expect(seen.memberships.every((m) => m.tenantId === tenantA)).toBe(true);
  });

  it("accepts an audit row only from the actor, in their real role", async () => {
    const asSelf = { userId: salesA, tenantId: tenantA, role: "salesperson" as const };
    expect(
      await codeOf(() => withTenant(salesA, tenantA, (tx) => audit(tx, asSelf, { action: "test.ok", entity: "tenant" }))),
    ).toBeUndefined();
    expect(
      await codeOf(() =>
        withTenant(salesA, tenantA, (tx) => audit(tx, { ...asSelf, role: "owner" }, { action: "test.role", entity: "tenant" })),
      ),
    ).toBe(DENIED);
    expect(
      await codeOf(() =>
        withTenant(salesA, tenantA, (tx) => audit(tx, { ...asSelf, userId: ownerA }, { action: "test.actor", entity: "tenant" })),
      ),
    ).toBe(DENIED);
  });

  it("never lets the app change or remove an audit row", async () => {
    expect(
      await codeOf(() => withTenant(ownerA, tenantA, (tx) => tx.update(auditLog).set({ action: "edited" }))),
    ).toBe(DENIED);
    expect(await codeOf(() => withTenant(ownerA, tenantA, (tx) => tx.delete(auditLog)))).toBe(DENIED);
  });

  it("gives the app no direct write on tenants or memberships", async () => {
    expect(
      await codeOf(() => withTenant(ownerA, tenantA, (tx) => tx.insert(tenants).values({ name: "direct", createdBy: ownerA }))),
    ).toBe(DENIED);
    expect(
      await codeOf(() =>
        withTenant(ownerA, tenantA, (tx) =>
          tx.insert(memberships).values({ tenantId: tenantA, userId: outsider, email: "z@policy.test", role: "owner", createdBy: ownerA }),
        ),
      ),
    ).toBe(DENIED);
    expect(
      await codeOf(() => withTenant(salesA, tenantA, (tx) => tx.update(memberships).set({ role: "owner", branchIds: null }))),
    ).toBe(DENIED);
    expect(await codeOf(() => withTenant(ownerA, tenantA, (tx) => tx.delete(branches)))).toBe(DENIED);
  });

  it("shows an inactive member nothing", async () => {
    const seen = await withTenant(inactiveA, tenantA, async (tx) => ({
      tenants: await tx.select().from(tenants),
      branches: await tx.select().from(branches),
      audit: await tx.select().from(auditLog),
    }));
    expect(seen).toEqual({ tenants: [], branches: [], audit: [] });
  });

  it("creates a company with its owner through app.create_tenant", async () => {
    const id = await withTenant(outsider, null, async (tx) => {
      const rows = await tx.execute<{ id: string }>(
        sql`select app.create_tenant(${PREFIX + " C"}, ${"Outsider@Policy.Test"}) as id`,
      );
      return rows[0].id;
    });
    createdTenants.push(id);
    const seen = await withTenant(outsider, id, async (tx) => ({
      tenants: await tx.select().from(tenants),
      memberships: await tx.select().from(memberships),
    }));
    expect(seen.tenants.map((t) => [t.id, t.tenantId, t.name])).toEqual([[id, id, PREFIX + " C"]]);
    expect(seen.memberships.map((m) => [m.userId, m.role, m.email, m.branchIds, m.active])).toEqual([
      [outsider, "owner", "outsider@policy.test", null, true],
    ]);
  });

  it("lets an owner save the company's settings and module switches, and every member read them", async () => {
    await withTenant(ownerA, tenantA, async (tx) => {
      await tx.insert(settings).values({ tenantId: tenantA, productName: "Alpha Desk", createdBy: ownerA, updatedBy: ownerA });
      await tx
        .insert(modulesEnabled)
        .values({ tenantId: tenantA, module: "commissions", enabled: false, createdBy: ownerA, updatedBy: ownerA });
    });
    await withTenant(ownerA, tenantA, (tx) =>
      tx.update(settings).set({ productName: "Alpha Desk 2", updatedAt: new Date(), updatedBy: ownerA }).where(eq(settings.tenantId, tenantA)),
    );
    const seen = await withTenant(salesA, tenantA, async (tx) => ({
      settings: await tx.select({ tenantId: settings.tenantId, productName: settings.productName }).from(settings),
      modules: await tx.select({ tenantId: modulesEnabled.tenantId, module: modulesEnabled.module, enabled: modulesEnabled.enabled }).from(modulesEnabled),
    }));
    expect(seen.settings).toEqual([{ tenantId: tenantA, productName: "Alpha Desk 2" }]);
    expect(seen.modules).toEqual([{ tenantId: tenantA, module: "commissions", enabled: false }]);
  });

  it("keeps settings and module switches from other roles and from other companies", async () => {
    // A member who is not the owner cannot write either table.
    expect(
      await codeOf(() =>
        withTenant(salesA, tenantA, (tx) =>
          tx.update(settings).set({ productName: "Hijacked", updatedAt: new Date(), updatedBy: salesA }).where(eq(settings.tenantId, tenantA)),
        ),
      ),
    ).toBeUndefined(); // no error: the row is simply not updatable for them, so nothing changes
    expect(
      await codeOf(() =>
        withTenant(auditorA, tenantA, (tx) =>
          tx.insert(modulesEnabled).values({ tenantId: tenantA, module: "payroll", enabled: true, createdBy: auditorA, updatedBy: auditorA }),
        ),
      ),
    ).toBe(DENIED);
    // An owner cannot write as somebody else, into another company, or touch another company's rows.
    expect(
      await codeOf(() =>
        withTenant(ownerA, tenantA, (tx) =>
          tx.insert(modulesEnabled).values({ tenantId: tenantA, module: "payroll", enabled: true, createdBy: ownerB, updatedBy: ownerB }),
        ),
      ),
    ).toBe(DENIED);
    for (const context of [tenantA, tenantB]) {
      expect(
        await codeOf(() =>
          withTenant(ownerA, context, (tx) =>
            tx.insert(modulesEnabled).values({ tenantId: tenantB, module: "fbr", enabled: true, createdBy: ownerA, updatedBy: ownerA }),
          ),
        ),
      ).toBe(DENIED);
      await withTenant(ownerA, context, async (tx) => {
        await tx.update(settings).set({ productName: "Hijacked", updatedAt: new Date(), updatedBy: ownerA }).where(eq(settings.tenantId, tenantB));
        await tx.update(modulesEnabled).set({ enabled: false, updatedAt: new Date(), updatedBy: ownerA }).where(eq(modulesEnabled.tenantId, tenantB));
      });
    }
    // A non-owner cannot create the settings row, and an owner cannot sign a change as somebody else.
    expect(
      await codeOf(() =>
        withTenant(salesA, tenantA, (tx) =>
          tx.insert(settings).values({ tenantId: tenantA, productName: "By sales", createdBy: salesA, updatedBy: salesA }),
        ),
      ),
    ).toBe(DENIED);
    expect(
      await codeOf(() =>
        withTenant(ownerA, tenantA, (tx) =>
          tx.update(settings).set({ productName: "Signed by B", updatedBy: ownerB }).where(eq(settings.tenantId, tenantA)),
        ),
      ),
    ).toBe(DENIED);
    expect(
      await codeOf(() =>
        withTenant(ownerA, tenantA, (tx) =>
          tx.update(modulesEnabled).set({ enabled: true, updatedBy: ownerB }).where(eq(modulesEnabled.tenantId, tenantA)),
        ),
      ),
    ).toBe(DENIED);
    for (const forged of [{ tenantId: tenantB }, { createdBy: ownerB }]) {
      expect(
        await codeOf(() =>
          withTenant(ownerA, tenantA, (tx) => tx.update(modulesEnabled).set(forged).where(eq(modulesEnabled.tenantId, tenantA))),
        ),
      ).toBe(DENIED);
    }
    // Nothing is deletable, and the columns that say who created a row cannot be rewritten.
    expect(await codeOf(() => withTenant(ownerA, tenantA, (tx) => tx.delete(settings)))).toBe(DENIED);
    expect(await codeOf(() => withTenant(ownerA, tenantA, (tx) => tx.delete(modulesEnabled)))).toBe(DENIED);
    expect(
      await codeOf(() => withTenant(ownerA, tenantA, (tx) => tx.update(settings).set({ createdBy: ownerB }).where(eq(settings.tenantId, tenantA)))),
    ).toBe(DENIED);
    expect(
      await codeOf(() => withTenant(ownerA, tenantA, (tx) => tx.update(settings).set({ tenantId: tenantB }).where(eq(settings.tenantId, tenantA)))),
    ).toBe(DENIED);

    const stored = await admin`
      select s.tenant_id, s.product_name,
        (select enabled from public.modules_enabled m where m.tenant_id = s.tenant_id and m.module = 'payroll') as payroll,
        (select count(*)::int from public.modules_enabled m where m.tenant_id = s.tenant_id) as switches
      from public.settings s where s.tenant_id in (${tenantA}, ${tenantB}) order by s.product_name`;
    expect(stored.map((r) => [r.tenant_id, r.product_name, r.payroll, r.switches])).toEqual([
      [tenantA, "Alpha Desk 2", null, 1],
      [tenantB, "Beta Books", true, 1],
    ]);
    // And from inside company A, company B's settings and switches are not visible at all.
    const seen = await withTenant(ownerA, tenantB, async (tx) => ({
      settings: await tx.select({ tenantId: settings.tenantId }).from(settings),
      modules: await tx.select({ tenantId: modulesEnabled.tenantId }).from(modulesEnabled),
    }));
    expect(seen).toEqual({ settings: [], modules: [] });
  });

  it("builds the page frame from the user's own company, whatever company the cookie names", async () => {
    const own = { productName: "Alpha Desk 2", logoUrl: null };
    for (const cookie of [tenantA, tenantB, tenantB.toUpperCase(), "not-a-uuid", null]) {
      const { memberships: mine, active } = await loadWorkspace(ownerA, cookie);
      expect(mine.map((m) => m.tenantId), String(cookie)).toEqual([tenantA]);
      expect(active?.tenantId, String(cookie)).toBe(tenantA);
      expect(active?.branding, String(cookie)).toEqual(own);
      // Company A switched commissions off; company B switched payroll on. Only A's choice shows.
      expect(active?.modules, String(cookie)).toMatchObject({ commissions: false, payroll: false, sales: true });
    }
    // Someone with no company, and a deactivated member, get no company at all.
    expect((await loadWorkspace(randomUUID(), tenantA)).active).toBeNull();
    expect((await loadWorkspace(inactiveA, tenantA)).active).toBeNull();
    // By now `outsider` owns the company created above; asking for A still gives them their own.
    expect((await loadWorkspace(outsider, tenantA)).active?.tenantId).toBe(createdTenants[2]);
  });

  it("serves a logo only to a member of the company it belongs to", async () => {
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    await admin`update public.settings set logo = ${png}, logo_content_type = 'image/png' where tenant_id = ${tenantB}`;
    const forB = await getLogo(ownerB, tenantB);
    expect(forB && [Buffer.from(forB.bytes).equals(Buffer.from(png)), forB.contentType]).toEqual([true, "image/png"]);
    expect(await getLogo(ownerA, tenantB)).toBeNull();
    expect(await getLogo(outsider, tenantB)).toBeNull();
    expect(await getLogo(ownerA, tenantA)).toBeNull(); // company A has no logo
  });

  it("keeps the catalogue rules: tenant_id, forced row-level security and a policy on every table", async () => {
    const tables = await admin<{ name: string; has_tenant_id: boolean; rls: boolean; forced: boolean; policies: number }[]>`
      select c.relname as name,
        exists (select 1 from pg_attribute a where a.attrelid = c.oid and a.attname = 'tenant_id' and not a.attisdropped) as has_tenant_id,
        c.relrowsecurity as rls,
        c.relforcerowsecurity as forced,
        (select count(*)::int from pg_policy p where p.polrelid = c.oid) as policies
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind in ('r', 'p')
      order by 1`;
    // Every table in public, including ones later steps add: none may skip these rules.
    expect(tables.map((t) => t.name)).toEqual(
      expect.arrayContaining(["audit_log", "branches", "invitations", "memberships", "tenants"]),
    );
    for (const table of tables) {
      expect(table, table.name).toMatchObject({ has_tenant_id: true, rls: true, forced: true });
      expect(table.policies, table.name).toBeGreaterThan(0);
    }
  });

  it("lets the Data API roles call nothing in the app schema but the one function storage needs", async () => {
    // `authenticated` can reach the app schema (Supabase Storage's policies call app.storage_role).
    // Every other function there must stay closed to it, including ones later steps add.
    const callable = await admin<{ role: string; name: string }[]>`
      select r.rolname as role, p.proname as name
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      cross join (select rolname from pg_roles where rolname in ('anon', 'authenticated')) r
      where n.nspname = 'app' and has_function_privilege(r.rolname, p.oid, 'execute')
        and has_schema_privilege(r.rolname, n.oid, 'usage')
      order by 1, 2`;
    expect(callable.map((f) => `${f.role}:${f.name}`)).toEqual(["authenticated:storage_role"]);
  });

  it("gives anon and authenticated nothing, and app_runtime no way to rewrite the audit log", async () => {
    const dataApi = await admin`
      select grantee, table_name, privilege_type from information_schema.role_table_grants
      where table_schema = 'public' and grantee in ('anon', 'authenticated', 'PUBLIC')`;
    expect(dataApi).toHaveLength(0);
    const runtime = await admin<{ table_name: string; privileges: string }[]>`
      select table_name, string_agg(privilege_type, ',' order by privilege_type) as privileges
      from information_schema.role_table_grants
      where table_schema = 'public' and grantee = 'app_runtime'
        and table_name in ('audit_log', 'branches', 'invitations', 'memberships', 'tenants')
      group by 1 order by 1`;
    expect(Object.fromEntries(runtime.map((r) => [r.table_name, r.privileges]))).toEqual({
      audit_log: "INSERT,SELECT",
      branches: "INSERT,SELECT",
      invitations: "INSERT,SELECT",
      memberships: "SELECT",
      tenants: "SELECT",
    });
  });
});

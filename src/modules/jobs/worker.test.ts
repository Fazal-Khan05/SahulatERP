import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, withTenant } from "@/db";
import { UserError } from "@/lib/errors";
import type { TenantContext } from "@/modules/tenant/rules";
import { STALE_LOCK_SECONDS, backoffSeconds, claimNextJob, finishJob, processNextJob, runWorker } from "../../../scripts/lib/worker.mjs";
import { adminSql, deleteTenants, hasAdminDb, type AdminSql } from "../../../tests/support/admin-db";
import { enqueueJob } from "./commands";
import { jobs } from "./schema";

describe("backoff", () => {
  it("doubles from thirty seconds and stops at an hour", () => {
    expect([1, 2, 3, 4, 5].map(backoffSeconds)).toEqual([30, 60, 120, 240, 480]);
    expect(backoffSeconds(8)).toBe(3600);
    expect(backoffSeconds(20)).toBe(3600);
  });
});

describe("the worker loop", () => {
  it("outlives a database error and carries on", async () => {
    const stop = new AbortController();
    const errors: unknown[] = [];
    let calls = 0;
    // A database that fails twice, then has nothing to do; the third poll stops the worker.
    const database = Object.assign(() => ({}), {
      begin: async () => {
        calls += 1;
        if (calls <= 2) throw Object.assign(new Error("connection reset"), { code: "ECONNRESET" });
        stop.abort();
        return null;
      },
    });
    await runWorker(database, {}, { workerId: "w", pollMs: 1, signal: stop.signal, onError: (error) => errors.push(error) });
    expect(calls).toBe(3);
    expect(errors).toHaveLength(2);
  });

  it("reports the error and stops when asked for a single pass", async () => {
    const database = Object.assign(() => ({}), {
      begin: async () => {
        throw new Error("connection reset");
      },
    });
    await expect(runWorker(database, {}, { workerId: "w", once: true })).rejects.toThrow("connection reset");
  });
});

// The worker against a real database: jobs queued through the app's own path (app_runtime and
// row-level security), run by the worker engine over the migration connection. Time is passed
// in, so nothing waits. Skipped when the database URLs are absent (CI has none).

const hasDb = hasAdminDb() && Boolean(process.env.DATABASE_URL);
const PREFIX = "zz-worker-test";
const tenantA = randomUUID();
const tenantB = randomUUID();
const ownerA = randomUUID();
const salesA = randomUUID();
const ownerB = randomUUID();
const only = [tenantA]; // the worker in these tests never touches any other company's jobs

const owner: TenantContext = { userId: ownerA, email: "owner-a@worker.test", tenantId: tenantA, tenantName: "A", role: "owner", branchIds: null };
const sales: TenantContext = { ...owner, userId: salesA, email: "sales-a@worker.test", role: "salesperson" };

let admin: AdminSql;
const DENIED = "42501";

async function codeOf(run: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await run();
    return undefined;
  } catch (error) {
    const e = error as { code?: string; cause?: { code?: string } };
    return e.cause?.code ?? e.code ?? "unknown";
  }
}

const later = (date: Date, seconds: number) => new Date(date.getTime() + seconds * 1000);

async function row(id: string) {
  const [job] = await admin`select * from public.jobs where id = ${id}`;
  return job;
}

/** The first moment a job is due. The database keeps microseconds; a JavaScript date does not. */
async function dueAt(id: string): Promise<Date> {
  return new Date((await row(id)).run_at.getTime() + 1);
}

describe.skipIf(!hasDb)("background jobs", () => {
  beforeAll(async () => {
    admin = adminSql();
    const stale = await admin<{ id: string }[]>`select id from public.tenants where name like ${PREFIX + "%"}`;
    await deleteTenants(
      admin,
      stale.map((r) => r.id),
    );
    await admin`insert into public.tenants (id, name, created_by) values
      (${tenantA}, ${PREFIX + " A"}, ${ownerA}), (${tenantB}, ${PREFIX + " B"}, ${ownerB})`;
    await admin`insert into public.memberships (tenant_id, user_id, email, role, created_by) values
      (${tenantA}, ${ownerA}, ${owner.email}, 'owner', ${ownerA}),
      (${tenantA}, ${salesA}, ${sales.email}, 'salesperson', ${ownerA}),
      (${tenantB}, ${ownerB}, 'owner-b@worker.test', 'owner', ${ownerB})`;
  });

  afterAll(async () => {
    await deleteTenants(admin, [tenantA, tenantB]);
    await admin.end();
    await closeDb();
  });

  it("runs a job that fails twice and succeeds on the third try, waiting longer each time", async () => {
    const id = await enqueueJob(owner, "system.ping", { note: "flaky" });
    const queued = await row(id);
    expect(queued).toMatchObject({ status: "queued", attempts: 0, kind: "system.ping", created_by: ownerA, payload: { note: "flaky" } });

    let calls = 0;
    const handlers = {
      "system.ping": async (job: { payload: unknown }) => {
        calls += 1;
        if (calls < 3) throw new Error(`boom ${calls}`);
        return { tries: calls, saw: job.payload };
      },
    };
    const t0 = await dueAt(id);

    // First try fails: back in the queue, due thirty seconds later.
    expect(await processNextJob(admin, handlers, { workerId: "w1", now: t0, tenantIds: only })).toEqual({ id, kind: "system.ping", status: "queued" });
    expect(await row(id)).toMatchObject({ status: "queued", attempts: 1, last_error: "boom 1", run_at: later(t0, 30), locked_by: null });

    // Not before it is due.
    expect(await processNextJob(admin, handlers, { workerId: "w1", now: later(t0, 29), tenantIds: only })).toBeNull();
    expect(calls).toBe(1);

    // Second try fails: due a minute after that.
    expect((await processNextJob(admin, handlers, { workerId: "w1", now: later(t0, 30), tenantIds: only }))?.status).toBe("queued");
    expect(await row(id)).toMatchObject({ status: "queued", attempts: 2, last_error: "boom 2", run_at: later(t0, 90) });

    // Third try succeeds.
    expect((await processNextJob(admin, handlers, { workerId: "w1", now: later(t0, 90), tenantIds: only }))?.status).toBe("succeeded");
    expect(await row(id)).toMatchObject({
      status: "succeeded",
      attempts: 3,
      last_error: null,
      locked_at: null,
      locked_by: null,
      finished_at: later(t0, 90),
      result: { tries: 3, saw: { note: "flaky" } },
    });

    // Finished work is never taken again.
    expect(await processNextJob(admin, handlers, { workerId: "w1", now: later(t0, 9999), tenantIds: only })).toBeNull();
    expect(calls).toBe(3);
  });

  it("sets a job aside as dead after its last allowed try", async () => {
    const id = await enqueueJob(owner, "system.ping");
    await admin`update public.jobs set max_attempts = 2 where id = ${id}`;
    const t0 = await dueAt(id);
    const handlers = {
      "system.ping": async () => {
        throw new Error("always fails");
      },
    };
    expect((await processNextJob(admin, handlers, { workerId: "w1", now: t0, tenantIds: only }))?.status).toBe("queued");
    expect((await processNextJob(admin, handlers, { workerId: "w1", now: later(t0, 30), tenantIds: only }))?.status).toBe("dead");
    expect(await row(id)).toMatchObject({ status: "dead", attempts: 2, last_error: "always fails", finished_at: later(t0, 30), locked_by: null });
    expect(await processNextJob(admin, handlers, { workerId: "w1", now: later(t0, 9999), tenantIds: only })).toBeNull();
  });

  it("sets a job of an unknown kind aside at once", async () => {
    const [{ id }] = await admin<{ id: string }[]>`
      insert into public.jobs (tenant_id, kind) values (${tenantA}, 'nobody.knows') returning id`;
    const t0 = await dueAt(id);
    expect(await processNextJob(admin, {}, { workerId: "w1", now: t0, tenantIds: only })).toEqual({ id, kind: "nobody.knows", status: "dead" });
    expect(await row(id)).toMatchObject({ status: "dead", attempts: 1, last_error: 'No handler for the job kind "nobody.knows".' });
  });

  it("gives a job to one worker only, and to another once the first has gone quiet", async () => {
    const id = await enqueueJob(owner, "system.ping");
    const t0 = await dueAt(id);
    const second = adminSql();
    try {
      const claims = await Promise.all([
        claimNextJob(admin, { workerId: "w1", now: t0, tenantIds: only }),
        claimNextJob(second, { workerId: "w2", now: t0, tenantIds: only }),
      ]);
      const winner = claims.find((job) => job !== null);
      expect(claims.filter((job) => job !== null)).toHaveLength(1);
      expect(winner).toMatchObject({ id, attempts: 1 });
      const first = (await row(id)).locked_by as string;

      // While the lock is fresh, nobody else can take it.
      expect(await claimNextJob(second, { workerId: "w3", now: later(t0, STALE_LOCK_SECONDS - 1), tenantIds: only })).toBeNull();
      // Once it is stale the job is taken over, and that counts as another try.
      const takenOver = await claimNextJob(second, { workerId: "w3", now: later(t0, STALE_LOCK_SECONDS), tenantIds: only });
      expect(takenOver).toMatchObject({ id, attempts: 2 });

      // The first worker comes back and reports success: too late, its report is ignored.
      await finishJob(admin, winner, { ok: true, result: { late: true } }, { workerId: first, now: later(t0, STALE_LOCK_SECONDS + 1) });
      expect(await row(id)).toMatchObject({ status: "running", locked_by: "w3", result: null });
      await finishJob(second, takenOver, { ok: true, result: { by: "w3" } }, { workerId: "w3", now: later(t0, STALE_LOCK_SECONDS + 2) });
      expect(await row(id)).toMatchObject({ status: "succeeded", result: { by: "w3" } });
    } finally {
      await second.end();
    }
  });

  it("ignores a late report from an earlier try, even from a worker with the same name", async () => {
    const id = await enqueueJob(owner, "system.ping");
    const t0 = await dueAt(id);
    const first = await claimNextJob(admin, { workerId: "same-name", now: t0, tenantIds: only });
    // The worker goes quiet, the lock goes stale, and a worker with the same name takes the job again.
    const second = await claimNextJob(admin, { workerId: "same-name", now: later(t0, STALE_LOCK_SECONDS), tenantIds: only });
    expect([first.attempts, second.attempts]).toEqual([1, 2]);

    await finishJob(admin, first, { ok: true, result: { from: "first try" } }, { workerId: "same-name", now: later(t0, STALE_LOCK_SECONDS + 1) });
    expect(await row(id)).toMatchObject({ status: "running", attempts: 2, result: null });
    await finishJob(admin, second, { ok: true, result: { from: "second try" } }, { workerId: "same-name", now: later(t0, STALE_LOCK_SECONDS + 2) });
    expect(await row(id)).toMatchObject({ status: "succeeded", result: { from: "second try" } });
  });

  it("uses the database's own clock when no time is given", async () => {
    const id = await enqueueJob(owner, "system.ping");
    expect(await processNextJob(admin, { "system.ping": async () => ({ pong: true }) }, { workerId: "w1", tenantIds: only })).toEqual({
      id,
      kind: "system.ping",
      status: "succeeded",
    });
    const done = await row(id);
    expect(done.finished_at.getTime()).toBeGreaterThanOrEqual(done.created_at.getTime());
  });

  it("lets any member queue work in their own company and records who asked", async () => {
    const id = await enqueueJob(sales, "system.ping");
    expect(await row(id)).toMatchObject({ tenant_id: tenantA, created_by: salesA, status: "queued" });
    const audited = await admin`select actor_user_id, actor_role, action from public.audit_log where entity_id = ${id}`;
    expect(audited).toEqual([{ actor_user_id: salesA, actor_role: "salesperson", action: "job.enqueue" }]);
    await admin`update public.jobs set status = 'dead' where id = ${id}`;
  });

  it("refuses a kind the app does not know, a job in another company, and a job that looks already run", async () => {
    await expect(enqueueJob(owner, "nobody.knows" as never)).rejects.toBeInstanceOf(UserError);
    // Queued as company B while only a member of A, with A's or B's id as the context.
    for (const context of [tenantA, tenantB]) {
      expect(
        await codeOf(() => withTenant(ownerA, context, (tx) => tx.insert(jobs).values({ tenantId: tenantB, kind: "system.ping", createdBy: ownerA }))),
      ).toBe(DENIED);
    }
    // As somebody else, or already finished.
    expect(
      await codeOf(() => withTenant(ownerA, tenantA, (tx) => tx.insert(jobs).values({ tenantId: tenantA, kind: "system.ping", createdBy: ownerB }))),
    ).toBe(DENIED);
    expect(
      await codeOf(() =>
        withTenant(ownerA, tenantA, (tx) =>
          tx.insert(jobs).values({ tenantId: tenantA, kind: "system.ping", createdBy: ownerA, status: "succeeded", result: { forged: true } }),
        ),
      ),
    ).toBe(DENIED);
    const forged = await admin`select 1 from public.jobs where tenant_id = ${tenantB}`;
    expect(forged).toHaveLength(0);
  });

  it("lets the app read jobs as an owner only, and never change or remove one", async () => {
    const seenByOwner = await withTenant(ownerA, tenantA, (tx) => tx.select({ tenantId: jobs.tenantId }).from(jobs));
    expect(seenByOwner.length).toBeGreaterThan(0);
    expect(seenByOwner.every((j) => j.tenantId === tenantA)).toBe(true);
    expect(await withTenant(salesA, tenantA, (tx) => tx.select().from(jobs))).toEqual([]);
    expect(await withTenant(ownerB, tenantB, (tx) => tx.select().from(jobs))).toEqual([]);
    expect(await withTenant(ownerA, tenantB, (tx) => tx.select().from(jobs))).toEqual([]);
    expect(await codeOf(() => withTenant(ownerA, tenantA, (tx) => tx.update(jobs).set({ status: "queued" })))).toBe(DENIED);
    expect(await codeOf(() => withTenant(ownerA, tenantA, (tx) => tx.delete(jobs)))).toBe(DENIED);
  });
});

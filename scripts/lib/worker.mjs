// The background worker's engine: claim a job, run it, record what happened.
//
// It talks to the database as postgres (it works across companies, so row-level security does not
// apply to it) and is used by scripts/worker.mjs and by the tests. Time is the database's clock,
// so workers on different machines agree on what is due; the tests pass `now` to move the clock
// instead of waiting.
//
// A job is tried up to max_attempts times. After a failure it waits longer each time (backoff);
// after the last failure it is marked dead and left for a person to look at. A job that was
// running when a worker stopped is taken again once its lock is five minutes old, so handlers
// must be safe to run twice.

export const STALE_LOCK_SECONDS = 300;
const ERROR_LIMIT = 500;

/** Seconds to wait after the given failed attempt: 30s, 1m, 2m, 4m … capped at an hour. */
export function backoffSeconds(attempt) {
  return Math.min(30 * 2 ** (Math.max(attempt, 1) - 1), 3600);
}

/** The moment to use in SQL: the given one, or the database's own clock. */
const at = (sql, now) => (now ? sql`${now}::timestamptz` : sql`now()`);

/**
 * Takes the next job that is due, or one whose worker disappeared, and marks it running.
 * `for update skip locked` lets several workers poll at once without taking the same job.
 * @param {any} sql  Connection as postgres.
 * @param {{ workerId: string, now?: Date, tenantIds?: string[] | null }} options
 * @returns {Promise<any | null>} the claimed job, or null when nothing is due.
 */
export async function claimNextJob(sql, { workerId, now, tenantIds = null }) {
  const moment = at(sql, now);
  // `tenantIds` limits the worker to some companies. The tests use it to stay out of real work.
  const scope = tenantIds ? sql`and tenant_id = any(${tenantIds})` : sql``;
  return sql.begin(async (tx) => {
    for (;;) {
      const [next] = await tx`
        select id, status, attempts, max_attempts from public.jobs
        where ((status = 'queued' and run_at <= ${moment})
            or (status = 'running' and locked_at <= ${moment} - make_interval(secs => ${STALE_LOCK_SECONDS}))) ${scope}
        order by run_at
        for update skip locked
        limit 1`;
      if (!next) return null;

      // Abandoned on its last attempt: there is nothing left to try.
      if (next.status === "running" && next.attempts >= next.max_attempts) {
        await tx`
          update public.jobs set status = 'dead', finished_at = ${moment}, locked_at = null, locked_by = null,
            last_error = 'The worker stopped while running this job.'
          where id = ${next.id}`;
        continue;
      }
      const [claimed] = await tx`
        update public.jobs set status = 'running', attempts = attempts + 1, locked_at = ${moment}, locked_by = ${workerId}
        where id = ${next.id}
        returning id, tenant_id, kind, payload, attempts, max_attempts`;
      return claimed;
    }
  });
}

/**
 * Records the outcome of a claimed job. Does nothing if another worker has since taken it over.
 * @param {any} sql
 * @param {any} job  The row claimNextJob returned.
 * @param {{ ok: true, result?: unknown } | { ok: false, error: unknown, fatal?: boolean }} outcome
 * @param {{ workerId: string, now?: Date }} options
 * @returns {Promise<"succeeded" | "queued" | "dead">}
 */
export async function finishJob(sql, job, outcome, { workerId, now }) {
  const moment = at(sql, now);
  // Only the run that still holds the job may report on it: same worker, same attempt. A worker
  // that lost its lock and comes back late changes nothing, even if it has the same name.
  const held = sql`id = ${job.id} and status = 'running' and locked_by = ${workerId} and attempts = ${job.attempts}`;
  if (outcome.ok) {
    await sql`
      update public.jobs set status = 'succeeded', finished_at = ${moment}, result = ${sql.json(outcome.result ?? null)},
        last_error = null, locked_at = null, locked_by = null
      where ${held}`;
    return "succeeded";
  }
  const error = String(outcome.error).slice(0, ERROR_LIMIT);
  if (!outcome.fatal && job.attempts < job.max_attempts) {
    await sql`
      update public.jobs set status = 'queued', run_at = ${moment} + make_interval(secs => ${backoffSeconds(job.attempts)}),
        last_error = ${error}, locked_at = null, locked_by = null
      where ${held}`;
    return "queued";
  }
  await sql`
    update public.jobs set status = 'dead', finished_at = ${moment}, last_error = ${error}, locked_at = null, locked_by = null
    where ${held}`;
  return "dead";
}

/**
 * Claims and runs one job.
 * @param {any} sql
 * @param {Record<string, (job: any, tools: { sql: any }) => Promise<unknown>>} handlers  One function per kind of job.
 * @param {{ workerId: string, now?: Date, tenantIds?: string[] | null }} options
 * @returns {Promise<{ id: string, kind: string, status: "succeeded" | "queued" | "dead" } | null>} null when nothing was due.
 */
export async function processNextJob(sql, handlers, { workerId, now, tenantIds = null }) {
  const job = await claimNextJob(sql, { workerId, now, tenantIds });
  if (!job) return null;

  const handler = Object.hasOwn(handlers, job.kind) ? handlers[job.kind] : null;
  let outcome;
  if (!handler) {
    // Trying again cannot help: no worker knows how to do this.
    outcome = { ok: false, fatal: true, error: `No handler for the job kind "${job.kind}".` };
  } else {
    try {
      outcome = { ok: true, result: await handler(job, { sql }) };
    } catch (error) {
      outcome = { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }
  const status = await finishJob(sql, job, outcome, { workerId, now });
  return { id: job.id, kind: job.kind, status };
}

/**
 * Runs jobs until told to stop, sleeping when there is nothing to do.
 * @param {any} sql
 * @param {Record<string, (job: any, tools: { sql: any }) => Promise<unknown>>} handlers
 * @param {{ workerId: string, pollMs?: number, once?: boolean, signal?: AbortSignal, log?: (job: { id: string, kind: string, status: string }) => void, onError?: (error: unknown) => void }} options
 */
export async function runWorker(sql, handlers, { workerId, pollMs = 5000, once = false, signal, log = () => {}, onError = () => {} }) {
  const pause = () =>
    new Promise((resolve) => {
      const timer = setTimeout(resolve, pollMs);
      signal?.addEventListener("abort", () => (clearTimeout(timer), resolve(undefined)), { once: true });
    });
  while (!signal?.aborted) {
    let done;
    try {
      done = await processNextJob(sql, handlers, { workerId });
    } catch (error) {
      // The database was unreachable or dropped the connection. The worker must outlive that:
      // say so, wait, and try again. A job it had claimed is taken again once its lock is stale.
      onError(error);
      if (once) throw error;
      await pause();
      continue;
    }
    if (done) {
      log(done);
      continue;
    }
    if (once) return;
    await pause();
  }
}

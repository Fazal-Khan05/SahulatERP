import { sql } from "drizzle-orm";
import { check, index, integer, jsonb, pgEnum, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { tenants } from "../tenant/schema";
import { DEFAULT_MAX_ATTEMPTS, JOB_STATUSES } from "./rules";

export const jobStatus = pgEnum("job_status", JOB_STATUSES);

// Work for the background worker. Rows survive restarts: a job that was running when the worker
// stopped is picked up again once its lock is stale.
export const jobs = pgTable(
  "jobs",
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    kind: text().notNull(),
    payload: jsonb().notNull().default({}),
    status: jobStatus().notNull().default("queued"),
    attempts: integer().notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(DEFAULT_MAX_ATTEMPTS),
    // Not before this moment. Moves forward after each failed attempt.
    runAt: timestamp("run_at", { withTimezone: true }).notNull().defaultNow(),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    lockedBy: text("locked_by"),
    lastError: text("last_error"),
    result: jsonb(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    // Null when the system queued the job itself.
    createdBy: uuid("created_by"),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [
    unique("jobs_tenant_id_id_key").on(t.tenantId, t.id),
    index("jobs_due_idx").on(t.runAt).where(sql`${t.status} = 'queued'`),
    index("jobs_running_idx").on(t.lockedAt).where(sql`${t.status} = 'running'`),
    check("jobs_attempts_range", sql`${t.attempts} >= 0 and ${t.maxAttempts} between 1 and 20`),
    check("jobs_kind_length", sql`char_length(${t.kind}) between 1 and 80`),
  ],
);

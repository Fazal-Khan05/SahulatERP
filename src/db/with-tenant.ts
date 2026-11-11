import "server-only";
import { sql } from "drizzle-orm";
import { getConnection, type Db } from "./client";

export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

/**
 * The only way to reach the database at request time. Runs `fn` in one transaction that first
 * tells Postgres who is asking and for which company; the row-level security policies read those
 * two settings and check the membership themselves, so a wrong or forged tenant id yields no rows.
 *
 * `userId` must come from the verified session, never from the request. Pass `tenantId = null`
 * for the few queries that run before a company is selected (the user's own memberships, creating
 * a company).
 */
export async function withTenant<T>(
  userId: string,
  tenantId: string | null,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  if (!UUID.test(userId)) throw new Error("withTenant: userId is not a uuid");
  if (tenantId !== null && !UUID.test(tenantId)) throw new Error("withTenant: tenantId is not a uuid");
  return getConnection().db.transaction(async (tx) => {
    // Both ids were checked above to be uuids and nothing else, so they are written into the
    // statement. A statement without parameters is one network round trip; with parameters the
    // driver needs two, and this runs at the start of every transaction.
    await tx.execute(
      sql.raw(`select set_config('app.user_id', '${userId}', true), set_config('app.tenant_id', '${tenantId ?? ""}', true)`),
    );
    return fn(tx);
  });
}

/**
 * Moves the rest of a transaction into another company. Only two commands need it, because they
 * span companies by nature: creating a company, and writing a sign-in to each company the user
 * belongs to. The policies still check the membership on every statement that follows.
 */
export async function enterTenant(tx: Tx, tenantId: string): Promise<void> {
  if (!UUID.test(tenantId)) throw new Error("enterTenant: tenantId is not a uuid");
  await tx.execute(sql.raw(`select set_config('app.tenant_id', '${tenantId}', true)`));
}

/** Closes the pool. For tests and scripts; the server keeps its pool for its lifetime. */
export async function closeDb(): Promise<void> {
  await getConnection().client.end();
}

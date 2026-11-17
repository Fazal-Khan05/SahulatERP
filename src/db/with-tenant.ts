import "server-only";
import { sql } from "drizzle-orm";
import { getConnection, type Db } from "./client";
import { identityProof } from "./identity-proof";

export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

/**
 * Tells the database who this transaction is and which company it is in, with the proof that
 * app.enter() checks (drizzle/0031_identity_proof.sql). The values go as parameters, never into
 * the statement's text: other sessions of the app's role can read each other's statements, and
 * the signature must not be among what they see.
 */
async function enter(tx: Tx, userId: string, tenantId: string | null): Promise<void> {
  const proof = identityProof(userId, tenantId);
  try {
    await tx.execute(sql`select app.enter(${userId}::uuid, ${tenantId}::uuid, ${proof.expires}::bigint, ${proof.signature}::text)`);
  } catch (error) {
    // Drizzle's error carries the statement's parameters in its message, and this statement's
    // include a signature that is good for a few minutes. It must not reach a log. What is
    // thrown instead says what the database said, and no more.
    // (The driver's own error, when there is one, is the cause; its message is the database's.)
    const cause = (error as { cause?: { code?: string; message?: string } }).cause;
    const refused = new Error(`The database did not accept who is signed in${cause?.message ? `: ${cause.message}` : "."}`) as Error & { code?: string };
    refused.code = cause?.code ?? (error as { code?: string }).code;
    throw refused;
  }
}

/**
 * The only way to reach the database at request time. Runs `fn` in one transaction that first
 * proves to Postgres who is asking and for which company; the row-level security policies ask
 * the database who that is and check the membership themselves, so a wrong or forged tenant id
 * yields no rows.
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
    await enter(tx, userId, tenantId);
    return fn(tx);
  });
}

/**
 * Moves the rest of a transaction into another company. Only two commands need it, because they
 * span companies by nature: creating a company, and writing a sign-in to each company the user
 * belongs to. `userId` is the user the transaction was opened for, from the verified session.
 * The policies still check the membership on every statement that follows.
 */
export async function enterTenant(tx: Tx, userId: string, tenantId: string): Promise<void> {
  if (!UUID.test(userId)) throw new Error("enterTenant: userId is not a uuid");
  if (!UUID.test(tenantId)) throw new Error("enterTenant: tenantId is not a uuid");
  await enter(tx, userId, tenantId);
}

/** Closes the pool. For tests and scripts; the server keeps its pool for its lifetime. */
export async function closeDb(): Promise<void> {
  await getConnection().client.end();
}

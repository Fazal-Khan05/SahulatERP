import { sql, type SQL } from "drizzle-orm";
import { identityProof } from "../../src/db/identity-proof";

// Test support only. How a test says who a transaction is when it does not go through
// withTenant(): on a connection of its own, or part-way through a statement. The database wants
// the proof app.enter() checks (drizzle/0030_identity_proof.sql); writing the old settings
// app.user_id and app.tenant_id by hand means nothing once a key is installed.

/**
 * Says who the transaction is, on a postgres.js connection or transaction:
 * `await enterAs(tx, userId, tenantId)` where a test used to set the two settings.
 */
export async function enterAs(tx: unknown, userId: string, tenantId: string | null): Promise<void> {
  const proof = identityProof(userId, tenantId);
  const run = tx as (strings: TemplateStringsArray, ...values: unknown[]) => PromiseLike<unknown>;
  await run`select app.enter(${userId}::uuid, ${tenantId}::uuid, ${proof.expires}::bigint, ${proof.signature}::text)`;
}

/**
 * The same as a piece of a Drizzle statement, for a test that moves a statement into another
 * company half-way to prove the guards ask again for every row. It is an expression that gives
 * the company as text ('' for none), as the old setting did.
 */
export function enterSql(userId: string, tenantId: string | null): SQL {
  const proof = identityProof(userId, tenantId);
  return sql`app.enter(${userId}::uuid, ${tenantId}::uuid, ${proof.expires}::bigint, ${proof.signature}::text)`;
}

/** An error whose message is written for, and safe to show to, the person using the app. */
export class UserError extends Error {}

/** Postgres error code of a failed query, looking through Drizzle's wrapper. */
export function pgCode(error: unknown): string | undefined {
  const e = error as { code?: unknown; cause?: { code?: unknown } } | null;
  const code = e?.cause?.code ?? e?.code;
  return typeof code === "string" ? code : undefined;
}

/**
 * Logs a failure without the query text or its parameters, which can hold customer data.
 * Only the context, the error name and the database or provider code are written.
 */
export function logFailure(context: string, error: unknown): void {
  const name = error instanceof Error ? error.name : typeof error;
  console.error(`[${context}] ${name}${pgCode(error) ? ` code=${pgCode(error)}` : ""}`);
}

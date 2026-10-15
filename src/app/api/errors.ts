import { ZodError } from 'zod';

const SERVER_FAULT = 'Something went wrong on the server. Please try again.';
const fail = (message: string, status: number, extra: Record<string, unknown> = {}) => Response.json({ success: false, message, ...extra }, { status });

/**
 * A refusal the member can act on: invalid input, or a business rule the engine raised with `new Error(message)`.
 * Anything else thrown by the engine (TypeError, ReferenceError, RangeError…) is a fault on our side.
 */
export function isRefusal(error: unknown): error is Error {
  return error instanceof ZodError || (error instanceof Error && error.constructor === Error);
}

/** 400 with the refusal's message, or the field errors for invalid input. */
export function refusalResponse(error: Error) {
  if (error instanceof ZodError) return fail('Check the highlighted information.', 400, { validationErrors: error.flatten() });
  return fail(error.message, 400);
}

/**
 * Maps a failure outside the engine's own refusals. Sign-in and membership problems are 401/403; a change the
 * database refused is a 500 with its own message; everything else (a bug, the database or the network being
 * unreachable) is logged here and answered with a generic 500 that reveals nothing about the cause.
 */
export function failureResponse(error: unknown, context: string) {
  if (error instanceof ZodError) return refusalResponse(error);
  const message = error instanceof Error ? error.message : '';
  if (message === 'AUTH_REQUIRED') return fail(message, 401);
  if (message === 'ACCESS_DENIED' || message === 'TENANT_REQUIRED') return fail(message, 403);
  if (message.startsWith('INTEGRITY:')) {
    console.error(`${context}: commit rejected by database`, message);
    return fail('The database rejected this change because it would break a financial integrity rule. Nothing was saved.', 500);
  }
  console.error(`${context}: unexpected failure`, error);
  return fail(SERVER_FAULT, 500);
}

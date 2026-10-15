import 'server-only';

/**
 * Reads the string fields of a JSON request body for the /auth/* route handlers. Only `application/json` is
 * accepted, so a cross-site HTML form (which cannot send that type without a CORS preflight) never gets through.
 */
export async function readJson(request: Request): Promise<Partial<Record<string, string>>> {
  if (!/^application\/json\b/i.test(request.headers.get('content-type') ?? '')) return {};
  const body: unknown = await request.json().catch(() => null);
  if (!body || typeof body !== 'object' || Array.isArray(body)) return {};
  return Object.fromEntries(Object.entries(body).filter(([, value]) => typeof value === 'string'));
}

/** An auth outcome the browser shows as is; never a Supabase error object. */
export const reply = (status: number, message?: string) => Response.json(message ? { message } : { ok: true }, { status, headers: { 'cache-control': 'no-store' } });

/** Network failures and 5xx from Supabase are not about the account, so they get their own retry message. */
export const unavailable = (error: { status?: number }) => !error.status || error.status >= 500;

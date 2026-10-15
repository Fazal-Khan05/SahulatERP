// The browser side of auth. The session is kept in HttpOnly cookies that page scripts cannot read, so the
// browser never talks to Supabase itself: it posts to the /auth/* route handlers, which use the server client.

/** POSTs JSON to an /auth/* route. Resolves to null on success, or to the message to show. */
export async function postAuth(path: string, body: Record<string, string>): Promise<string | null> {
  try {
    const response = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    if (response.ok) return null;
    const data = await response.json().catch(() => null) as { message?: string } | null;
    return data?.message || 'Something went wrong. Try again in a moment.';
  } catch {
    // fetch only rejects when the request never got an answer (offline, DNS, dropped connection), never on an HTTP error.
    return 'No internet connection. Check your connection and try again.';
  }
}

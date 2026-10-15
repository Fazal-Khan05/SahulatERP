// The session lives only in cookies the server writes: page scripts cannot read them (HttpOnly), they never
// travel over plain HTTP in production (Secure), and cross-site posts do not carry them (SameSite=Lax).
// Shared by the server client and the session-refresh proxy so both write identical cookies.
export const SESSION_COOKIE_OPTIONS = { path: '/', sameSite: 'lax', httpOnly: true, secure: process.env.NODE_ENV === 'production' } as const;

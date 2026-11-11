// The session cookies are read only on the server (there is no browser Supabase client), so
// scripts running in the page never need them. The proxy and the server client must agree.
export const sessionCookieOptions = {
  httpOnly: true,
  sameSite: "lax",
  secure: process.env.NODE_ENV === "production",
  path: "/",
} as const;

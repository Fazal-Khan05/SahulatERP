/**
 * The public base URL, used for links in auth emails. Set NEXT_PUBLIC_APP_URL locally; on Vercel
 * the production domain and the preview deployment URL are provided by the platform. Every value
 * this can return is on the Supabase Auth redirect allow-list.
 */
export function appUrl(): string {
  const configured = process.env.NEXT_PUBLIC_APP_URL;
  if (configured) return configured.replace(/\/+$/, "");
  if (process.env.VERCEL_ENV === "production" && process.env.VERCEL_PROJECT_PRODUCTION_URL) {
    return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`;
  }
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  return "http://localhost:3000";
}

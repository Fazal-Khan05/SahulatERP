import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Read-only prototype material; never imported or run.
    "reference/**",
  ]),
  {
    // Application code reaches the database only through withTenant() in src/db, and Supabase
    // only through the signed-in user's client in src/lib/supabase. Tests are exempt: they seed
    // and inspect rows over the migration connection.
    files: ["src/**/*.{ts,tsx}"],
    ignores: ["src/db/**", "src/lib/supabase/**", "src/**/*.test.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            { name: "postgres", message: "Use withTenant() from @/db." },
            { name: "drizzle-orm/postgres-js", message: "Use withTenant() from @/db." },
            { name: "@/db/client", message: "Use withTenant() from @/db." },
            { name: "@supabase/supabase-js", message: "Use createSupabaseServerClient() from @/lib/supabase/server." },
            { name: "@supabase/ssr", message: "Use createSupabaseServerClient() from @/lib/supabase/server." },
          ],
          patterns: [
            { group: ["**/tests/support/*", "**/scripts/*"], message: "Test and operator code is never imported by the app." },
          ],
        },
      ],
    },
  },
  {
    // The proxy builds its own client because it must write cookies onto the response.
    files: ["src/proxy.ts"],
    rules: { "no-restricted-imports": "off" },
  },
]);

export default eslintConfig;

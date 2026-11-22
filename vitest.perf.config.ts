import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Runs the performance company's seed, timings and reset (scripts/perf; Step 50), not tests:
// `npm run perf:seed`, `npm run perf:measure` and `npm run perf:reset`. They use the app's own
// commands and queries, so they run under the same resolver as the tests; nothing here is
// collected by `npm test`. They refuse any database that is not local (scripts/perf/seed.ts), so
// give them one: DATABASE_URL and MIGRATION_DATABASE_URL of a database made by `npm run db:local`.
if (existsSync(".env.local")) process.loadEnvFile(".env.local");

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      "server-only": fileURLToPath(new URL("./node_modules/next/dist/compiled/server-only/empty.js", import.meta.url)),
    },
  },
  test: {
    include: ["scripts/perf/*.run.ts"],
    fileParallelism: false,
    testTimeout: 24 * 60 * 60_000,
    hookTimeout: 60_000,
  },
});

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Runs the demo company's seed and reset (scripts/demo), not tests: `npm run demo:seed` and
// `npm run demo:reset`. They use the app's own commands, so they run under the same resolver as
// the tests; nothing here is collected by `npm test`. The database is the one in .env.local.
if (existsSync(".env.local")) process.loadEnvFile(".env.local");

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      "server-only": fileURLToPath(new URL("./node_modules/next/dist/compiled/server-only/empty.js", import.meta.url)),
    },
  },
  test: {
    include: ["scripts/demo/*.run.ts"],
    fileParallelism: false,
    testTimeout: 30 * 60_000,
    hookTimeout: 60_000,
  },
});

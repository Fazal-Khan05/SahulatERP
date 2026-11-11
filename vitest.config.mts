import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// The policy tests need the two database URLs. Vitest does not read .env.local by itself;
// variables already set in the environment win, and without them those tests skip (as in CI).
if (existsSync(".env.local")) process.loadEnvFile(".env.local");

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      // Next.js resolves this marker itself; outside Next.js it is an empty module.
      "server-only": fileURLToPath(new URL("./node_modules/next/dist/compiled/server-only/empty.js", import.meta.url)),
    },
  },
  test: {
    // Unit tests live beside the code; reference/ and e2e/ are never collected.
    include: ["src/**/*.test.{ts,tsx}"],
    passWithNoTests: true,
    // One file at a time: the database tests share one hosted database and its small connection
    // pool, and stall each other when they run side by side.
    fileParallelism: false,
    // The policy tests talk to the hosted database; each round trip crosses the network.
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});

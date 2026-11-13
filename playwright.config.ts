import { existsSync } from "node:fs";
import { defineConfig } from "@playwright/test";

// The specs create synthetic users and inspect rows, so they need the keys in .env.local.
if (existsSync(".env.local")) process.loadEnvFile(".env.local");

// Where this copy of the code runs its app: http://localhost:3000, unless .env.local names
// another local port in NEXT_PUBLIC_APP_URL. Two copies of the code, each with its own port and
// its own database, can then run their browser tests at the same time (docs/PARALLEL.md).
const appUrl = new URL(process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000");
const port = appUrl.hostname === "localhost" && appUrl.port ? appUrl.port : "3000";
const baseURL = `http://localhost:${port}`;

export default defineConfig({
  testDir: "./e2e",
  // The tenancy spec builds two companies step by step; one worker, in order.
  workers: 1,
  fullyParallel: false,
  // Generous: every action crosses the network to the hosted database several times.
  timeout: 240_000,
  expect: { timeout: 30_000 },
  globalSetup: "./e2e/global-setup.ts",
  globalTeardown: "./e2e/global-teardown.ts",
  use: { baseURL },
  webServer: {
    command: `npm run dev -- --port ${port}`,
    url: baseURL,
    reuseExistingServer: !process.env.CI,
  },
});

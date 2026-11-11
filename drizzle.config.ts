import { existsSync } from "node:fs";
import { defineConfig } from "drizzle-kit";

// drizzle-kit runs outside Next.js, so it does not load .env.local by itself.
if (existsSync(".env.local")) process.loadEnvFile(".env.local");

// Migrations use the Supabase session connection (port 5432), not the transaction pooler.
const url = process.env.MIGRATION_DATABASE_URL;
if (!url) throw new Error("MIGRATION_DATABASE_URL is not set; see .env.local");

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/modules/*/schema.ts",
  out: "./drizzle",
  dbCredentials: { url },
});

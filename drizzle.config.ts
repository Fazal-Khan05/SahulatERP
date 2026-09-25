import { loadEnvConfig } from '@next/env';
import { defineConfig } from 'drizzle-kit';

loadEnvConfig(process.cwd());

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './supabase/migrations/drizzle',
  dbCredentials: { url: process.env.MIGRATION_DATABASE_URL || process.env.DATABASE_URL || 'postgresql://localhost/sahulaterp' },
  strict: true,
});

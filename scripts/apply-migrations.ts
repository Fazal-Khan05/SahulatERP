import { loadEnvConfig } from '@next/env';
import postgres from 'postgres';
import { readdir } from 'node:fs/promises';
import { resolve } from 'node:path';

loadEnvConfig(process.cwd());

async function main() {
  const url = process.env.MIGRATION_DATABASE_URL || process.env.DATABASE_URL;
  if (!url) throw new Error('Set MIGRATION_DATABASE_URL or DATABASE_URL.');
  const migrations = resolve(process.cwd(), 'supabase', 'migrations');
  const files = (await readdir(migrations)).filter(file => file.endsWith('.sql')).sort();
  const sql = postgres(url, { ssl: 'require', prepare: false, max: 1, connect_timeout: 20 });
  try {
    await sql`create table if not exists public.schema_migrations (filename text primary key, applied_at timestamptz not null default now())`;
    for (const file of files) {
      const [exists] = await sql`select exists(select 1 from public.schema_migrations where filename=${file}) as applied`;
      if (exists.applied) continue;
      await sql.file(resolve(migrations, file));
      await sql`insert into public.schema_migrations(filename) values (${file})`;
      console.log(`Applied ${file}`);
    }
    console.log(JSON.stringify({ connected: true, migrations: files.length }));
  } finally { await sql.end({ timeout: 3 }); }
}

main().catch(error => {
  console.error(JSON.stringify({ connected: false, code: error.code || 'MIGRATION_FAILED', message: error.message }));
  process.exitCode = 1;
});

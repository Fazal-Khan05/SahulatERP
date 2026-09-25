import { loadEnvConfig } from '@next/env';
import postgres from 'postgres';

loadEnvConfig(process.cwd());
async function main() {
  const url = process.env.MIGRATION_DATABASE_URL || process.env.DATABASE_URL;
  if (!url) throw new Error('Set DATABASE_URL in .env.local.');
  const sql = postgres(url, { ssl: 'require', prepare: false, max: 1, connect_timeout: 15 });
  try {
    const [result] = await sql`select current_database() as database, current_user as username, version() as version`;
    const tables = await sql`select table_schema, table_name from information_schema.tables where table_schema = 'public' order by table_name`;
    const [users] = await sql`select count(*)::int as count from auth.users`;
    console.log(JSON.stringify({ connected: true, database: result.database, version: result.version, publicTables: tables.map(t => t.table_name), authUserCount: users.count }, null, 2));
  } finally { await sql.end({ timeout: 3 }); }
}
main().catch(error => {
  // Never log the URL or an error object that might contain credentials.
  console.error(JSON.stringify({ connected: false, code: error.code || 'CONNECTION_FAILED', message: String(error.message).replace(/postgres(?:ql)?:\/\/[^\s]+/g, '[REDACTED]') }));
  process.exitCode = 1;
});

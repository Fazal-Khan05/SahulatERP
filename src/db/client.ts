import "server-only";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

// The web app's only database connection: the app_runtime role through Supabase's transaction
// pooler. app_runtime cannot bypass row-level security, so nothing outside this folder may open
// a connection or use this client directly; go through withTenant().

function connect() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set; see .env.example");
  // The transaction pooler does not keep prepared statements between transactions.
  const client = postgres(url, { prepare: false, max: 5, idle_timeout: 20, connect_timeout: 10 });
  return { client, db: drizzle(client) };
}

type Connection = ReturnType<typeof connect>;

// One pool per server process, created on first use so that `next build` needs no database.
const globalForDb = globalThis as typeof globalThis & { __appRuntimeDb?: Connection };

export function getConnection(): Connection {
  return (globalForDb.__appRuntimeDb ??= connect());
}

export type Db = Connection["db"];

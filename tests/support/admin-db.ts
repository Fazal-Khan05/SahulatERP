import postgres from "postgres";

// Test support only. Connects as postgres through MIGRATION_DATABASE_URL, which bypasses
// row-level security, to seed and remove synthetic rows. Never import this from src/ application
// code (eslint.config.mjs enforces it); the app reaches the database only through withTenant().

export type AdminSql = ReturnType<typeof postgres>;

export function hasAdminDb(): boolean {
  return Boolean(process.env.MIGRATION_DATABASE_URL);
}

export function adminSql(): AdminSql {
  const url = process.env.MIGRATION_DATABASE_URL;
  if (!url) throw new Error("MIGRATION_DATABASE_URL is not set; see .env.example");
  return postgres(url, { max: 1, onnotice: () => {} });
}

// Every table of a company carries tenant_id (CLAUDE.md), so the tables to empty are read from
// the database itself, and the order from its foreign keys: a table is emptied before any table
// it points at. A step that adds a table adds nothing here.
const DELETE_ORDER = `
  with tables as (
    select c.oid, c.relname as name
    from pg_class c
    where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p')
      and exists (select 1 from pg_attribute a where a.attrelid = c.oid and a.attname = 'tenant_id' and not a.attisdropped)
  )
  select t.name,
    coalesce((select array_agg(distinct p.name) from pg_constraint k join tables p on p.oid = k.confrelid
              where k.contype = 'f' and k.conrelid = t.oid and k.confrelid <> t.oid), '{}') as parents
  from tables t order by t.name`;

/** The company tables, each before every table it points at, as far as that can be done. Exported for its own test. */
export function deleteOrder(tables: readonly { name: string; parents: readonly string[] }[]): string[] {
  const waiting = new Map(tables.map((t) => [t.name, new Set<string>()]));
  // A table waits for every table that points at it.
  for (const t of tables) for (const parent of t.parents) waiting.get(parent)?.add(t.name);
  const order: string[] = [];
  while (waiting.size > 0) {
    let free = [...waiting].filter(([, children]) => children.size === 0).map(([name]) => name).sort();
    // Tables that point at each other in a circle: no order satisfies their keys one statement at a
    // time. They are emptied in name order with every deferrable key checked at the end
    // (deleteTenants defers them), so such a pair needs one of its keys DEFERRABLE.
    if (free.length === 0) free = [[...waiting].sort(([a, x], [b, y]) => x.size - y.size || a.localeCompare(b))[0][0]];
    for (const name of free) {
      order.push(name);
      waiting.delete(name);
    }
    for (const children of waiting.values()) for (const name of free) children.delete(name);
  }
  return order;
}

let order: Promise<string[]> | undefined;

/** Removes the given tenants and everything in them. Only ever called with ids a test created. */
export async function deleteTenants(sql: AdminSql, tenantIds: string[]): Promise<void> {
  if (tenantIds.length === 0) return;
  // Read once for each test file: a migration never runs while tests do.
  order ??= sql.unsafe<{ name: string; parents: string[] }[]>(DELETE_ORDER).then((rows) => deleteOrder(rows));
  const tables = await order.catch((error) => {
    order = undefined;
    throw error;
  });
  await sql.begin(async (tx) => {
    // The ledger and stock refuse every delete except a whole company's, named for this transaction.
    await tx`select set_config('app.purge_tenants', ${tenantIds.join(",")}, true)`;
    // For tables that point at each other: a deferrable key is checked when the transaction ends.
    await tx`set constraints all deferred`;
    // One statement for each table: a key from a row to another row of its own table is checked when the statement ends.
    for (const table of tables) await tx`delete from ${tx(`public.${table}`)} where tenant_id = any(${tenantIds})`;
  });
}

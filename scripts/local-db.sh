#!/bin/sh
# npm run db:local -- <name>     e.g. npm run db:local -- app_builder
# npm run db:local -- stop
#
# A local Postgres for the database tests, which take under a minute here and about forty
# against a hosted database. It stands in for the parts of Supabase the migrations touch (the
# roles, an auth.uid() function, the storage tables). It has no Supabase Auth, so the browser
# tests still need a hosted project.
#
# Each working copy of the code uses a database of its own, so two sessions never share one.
# The command starts the server if it is not running (it does not start by itself after the
# computer restarts), makes the database if it is missing, and prints the two addresses to put
# in front of a test command. The data is kept in ~/.sahulaterp-localdb, outside the project and
# outside the temporary folders a restart empties. Nothing here holds real data or a secret:
# the server listens on this computer only and asks for no password.
set -eu

NAME="${1:-}"
BIN="${PG_BIN:-/Library/PostgreSQL/18/bin}"
DIR="${SAHULAT_LOCAL_DB:-$HOME/.sahulaterp-localdb}"
PORT=54329
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

[ -x "$BIN/initdb" ] || { echo "Postgres binaries not found in $BIN. Set PG_BIN to the folder that holds initdb, pg_ctl and psql."; exit 1; }
sql() { "$BIN/psql" -h 127.0.0.1 -p "$PORT" -v ON_ERROR_STOP=1 -q "$@"; }
running() { "$BIN/pg_ctl" -D "$DIR/pg" status >/dev/null 2>&1; }

if [ "$NAME" = "stop" ]; then
  if running; then "$BIN/pg_ctl" -D "$DIR/pg" -m fast stop >/dev/null && echo "Local database stopped."; else echo "Local database is not running."; fi
  exit 0
fi
case "$NAME" in
  "" | *[!a-z0-9_]* | app | postgres | template*)
    echo "Usage: npm run db:local -- <name>   (lower-case letters, digits and _; one name for each working copy, e.g. app_builder)"
    exit 1
    ;;
esac

# ── the server ───────────────────────────────────────────────────────────────────────────────
if [ ! -f "$DIR/pg/PG_VERSION" ]; then
  mkdir -p "$DIR"
  # UTF8, as on Supabase: without it names are counted in bytes and lower() folds ASCII only.
  "$BIN/initdb" -D "$DIR/pg" -U supabase_admin -A trust -E UTF8 >/dev/null
  FRESH=1
else
  FRESH=0
fi
if ! running; then
  # No Unix socket: only 127.0.0.1.
  "$BIN/pg_ctl" -D "$DIR/pg" -o "-p $PORT -c unix_socket_directories='' -c listen_addresses=127.0.0.1" -w start -l "$DIR/pg.log" >/dev/null
  echo "Local database started on 127.0.0.1:$PORT."
fi
if [ "$FRESH" = 1 ]; then
  sql -U supabase_admin -d postgres \
    -c "create role postgres login createrole createdb bypassrls" \
    -c "create role anon nologin" -c "create role authenticated nologin" -c "create role service_role nologin bypassrls"
fi

exists() { [ "$(sql -U supabase_admin -d postgres -Atc "select 1 from pg_database where datname = '$1'")" = "1" ]; }
migrate() { (cd "$ROOT" && MIGRATION_DATABASE_URL="postgres://postgres@127.0.0.1:$PORT/$1" node node_modules/drizzle-kit/bin.cjs migrate 2>&1 | tr '\033\r' '\n\n' | tail -1 | sed 's/^\[[0-9;]*[A-Za-z]//'; echo); }

# ── "app": made once, with every migration on main at that moment; only ever copied ─────────────
if ! exists app; then
  echo "Making the first local database (about a minute)..."
  sql -U supabase_admin -d postgres -c "create database app owner postgres"
  sql -U supabase_admin -d app <<'SQL'
grant all on schema public to postgres;
create schema auth;
create function auth.uid() returns uuid language sql stable as 'select nullif(current_setting(''request.jwt.claim.sub'', true), '''')::uuid';
create schema storage;
create table storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text);
alter table storage.objects enable row level security;
create function storage.foldername(name text) returns text[] language sql immutable as 'select string_to_array(name, ''/'')';
grant usage on schema auth, storage to authenticated, postgres;
grant all on all tables in schema storage to postgres with grant option;
alter table storage.objects owner to postgres;
alter table storage.buckets owner to postgres;
SQL
  sql -U postgres -d app \
    -c "alter default privileges in schema public grant all on tables to anon, authenticated, service_role" \
    -c "alter default privileges in schema public grant all on sequences to anon, authenticated, service_role" \
    -c "alter default privileges in schema public grant all on functions to anon, authenticated, service_role"
  migrate app
fi

# ── this working copy's own database ─────────────────────────────────────────────────────────
if ! exists "$NAME"; then
  sql -U supabase_admin -d postgres -c "create database $NAME template app"
  # Whatever this working copy has beyond "app".
  migrate "$NAME"
  echo "Made the database $NAME."
fi

echo "Migrations in $NAME: $(sql -U postgres -d "$NAME" -Atc "select count(*) from drizzle.__drizzle_migrations")"
echo
echo "Put these in front of a test command (they win over .env.local for that command only):"
echo "  DATABASE_URL=postgres://app_runtime@127.0.0.1:$PORT/$NAME MIGRATION_DATABASE_URL=postgres://postgres@127.0.0.1:$PORT/$NAME npx vitest run"
echo "To apply a new migration to it:"
echo "  MIGRATION_DATABASE_URL=postgres://postgres@127.0.0.1:$PORT/$NAME npm run db:migrate"

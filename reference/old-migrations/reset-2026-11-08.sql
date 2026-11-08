-- One-off reset of the prototype schema (run 8 Nov 2026 against the linked Supabase project).
--
-- Drops every object the prototype created in public and private: the migrations now in
-- reference/old-migrations/ plus public.schema_migrations from the old scripts/apply-migrations.ts.
-- Leaves alone: auth (users included), storage buckets and files, extensions, vault, and the
-- Supabase-managed public.rls_auto_enable() function behind the ensure_rls event trigger.
--
-- Guarded: it does nothing unless a prototype-only object is still present, so re-running it can
-- never drop tables the rebuild creates under the same names (tenants, journals, ...).
-- No CASCADE anywhere: an unexpected dependency fails the whole transaction instead of spreading.

begin;

do $$
begin
  if to_regclass('public.workspace_snapshots') is null
     and to_regprocedure('public.commit_workspace(uuid, integer, jsonb, boolean)') is null then
    raise notice 'Prototype schema not found; nothing to reset.';
    return;
  end if;

  -- Storage policy from 202610140001. It calls private.can_access, so it cannot outlive the private
  -- schema. The branding bucket and its files stay.
  drop policy if exists branding_member_read on storage.objects;

  -- Tables, with their RLS policies (tenant_read), triggers (journals_immutable,
  -- journal_balance_check), constraints and indexes. fbr_simulations and bank_statement_lines were
  -- already dropped by 202610140001; listed in case that migration never ran here.
  drop table if exists
    public.audit_events,
    public.follow_ups,
    public.payroll_runs,
    public.shipments,
    public.commission_movements,
    public.commissions,
    public.commission_plans,
    public.receipts,
    public.stock_movements,
    public.journal_lines,
    public.journals,
    public.documents,
    public.employees,
    public.items,
    public.parties,
    public.workspace_snapshots,
    public.fiscal_periods,
    public.warehouses,
    public.branches,
    public.companies,
    public.memberships,
    public.tenants,
    public.fbr_simulations,
    public.bank_statement_lines,
    public.schema_migrations;

  -- Functions.
  drop function if exists public.commit_workspace(uuid, integer, jsonb, boolean);
  drop function if exists private.sync_projection(uuid, jsonb, boolean);
  drop function if exists private.reads_full_ledger(uuid);
  drop function if exists private.has_role(uuid, public.app_role[]);
  drop function if exists private.can_access(uuid);
  drop function if exists private.check_balanced_journal();
  drop function if exists private.reject_posted_change();

  -- Types.
  drop type if exists public.app_role;

  -- The private schema, now empty.
  drop schema if exists private;
end $$;

-- public itself is kept rather than dropped and recreated: it is owned by pg_database_owner and carries
-- supabase_admin's default privileges, neither of which the postgres role can recreate. Restate the
-- grants Supabase sets up for it.
grant usage on schema public to postgres, anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to postgres, anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to postgres, anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to postgres, anon, authenticated, service_role;

commit;

begin;

create extension if not exists pgcrypto;
create schema if not exists private;

do $$ begin
  create type public.app_role as enum (
    'Owner', 'Accountant', 'Sales Manager', 'Salesperson', 'Recovery Officer',
    'Warehouse Manager', 'Payroll Administrator', 'Auditor'
  );
exception when duplicate_object then null; end $$;

create table if not exists public.tenants (
  id uuid primary key,
  name text not null,
  is_demo boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.memberships (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role public.app_role not null,
  branch_ids text[] not null default '{}',
  active boolean not null default true,
  created_at timestamptz not null default now(),
  primary key (tenant_id, user_id)
);

create or replace function private.can_access(check_tenant uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.memberships m
    where m.tenant_id = check_tenant and m.user_id = auth.uid() and m.active
  );
$$;

create table if not exists public.companies (
  tenant_id uuid primary key references public.tenants(id) on delete cascade,
  name text not null,
  tax_id text not null default '',
  address text not null default '',
  base_currency text not null default 'PKR' check (base_currency = 'PKR'),
  settings jsonb not null default '{}',
  updated_at timestamptz not null default now()
);

create table if not exists public.branches (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  id text not null,
  name text not null,
  primary key (tenant_id, id)
);

create table if not exists public.warehouses (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  id text not null,
  branch_id text not null,
  name text not null,
  primary key (tenant_id, id),
  foreign key (tenant_id, branch_id) references public.branches(tenant_id, id)
);

create table if not exists public.fiscal_periods (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  month text not null check (month ~ '^\\d{4}-(0[1-9]|1[0-2])$'),
  locked boolean not null default false,
  primary key (tenant_id, month)
);

create table if not exists public.workspace_snapshots (
  tenant_id uuid primary key references public.tenants(id) on delete cascade,
  revision integer not null default 0 check (revision >= 0),
  schema_version integer not null default 1,
  data jsonb not null,
  updated_at timestamptz not null default now()
);

create table if not exists public.parties (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  id text not null,
  party_type text not null check (party_type in ('customer','supplier')),
  name text not null,
  tax_id text not null default '',
  credit_limit numeric(20,4) not null default 0,
  data jsonb not null,
  primary key (tenant_id, id)
);

create table if not exists public.items (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  id text not null,
  sku text not null,
  name text not null,
  category text not null,
  data jsonb not null,
  primary key (tenant_id, id),
  unique (tenant_id, sku)
);

create table if not exists public.employees (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  id text not null,
  name text not null,
  role_name text not null,
  active boolean not null,
  data jsonb not null,
  primary key (tenant_id, id)
);

create table if not exists public.documents (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  id text not null,
  number text not null,
  kind text not null,
  status text not null check (status in ('draft','submitted','cancelled')),
  party_id text not null,
  warehouse_id text not null,
  document_date date not null,
  currency text not null check (currency in ('PKR','USD','CNY')),
  total numeric(20,4) not null,
  paid numeric(20,4) not null default 0,
  returned numeric(20,4) not null default 0,
  data jsonb not null,
  primary key (tenant_id, id),
  unique (tenant_id, number),
  foreign key (tenant_id, party_id) references public.parties(tenant_id, id),
  foreign key (tenant_id, warehouse_id) references public.warehouses(tenant_id, id)
);

create table if not exists public.journals (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  id text not null,
  number text not null,
  source_id text not null,
  journal_date date not null,
  memo text not null,
  status text not null check (status in ('draft','posted')),
  reversal_of text,
  data jsonb not null,
  primary key (tenant_id, id),
  unique (tenant_id, number),
  unique (tenant_id, source_id),
  foreign key (tenant_id, reversal_of) references public.journals(tenant_id, id)
);

create table if not exists public.journal_lines (
  tenant_id uuid not null,
  journal_id text not null,
  line_no integer not null,
  account_code text not null,
  debit numeric(20,4) not null default 0 check (debit >= 0),
  credit numeric(20,4) not null default 0 check (credit >= 0),
  primary key (tenant_id, journal_id, line_no),
  foreign key (tenant_id, journal_id) references public.journals(tenant_id, id) on delete cascade,
  check ((debit = 0) <> (credit = 0))
);

create table if not exists public.stock_movements (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  id text not null,
  item_id text not null,
  warehouse_id text not null,
  movement_date date not null,
  quantity numeric(20,4) not null,
  value numeric(20,4) not null,
  source_id text not null,
  movement_type text not null,
  primary key (tenant_id, id),
  foreign key (tenant_id, item_id) references public.items(tenant_id, id),
  foreign key (tenant_id, warehouse_id) references public.warehouses(tenant_id, id)
);

create table if not exists public.receipts (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  id text not null,
  number text not null,
  party_id text not null,
  receipt_date date not null,
  amount numeric(20,4) not null,
  method text not null check (method in ('bank','cash','cheque')),
  status text not null check (status in ('received','deposited','cleared','bounced')),
  data jsonb not null,
  primary key (tenant_id, id),
  unique (tenant_id, number),
  foreign key (tenant_id, party_id) references public.parties(tenant_id, id)
);

create table if not exists public.commission_plans (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  id text not null,
  name text not null,
  effective_from date not null,
  effective_to date not null,
  data jsonb not null,
  primary key (tenant_id, id),
  check (effective_to >= effective_from)
);

create table if not exists public.commissions (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  id text not null,
  invoice_id text not null,
  employee_id text not null,
  earned numeric(20,4) not null,
  released numeric(20,4) not null,
  paid numeric(20,4) not null,
  approved boolean not null default false,
  data jsonb not null,
  primary key (tenant_id, id),
  foreign key (tenant_id, employee_id) references public.employees(tenant_id, id)
);

create table if not exists public.commission_movements (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  id text not null,
  commission_id text not null,
  source_id text not null,
  movement_date date not null,
  movement_type text not null,
  amount numeric(20,4) not null,
  data jsonb not null,
  primary key (tenant_id, id),
  foreign key (tenant_id, commission_id) references public.commissions(tenant_id, id)
);

create table if not exists public.shipments (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  id text not null,
  number text not null,
  status text not null,
  supplier_id text not null,
  eta date not null,
  data jsonb not null,
  primary key (tenant_id, id),
  unique (tenant_id, number)
);

create table if not exists public.payroll_runs (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  id text not null,
  number text not null,
  payroll_month text not null,
  status text not null,
  total numeric(20,4) not null,
  data jsonb not null,
  primary key (tenant_id, id),
  unique (tenant_id, payroll_month)
);

create table if not exists public.fbr_simulations (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  id text not null,
  invoice_id text not null,
  status text not null,
  attempts integer not null default 0,
  reference text not null default '',
  data jsonb not null,
  primary key (tenant_id, id)
);

create table if not exists public.bank_statement_lines (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  id text not null,
  statement_date date not null,
  description text not null,
  amount numeric(20,4) not null,
  matched_journal_id text,
  data jsonb not null,
  primary key (tenant_id, id)
);

create table if not exists public.audit_events (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  id text not null,
  occurred_at timestamptz not null,
  actor text not null,
  role_name text not null,
  action text not null,
  source_id text not null,
  detail text not null,
  primary key (tenant_id, id)
);

create or replace function private.reject_posted_change()
returns trigger language plpgsql set search_path = '' as $$
begin
  if old.status = 'posted' then raise exception 'Posted journals are immutable; create a reversal.'; end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end $$;

drop trigger if exists journals_immutable on public.journals;
create trigger journals_immutable before update or delete on public.journals
for each row execute function private.reject_posted_change();

create or replace function private.check_balanced_journal()
returns trigger language plpgsql set search_path = '' as $$
declare check_tenant uuid; check_journal text; difference numeric(20,4);
begin
  check_tenant := coalesce(new.tenant_id, old.tenant_id);
  check_journal := coalesce(new.journal_id, old.journal_id);
  select coalesce(sum(debit-credit),0) into difference
  from public.journal_lines where tenant_id=check_tenant and journal_id=check_journal;
  if difference <> 0 then raise exception 'Journal % is not balanced', check_journal; end if;
  return null;
end $$;

drop trigger if exists journal_balance_check on public.journal_lines;
create constraint trigger journal_balance_check after insert or update or delete on public.journal_lines
deferrable initially deferred for each row execute function private.check_balanced_journal();

do $$
declare table_name text;
begin
  foreach table_name in array array[
    'tenants','memberships','companies','branches','warehouses','fiscal_periods','workspace_snapshots',
    'parties','items','employees','documents','journals','journal_lines','stock_movements','receipts',
    'commission_plans','commissions','commission_movements','shipments','payroll_runs','fbr_simulations',
    'bank_statement_lines','audit_events'
  ] loop
    execute format('alter table public.%I enable row level security', table_name);
    execute format('alter table public.%I force row level security', table_name);
    execute format('drop policy if exists tenant_read on public.%I', table_name);
    if table_name = 'tenants' then
      execute 'create policy tenant_read on public.tenants for select to authenticated using (private.can_access(id))';
    else
      execute format('create policy tenant_read on public.%I for select to authenticated using (private.can_access(tenant_id))', table_name);
    end if;
  end loop;
end $$;

revoke all on all tables in schema public from anon, authenticated;
grant select on public.tenants, public.memberships, public.companies, public.branches, public.warehouses,
  public.fiscal_periods, public.workspace_snapshots, public.parties, public.items, public.employees,
  public.documents, public.journals, public.journal_lines, public.stock_movements, public.receipts,
  public.commission_plans, public.commissions, public.commission_movements, public.shipments,
  public.payroll_runs, public.fbr_simulations, public.bank_statement_lines, public.audit_events to authenticated;
grant usage on schema private to authenticated;
grant execute on function private.can_access(uuid) to authenticated;

commit;

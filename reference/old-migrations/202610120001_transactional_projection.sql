begin;

-- 1. Link a member to their employee record so salespeople act as, and see, only themselves.
alter table public.memberships add column if not exists employee_id text;

-- Persisted recovery follow-ups (previously validated then discarded).
create table if not exists public.follow_ups (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  id text not null,
  party_id text not null,
  follow_date date not null,
  next_date date not null,
  note text not null,
  actor text not null,
  primary key (tenant_id, id),
  foreign key (tenant_id, party_id) references public.parties(tenant_id, id)
);

-- 2. Role-aware read policies. Writes go only through commit_workspace below.
create or replace function private.has_role(check_tenant uuid, allowed public.app_role[])
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.memberships m
    where m.tenant_id = check_tenant and m.user_id = auth.uid() and m.active and m.role = any(allowed)
  );
$$;
grant execute on function private.has_role(uuid, public.app_role[]) to authenticated;

do $$
declare
  table_name text;
  ledger constant text := 'array[''Owner'',''Accountant'',''Auditor'']::public.app_role[]';
  payroll constant text := 'array[''Owner'',''Accountant'',''Auditor'',''Payroll Administrator'']::public.app_role[]';
  commission constant text := 'array[''Owner'',''Accountant'',''Auditor'',''Sales Manager'',''Payroll Administrator'']::public.app_role[]';
  recovery constant text := 'array[''Owner'',''Accountant'',''Auditor'',''Sales Manager'',''Recovery Officer'']::public.app_role[]';
  rule text;
begin
  alter table public.follow_ups enable row level security;
  alter table public.follow_ups force row level security;
  foreach table_name in array array[
    'memberships','workspace_snapshots','journals','journal_lines','audit_events','bank_statement_lines',
    'payroll_runs','employees','commissions','commission_movements','commission_plans','follow_ups'
  ] loop
    rule := case
      when table_name = 'memberships' then 'user_id = auth.uid() or private.has_role(tenant_id, array[''Owner'']::public.app_role[])'
      when table_name in ('payroll_runs','employees') then format('private.has_role(tenant_id, %s)', payroll)
      when table_name in ('commissions','commission_movements','commission_plans') then format('private.has_role(tenant_id, %s)', commission)
      when table_name = 'follow_ups' then format('private.has_role(tenant_id, %s)', recovery)
      else format('private.has_role(tenant_id, %s)', ledger)
    end;
    execute format('drop policy if exists tenant_read on public.%I', table_name);
    execute format('create policy tenant_read on public.%I for select to authenticated using (%s)', table_name, rule);
  end loop;
end $$;
grant select on public.follow_ups to authenticated;

-- 3. Posted journals stay immutable except during an explicit projection rebuild inside one transaction.
create or replace function private.reject_posted_change()
returns trigger language plpgsql set search_path = '' as $$
begin
  if old.status = 'posted'
    and coalesce(current_setting('app.demo_reset', true), 'off') <> 'on'
    and coalesce(current_setting('app.projection_rebuild', true), 'off') <> 'on' then
    raise exception 'Posted journals are immutable; create a reversal.';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end $$;

-- 4. Project a snapshot into the relational tables. Existing posted journals, journal lines, stock and
-- commission movements and audit events are append-only: re-sending them unchanged is a no-op, and a
-- changed posted journal raises through the immutability trigger.
create or replace function private.sync_projection(p_tenant uuid, p_data jsonb, p_rebuild boolean)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if p_rebuild then
    perform set_config('app.projection_rebuild', 'on', true);
    delete from public.follow_ups where tenant_id = p_tenant;
    delete from public.audit_events where tenant_id = p_tenant;
    delete from public.bank_statement_lines where tenant_id = p_tenant;
    delete from public.fbr_simulations where tenant_id = p_tenant;
    delete from public.payroll_runs where tenant_id = p_tenant;
    delete from public.shipments where tenant_id = p_tenant;
    delete from public.commission_movements where tenant_id = p_tenant;
    delete from public.commissions where tenant_id = p_tenant;
    delete from public.commission_plans where tenant_id = p_tenant;
    delete from public.receipts where tenant_id = p_tenant;
    delete from public.stock_movements where tenant_id = p_tenant;
    delete from public.journal_lines where tenant_id = p_tenant;
    delete from public.journals where tenant_id = p_tenant;
    delete from public.documents where tenant_id = p_tenant;
    delete from public.employees where tenant_id = p_tenant;
    delete from public.items where tenant_id = p_tenant;
    delete from public.parties where tenant_id = p_tenant;
    delete from public.fiscal_periods where tenant_id = p_tenant;
    delete from public.warehouses where tenant_id = p_tenant;
    delete from public.branches where tenant_id = p_tenant;
    delete from public.companies where tenant_id = p_tenant;
    perform set_config('app.projection_rebuild', 'off', true);
  end if;

  insert into public.companies (tenant_id, name, tax_id, address, base_currency, settings)
  values (p_tenant, p_data #>> '{company,name}', coalesce(p_data #>> '{company,taxId}', ''), coalesce(p_data #>> '{company,address}', ''),
          coalesce(p_data #>> '{company,currency}', 'PKR'), coalesce(p_data -> 'settings', '{}'))
  on conflict (tenant_id) do update set name = excluded.name, tax_id = excluded.tax_id, address = excluded.address,
    settings = excluded.settings, updated_at = now();

  insert into public.branches (tenant_id, id, name)
  select p_tenant, x ->> 'id', x ->> 'name' from jsonb_array_elements(coalesce(p_data -> 'branches', '[]')) x
  on conflict (tenant_id, id) do update set name = excluded.name;

  insert into public.warehouses (tenant_id, id, branch_id, name)
  select p_tenant, x ->> 'id', x ->> 'branchId', x ->> 'name' from jsonb_array_elements(coalesce(p_data -> 'warehouses', '[]')) x
  on conflict (tenant_id, id) do update set branch_id = excluded.branch_id, name = excluded.name;

  insert into public.fiscal_periods (tenant_id, month, locked)
  select p_tenant, x ->> 'month', (x ->> 'locked')::boolean from jsonb_array_elements(coalesce(p_data -> 'periods', '[]')) x
  on conflict (tenant_id, month) do update set locked = excluded.locked;

  insert into public.parties (tenant_id, id, party_type, name, tax_id, credit_limit, data)
  select p_tenant, x ->> 'id', x ->> 'type', x ->> 'name', coalesce(x ->> 'taxId', ''), (x ->> 'creditLimit')::numeric, x
  from jsonb_array_elements(coalesce(p_data -> 'parties', '[]')) x
  on conflict (tenant_id, id) do update set name = excluded.name, tax_id = excluded.tax_id, credit_limit = excluded.credit_limit, data = excluded.data;

  insert into public.items (tenant_id, id, sku, name, category, data)
  select p_tenant, x ->> 'id', x ->> 'sku', x ->> 'name', x ->> 'category', x
  from jsonb_array_elements(coalesce(p_data -> 'items', '[]')) x
  on conflict (tenant_id, id) do update set sku = excluded.sku, name = excluded.name, category = excluded.category, data = excluded.data;

  insert into public.employees (tenant_id, id, name, role_name, active, data)
  select p_tenant, x ->> 'id', x ->> 'name', x ->> 'role', (x ->> 'active')::boolean, x
  from jsonb_array_elements(coalesce(p_data -> 'employees', '[]')) x
  on conflict (tenant_id, id) do update set name = excluded.name, role_name = excluded.role_name, active = excluded.active, data = excluded.data;

  insert into public.documents (tenant_id, id, number, kind, status, party_id, warehouse_id, document_date, currency, total, paid, returned, data)
  select p_tenant, x ->> 'id', x ->> 'number', x ->> 'kind', x ->> 'status', x ->> 'partyId', x ->> 'warehouseId', (x ->> 'date')::date,
         x ->> 'currency', (x ->> 'total')::numeric, (x ->> 'paid')::numeric, (x ->> 'returned')::numeric, x
  from jsonb_array_elements(coalesce(p_data -> 'documents', '[]')) x
  on conflict (tenant_id, id) do update set status = excluded.status, total = excluded.total, paid = excluded.paid,
    returned = excluded.returned, data = excluded.data;

  insert into public.journals (tenant_id, id, number, source_id, journal_date, memo, status, reversal_of, data)
  select p_tenant, x ->> 'id', x ->> 'number', x ->> 'sourceId', (x ->> 'date')::date, x ->> 'memo', x ->> 'status', x ->> 'reversalOf', x
  from jsonb_array_elements(coalesce(p_data -> 'journals', '[]')) x
  on conflict (tenant_id, id) do update set data = excluded.data where public.journals.data is distinct from excluded.data;

  insert into public.journal_lines (tenant_id, journal_id, line_no, account_code, debit, credit)
  select p_tenant, x ->> 'id', line.ordinality, line.value ->> 'account', (line.value ->> 'debit')::numeric, (line.value ->> 'credit')::numeric
  from jsonb_array_elements(coalesce(p_data -> 'journals', '[]')) x
  cross join lateral jsonb_array_elements(x -> 'lines') with ordinality line
  on conflict (tenant_id, journal_id, line_no) do nothing;

  insert into public.stock_movements (tenant_id, id, item_id, warehouse_id, movement_date, quantity, value, source_id, movement_type)
  select p_tenant, x ->> 'id', x ->> 'itemId', x ->> 'warehouseId', (x ->> 'date')::date, (x ->> 'quantity')::numeric, (x ->> 'value')::numeric, x ->> 'sourceId', x ->> 'type'
  from jsonb_array_elements(coalesce(p_data -> 'stockMoves', '[]')) x
  on conflict (tenant_id, id) do nothing;

  insert into public.receipts (tenant_id, id, number, party_id, receipt_date, amount, method, status, data)
  select p_tenant, x ->> 'id', x ->> 'number', x ->> 'partyId', (x ->> 'date')::date, (x ->> 'amount')::numeric, x ->> 'method', x ->> 'status', x
  from jsonb_array_elements(coalesce(p_data -> 'receipts', '[]')) x
  on conflict (tenant_id, id) do update set status = excluded.status, data = excluded.data;

  insert into public.commission_plans (tenant_id, id, name, effective_from, effective_to, data)
  select p_tenant, x ->> 'id', x ->> 'name', (x ->> 'effectiveFrom')::date, (x ->> 'effectiveTo')::date, x
  from jsonb_array_elements(coalesce(p_data -> 'plans', '[]')) x
  on conflict (tenant_id, id) do update set name = excluded.name, effective_from = excluded.effective_from, effective_to = excluded.effective_to, data = excluded.data;

  insert into public.commissions (tenant_id, id, invoice_id, employee_id, earned, released, paid, approved, data)
  select p_tenant, x ->> 'id', x ->> 'invoiceId', x ->> 'employeeId', (x ->> 'earned')::numeric, (x ->> 'released')::numeric, (x ->> 'paid')::numeric, (x ->> 'approved')::boolean, x
  from jsonb_array_elements(coalesce(p_data -> 'commissions', '[]')) x
  on conflict (tenant_id, id) do update set earned = excluded.earned, released = excluded.released, paid = excluded.paid,
    approved = excluded.approved, data = excluded.data;

  insert into public.commission_movements (tenant_id, id, commission_id, source_id, movement_date, movement_type, amount, data)
  select p_tenant, x ->> 'id', x ->> 'commissionId', x ->> 'sourceId', (x ->> 'date')::date, x ->> 'type', (x ->> 'amount')::numeric, x
  from jsonb_array_elements(coalesce(p_data -> 'commissionMovements', '[]')) x
  on conflict (tenant_id, id) do nothing;

  insert into public.shipments (tenant_id, id, number, status, supplier_id, eta, data)
  select p_tenant, x ->> 'id', x ->> 'number', x ->> 'status', x ->> 'supplierId', (x ->> 'eta')::date, x
  from jsonb_array_elements(coalesce(p_data -> 'shipments', '[]')) x
  on conflict (tenant_id, id) do update set status = excluded.status, eta = excluded.eta, data = excluded.data;

  insert into public.payroll_runs (tenant_id, id, number, payroll_month, status, total, data)
  select p_tenant, x ->> 'id', x ->> 'number', x ->> 'month', x ->> 'status', (x ->> 'total')::numeric, x
  from jsonb_array_elements(coalesce(p_data -> 'payrolls', '[]')) x
  on conflict (tenant_id, id) do update set status = excluded.status, total = excluded.total, data = excluded.data;

  insert into public.fbr_simulations (tenant_id, id, invoice_id, status, attempts, reference, data)
  select p_tenant, x ->> 'id', x ->> 'invoiceId', x ->> 'status', (x ->> 'attempts')::integer, coalesce(x ->> 'reference', ''), x
  from jsonb_array_elements(coalesce(p_data -> 'fbr', '[]')) x
  on conflict (tenant_id, id) do update set status = excluded.status, attempts = excluded.attempts, reference = excluded.reference, data = excluded.data;

  insert into public.bank_statement_lines (tenant_id, id, statement_date, description, amount, matched_journal_id, data)
  select p_tenant, x ->> 'id', (x ->> 'date')::date, x ->> 'description', (x ->> 'amount')::numeric, x ->> 'matchedJournalId', x
  from jsonb_array_elements(coalesce(p_data -> 'bankLines', '[]')) x
  on conflict (tenant_id, id) do update set matched_journal_id = excluded.matched_journal_id, data = excluded.data;

  insert into public.follow_ups (tenant_id, id, party_id, follow_date, next_date, note, actor)
  select p_tenant, x ->> 'id', x ->> 'partyId', (x ->> 'date')::date, (x ->> 'nextDate')::date, x ->> 'note', x ->> 'actor'
  from jsonb_array_elements(coalesce(p_data -> 'followUps', '[]')) x
  on conflict (tenant_id, id) do nothing;

  insert into public.audit_events (tenant_id, id, occurred_at, actor, role_name, action, source_id, detail)
  select p_tenant, x ->> 'id', (x ->> 'date')::timestamptz, x ->> 'actor', x ->> 'role', x ->> 'action', x ->> 'sourceId', x ->> 'detail'
  from jsonb_array_elements(coalesce(p_data -> 'audit', '[]')) x
  on conflict (tenant_id, id) do nothing;
end $$;

-- 5. The only write entry point. Snapshot and projection change together or not at all; the deferred
-- balance trigger runs at commit, so an unbalanced journal rolls back the snapshot too.
-- Returns the new revision, or null when p_expected is stale (another change was saved first).
create or replace function public.commit_workspace(p_tenant uuid, p_expected integer, p_data jsonb, p_rebuild boolean default false)
returns integer language plpgsql security definer set search_path = '' as $$
declare next_revision integer := (p_data ->> 'revision')::integer;
begin
  if jsonb_typeof(p_data) <> 'object' then raise exception 'Snapshot must be a JSON object.'; end if;
  if (p_data ->> 'tenantId')::uuid is distinct from p_tenant then raise exception 'Snapshot tenant does not match.'; end if;
  if p_rebuild and not exists (select 1 from public.tenants where id = p_tenant and is_demo) then
    raise exception 'Only demo workspaces can be rebuilt.';
  end if;
  if next_revision is distinct from p_expected + 1 then raise exception 'Snapshot revision must advance by exactly one.'; end if;
  update public.workspace_snapshots set data = p_data, revision = next_revision, updated_at = now()
  where tenant_id = p_tenant and revision = p_expected;
  if not found then return null; end if;
  perform private.sync_projection(p_tenant, p_data, p_rebuild);
  return next_revision;
end $$;

revoke all on function public.commit_workspace(uuid, integer, jsonb, boolean) from public, anon, authenticated;
revoke all on function private.sync_projection(uuid, jsonb, boolean) from public, anon, authenticated;
grant execute on function public.commit_workspace(uuid, integer, jsonb, boolean) to service_role;

-- 6. Earlier seeding stored some snapshots as a JSON string rather than an object; store them as objects.
update public.workspace_snapshots set data = (data #>> '{}')::jsonb where jsonb_typeof(data) = 'string';

-- 7. Reconcile the projections that drifted while only the snapshot was written (QA finding SQA-02).
select private.sync_projection(tenant_id, data, true) from public.workspace_snapshots;

commit;

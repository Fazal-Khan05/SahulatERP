begin;

-- 1. Out of scope since 13 Oct 2026: FBR digital invoicing and bank statement reconciliation.
drop policy if exists tenant_read on public.bank_statement_lines;
drop table if exists public.bank_statement_lines;
drop table if exists public.fbr_simulations;

-- 2. Company contact, enabled modules, setup state and document branding, projected from the snapshot.
alter table public.companies
  add column if not exists phone text not null default '',
  add column if not exists email text not null default '',
  add column if not exists enabled_modules text[] not null default '{}',
  add column if not exists setup_complete boolean not null default false,
  add column if not exists branding jsonb not null default '{}';

-- 3. Projection: drop the removed tables, write the new company columns.
create or replace function private.sync_projection(p_tenant uuid, p_data jsonb, p_rebuild boolean)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if p_rebuild then
    perform set_config('app.projection_rebuild', 'on', true);
    delete from public.follow_ups where tenant_id = p_tenant;
    delete from public.audit_events where tenant_id = p_tenant;
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

  insert into public.companies (tenant_id, name, tax_id, address, phone, email, base_currency, settings, enabled_modules, setup_complete, branding)
  values (p_tenant, p_data #>> '{company,name}', coalesce(p_data #>> '{company,taxId}', ''), coalesce(p_data #>> '{company,address}', ''),
          coalesce(p_data #>> '{company,phone}', ''), coalesce(p_data #>> '{company,email}', ''),
          coalesce(p_data #>> '{company,currency}', 'PKR'), coalesce(p_data -> 'settings', '{}'),
          coalesce((select array_agg(m) from jsonb_array_elements_text(coalesce(p_data -> 'modules', '[]')) m), '{}'),
          coalesce((p_data #>> '{setup,complete}')::boolean, false), coalesce(p_data -> 'branding', '{}'))
  on conflict (tenant_id) do update set name = excluded.name, tax_id = excluded.tax_id, address = excluded.address,
    phone = excluded.phone, email = excluded.email, settings = excluded.settings, enabled_modules = excluded.enabled_modules,
    setup_complete = excluded.setup_complete, branding = excluded.branding, updated_at = now();

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

  insert into public.follow_ups (tenant_id, id, party_id, follow_date, next_date, note, actor)
  select p_tenant, x ->> 'id', x ->> 'partyId', (x ->> 'date')::date, (x ->> 'nextDate')::date, x ->> 'note', x ->> 'actor'
  from jsonb_array_elements(coalesce(p_data -> 'followUps', '[]')) x
  on conflict (tenant_id, id) do nothing;

  insert into public.audit_events (tenant_id, id, occurred_at, actor, role_name, action, source_id, detail)
  select p_tenant, x ->> 'id', (x ->> 'date')::timestamptz, x ->> 'actor', x ->> 'role', x ->> 'action', x ->> 'sourceId', x ->> 'detail'
  from jsonb_array_elements(coalesce(p_data -> 'audit', '[]')) x
  on conflict (tenant_id, id) do nothing;
end $$;

-- 4. Private storage bucket for logos and letterheads. Objects live at <tenant_id>/<kind>.<ext>.
-- Members of the tenant may read; writes happen only through the API route with the service role,
-- so no insert/update/delete policy is granted to authenticated users.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('branding', 'branding', false, 2097152, array['image/png', 'image/jpeg'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists branding_member_read on storage.objects;
create policy branding_member_read on storage.objects for select to authenticated
  using (bucket_id = 'branding' and private.can_access(((storage.foldername(name))[1])::uuid));

-- 5. Re-project every snapshot so the new company columns are filled.
select private.sync_projection(tenant_id, data, false) from public.workspace_snapshots;

commit;

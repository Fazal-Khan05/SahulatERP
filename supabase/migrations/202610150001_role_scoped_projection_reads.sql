begin;

-- QA defect D-07 (SEC-030): any active member could read every projection row of their tenant directly
-- (PostgREST with the publishable key), including documents, parties, stock and receipts outside their role.
--
-- The app never reads the projection with a member's session. The server checks membership, reads the
-- snapshot with server credentials and sends each role only its scoped view (scopeWorkspace in
-- src/modules/erp/access.ts). Direct reads therefore follow one rule: only members who already receive the
-- whole company from the API (Owner, Accountant or Auditor with no branch limit) may read projection rows.
-- Every other role, and every branch-limited member, reads only through the API.
--
-- tenants and memberships keep their policies: the page reads them with the member's session to pick the
-- company. Branding files in storage keep their member-read policy (logos are shown to every role).

create or replace function private.reads_full_ledger(check_tenant uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.memberships m
    where m.tenant_id = check_tenant and m.user_id = auth.uid() and m.active
      and m.role = any(array['Owner', 'Accountant', 'Auditor']::public.app_role[])
      and cardinality(m.branch_ids) = 0
  );
$$;
revoke all on function private.reads_full_ledger(uuid) from public, anon;
grant execute on function private.reads_full_ledger(uuid) to authenticated;

-- Replaces the tenant-member policy (202609250001) and the role lists (202610120001) on every projection table.
do $$
declare table_name text;
begin
  foreach table_name in array array[
    'companies', 'branches', 'warehouses', 'fiscal_periods', 'workspace_snapshots', 'parties', 'items',
    'employees', 'documents', 'journals', 'journal_lines', 'stock_movements', 'receipts', 'commission_plans',
    'commissions', 'commission_movements', 'shipments', 'payroll_runs', 'follow_ups', 'audit_events'
  ] loop
    execute format('drop policy if exists tenant_read on public.%I', table_name);
    execute format('create policy tenant_read on public.%I for select to authenticated using (private.reads_full_ledger(tenant_id))', table_name);
  end loop;
end $$;

commit;

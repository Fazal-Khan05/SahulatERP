begin;
alter table public.fiscal_periods drop constraint if exists fiscal_periods_month_check;
alter table public.fiscal_periods add constraint fiscal_periods_month_check
  check (month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$');
revoke all on public.schema_migrations from anon, authenticated;
commit;

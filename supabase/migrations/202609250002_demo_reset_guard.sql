begin;
create or replace function private.reject_posted_change()
returns trigger language plpgsql set search_path = '' as $$
begin
  if old.status = 'posted' and coalesce(current_setting('app.demo_reset', true), 'off') <> 'on' then
    raise exception 'Posted journals are immutable; create a reversal.';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end $$;
commit;

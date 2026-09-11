-- Preserve the owner's accepted public content writes; compare-and-swap runs
-- with the caller's table permissions/RLS, never a backend service credential.
create table if not exists public.publication_revisions (
  id bigint generated always as identity primary key,
  table_name text not null,
  row_key text not null,
  data jsonb not null,
  replaced_at timestamptz not null default clock_timestamp()
);
alter table public.publication_revisions enable row level security;
revoke all on public.publication_revisions from anon, authenticated;

create or replace function public.publication_retain_revision()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if old.data is distinct from new.data then
    insert into public.publication_revisions(table_name,row_key,data)
    values (tg_table_name, to_jsonb(old)->>tg_argv[0], old.data);
  end if;
  return new;
end $$;
revoke all on function public.publication_retain_revision() from public;
drop trigger if exists publication_day_revision on public.days;
create trigger publication_day_revision before update on public.days
for each row execute function public.publication_retain_revision('date');
drop trigger if exists publication_week_revision on public.weeks;
create trigger publication_week_revision before update on public.weeks
for each row execute function public.publication_retain_revision('week_of');

create or replace function public.publication_compare_swap(
  p_table text, p_key text, p_expected jsonb, p_data jsonb
) returns boolean language plpgsql security invoker set search_path = public as $$
declare key_column text; time_column text; touched integer;
begin
  if p_table not in ('days','weeks','players','terms','threads','campaigns','events','metrics') then
    raise exception 'Unsupported publication table';
  end if;
  if jsonb_typeof(p_data) <> 'object' or p_key is null or length(p_key) = 0 then
    raise exception 'Malformed publication';
  end if;
  key_column := case when p_table='days' then 'date' when p_table='weeks' then 'week_of'
                     when p_table in ('events','metrics') then 'id' else 'slug' end;
  time_column := case when p_table in ('days','weeks') then 'generated_at' else 'updated_at' end;
  if p_table in ('days','weeks') then
    if (p_data->>case when p_table='days' then 'date' else 'weekOf' end) is distinct from p_key
       or p_key !~ '^\d{4}-\d{2}-\d{2}$' then
      raise exception 'Document key mismatch';
    end if;
    perform p_key::date;
  end if;
  if p_table='days' and jsonb_typeof(p_data->'stories') is distinct from 'array' then
    raise exception 'stories must be an array';
  end if;
  if p_expected is null then
    -- jsonb_populate_record supplies the actual key type (date/text) safely.
    execute format('insert into public.%I (%I,data,%I) select r.%I,r.data,r.%I from jsonb_populate_record(null::public.%I,$1) r on conflict do nothing',
      p_table,key_column,time_column,key_column,time_column,p_table)
    using jsonb_build_object(key_column,p_key,'data',p_data,time_column,coalesce(p_data->>'generatedAt',p_data->>'publishedAt'));
  else
    execute format('update public.%I set data=$1,%I=coalesce($1->>''generatedAt'',$1->>''publishedAt'')::timestamptz where %I::text=$2 and data=$3',
      p_table,time_column,key_column) using p_data,p_key,p_expected;
  end if;
  get diagnostics touched = row_count;
  return touched = 1;
end $$;
revoke all on function public.publication_compare_swap(text,text,jsonb,jsonb) from public;
grant execute on function public.publication_compare_swap(text,text,jsonb,jsonb) to anon,authenticated,service_role;

-- Public operational counters only. No cookies, tokens, or article bodies.
create table if not exists public.publication_workers (
  id text primary key,
  data jsonb not null
);
alter table public.publication_workers enable row level security;
grant select,insert,update on public.publication_workers to anon,authenticated,service_role;
create policy publication_workers_read on public.publication_workers for select using (true);
create policy publication_workers_insert on public.publication_workers for insert with check (true);
create policy publication_workers_update on public.publication_workers for update using (true) with check (true);

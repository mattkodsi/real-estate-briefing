begin;
create extension if not exists pgcrypto with schema extensions;
create schema if not exists reader_private;
revoke all on schema reader_private from public, anon, authenticated;
create table reader_private.credentials (
 profile text primary key references public.prefs(profile) on delete cascade,
 pin_hash text,
 legacy_hash text
);
create table reader_private.sessions (
 token_hash text primary key,
 profile text not null references public.prefs(profile) on delete cascade,
 expires_at timestamptz not null default now()+interval '30 days'
);
create index on reader_private.sessions(profile);
create table reader_private.attempts (
 key_hash text primary key,
 window_start timestamptz not null,
 attempts integer not null
);
insert into reader_private.credentials(profile,legacy_hash)
 select profile,nullif(data->>'pinHash','') from public.prefs;
update public.prefs set data=data-'pinHash'-'pin'-'token';
revoke all on public.prefs, public.push_subs from public, anon, authenticated;
-- Existing service-role pipeline consumers keep their access.
grant all on public.prefs, public.push_subs to service_role;

create or replace function public.reader_profile_api(payload jsonb, client_ip text default 'unknown')
returns jsonb language plpgsql security definer set search_path=pg_catalog,extensions as $$
declare
 a text := payload->>'action'; p text := payload->>'profile';
 d jsonb; c reader_private.credentials%rowtype;
 t text; th text; k text; v jsonb; n integer; row_count integer;
begin
 if a='list' then
  return jsonb_build_object('profiles',coalesce((select jsonb_agg(jsonb_build_object('slug',f.profile,'name',f.data->>'name','color',f.data->>'color','hasPin',cred.pin_hash is not null or cred.legacy_hash is not null) order by f.profile) from public.prefs f join reader_private.credentials cred on cred.profile=f.profile),'[]'::jsonb));
 end if;
 if p is null or length(p)>64 or p !~ '^[a-z0-9]+(-[a-z0-9]+)*$' or p='guest' then return '{"error":"invalid_profile","status":400}'; end if;
 if payload ? 'pin' and payload->'pin'<>'null'::jsonb and (jsonb_typeof(payload->'pin')<>'string' or (payload->>'pin') !~ '^[0-9]{4}$') then return '{"error":"invalid_pin","status":400}'; end if;
 if a in ('create','meta') and (coalesce(length(trim(payload->>'name')),0) not between 1 and 80 or coalesce(payload->>'color','') !~ '^#[a-fA-F0-9]{6}$') then return '{"error":"invalid_metadata","status":400}'; end if;
 if a in ('login','create') then
  -- Both a profile-wide and an address-wide cap; returning errors commits counters.
  foreach k in array array['profile:'||p,'ip:'||coalesce(client_ip,'unknown')] loop
   k:=encode(extensions.digest(k,'sha256'),'hex');
   insert into reader_private.attempts as old(key_hash,window_start,attempts) values(k,now(),1)
   on conflict(key_hash) do update set
    attempts=case when old.window_start<now()-interval '15 minutes' then 1 else old.attempts+1 end,
    window_start=case when old.window_start<now()-interval '15 minutes' then now() else old.window_start end
   returning attempts into n;
   if n>10 then return '{"error":"rate_limited","status":429}'; end if;
  end loop;
  if a='create' then
   insert into public.prefs(profile,data,updated_at) values(p,jsonb_build_object('name',trim(payload->>'name'),'color',payload->>'color','createdAt',current_date),now()) on conflict do nothing;
   get diagnostics row_count=row_count;
   if row_count=0 then return '{"error":"profile_exists","status":409}'; end if;
   insert into reader_private.credentials(profile,pin_hash) values(p,case when payload->>'pin' is not null then extensions.crypt(payload->>'pin',extensions.gen_salt('bf',10)) end);
  end if;
  select * into c from reader_private.credentials where profile=p for update;
  if not found then return '{"error":"unauthorized","status":401}'; end if;
  if c.pin_hash is not null then
   if payload->>'pin' is null or extensions.crypt(payload->>'pin',c.pin_hash)<>c.pin_hash then return '{"error":"unauthorized","status":401}'; end if;
  elsif c.legacy_hash is not null then
   if payload->>'pin' is null or encode(extensions.digest(p||':'||(payload->>'pin'),'sha256'),'hex')<>c.legacy_hash then return '{"error":"unauthorized","status":401}'; end if;
   update reader_private.credentials set pin_hash=extensions.crypt(payload->>'pin',extensions.gen_salt('bf',10)),legacy_hash=null where profile=p;
  end if;
  t:=encode(extensions.gen_random_bytes(32),'hex');
  insert into reader_private.sessions(token_hash,profile) values(encode(extensions.digest(t,'sha256'),'hex'),p);
  delete from reader_private.sessions where expires_at<now();
  select f.data||jsonb_build_object('hasPin',cred.pin_hash is not null or cred.legacy_hash is not null) into d from public.prefs f join reader_private.credentials cred on cred.profile=f.profile where f.profile=p;
  return jsonb_build_object('token',t,'data',d);
 end if;
 th:=encode(extensions.digest(coalesce(payload->>'token',''),'sha256'),'hex');
 if not exists(select 1 from reader_private.sessions where token_hash=th and profile=p and expires_at>now()) then return '{"error":"unauthorized","status":401}'; end if;
 if a='logout' then
  delete from reader_private.sessions where token_hash=th;
  return '{"ok":true}';
 elsif a='patch' then
  if jsonb_typeof(payload->'changes') is distinct from 'object' then return '{"error":"invalid_changes","status":400}'; end if;
  if exists(select 1 from jsonb_object_keys(payload->'changes') as keys(key) where key not in ('saved','read','seen','learnedTerms','starEvents','theme','look','textScale','watchPlayers','notifications')) then return '{"error":"invalid_changes","status":400}'; end if;
  for k,v in select key,value from jsonb_each(payload->'changes') loop
   if k in ('saved','read','learnedTerms','starEvents','watchPlayers') then
    if jsonb_typeof(v) is distinct from 'array' then return '{"error":"invalid_changes","status":400}'; end if;
    if k='saved' then
     if exists(select 1 from jsonb_array_elements(v) e where jsonb_typeof(e) is distinct from 'object' or jsonb_typeof(e->'key') is distinct from 'string' or jsonb_typeof(e->'date') is distinct from 'string' or jsonb_typeof(e->'id') is distinct from 'string' or jsonb_typeof(e->'title') is distinct from 'string') then return '{"error":"invalid_changes","status":400}'; end if;
    elsif exists(select 1 from jsonb_array_elements(v) e where jsonb_typeof(e) is distinct from 'string') then return '{"error":"invalid_changes","status":400}'; end if;
   elsif k='notifications' then
    if jsonb_typeof(v) is distinct from 'object' then return '{"error":"invalid_changes","status":400}'; end if;
    if exists(select 1 from jsonb_each(v) e where e.key not in ('breaking','watch','ready') or jsonb_typeof(e.value) is distinct from 'boolean') then return '{"error":"invalid_changes","status":400}'; end if;
   elsif k='seen' then
    if v<>'null'::jsonb then
     if jsonb_typeof(v) is distinct from 'object' or jsonb_typeof(v->'date') is distinct from 'string' or jsonb_typeof(v->'sig') is distinct from 'object' then return '{"error":"invalid_changes","status":400}'; end if;
     if exists(select 1 from jsonb_each(v->'sig') e where jsonb_typeof(e.value) is distinct from 'string') then return '{"error":"invalid_changes","status":400}'; end if;
    end if;
   elsif (k='theme' and v not in ('"system"','"light"','"dark"')) or (k='look' and v not in ('"legacy"','"updated"')) or (k='textScale' and v not in ('"s"','"m"','"l"')) then return '{"error":"invalid_changes","status":400}'; end if;
  end loop;
  update public.prefs set data=data||(payload->'changes'),updated_at=now() where profile=p;
 elsif a='meta' then
  update public.prefs set data=data||jsonb_build_object('name',trim(payload->>'name'),'color',payload->>'color'),updated_at=now() where profile=p;
  if payload ? 'pin' then
   update reader_private.credentials set legacy_hash=null,pin_hash=case when payload->>'pin' is not null then extensions.crypt(payload->>'pin',extensions.gen_salt('bf',10)) end where profile=p;
   delete from reader_private.sessions where profile=p and token_hash<>th;
  end if;
 elsif a='subscription' then
  if jsonb_typeof(payload->'sub') is distinct from 'object' or coalesce(payload->'sub'->>'endpoint','') !~ '^https://' then return '{"error":"invalid_subscription","status":400}'; end if;
  insert into public.push_subs as old(id,profile,sub) values(payload->'sub'->>'endpoint',p,(payload->'sub')||jsonb_build_object('disabled',coalesce((payload->>'disabled')::boolean,false)))
  on conflict(id) do update set sub=excluded.sub where old.profile=p;
  get diagnostics row_count=row_count;
  if row_count=0 then return '{"error":"endpoint_owned","status":409}'; end if;
  return '{"ok":true}';
 elsif a<>'load' then return '{"error":"invalid_action","status":400}';
 end if;
 select f.data||jsonb_build_object('hasPin',cred.pin_hash is not null or cred.legacy_hash is not null) into d from public.prefs f join reader_private.credentials cred on cred.profile=f.profile where f.profile=p;
 return jsonb_build_object('data',d);
end $$;
revoke all on function public.reader_profile_api(jsonb,text) from public, anon, authenticated;
grant execute on function public.reader_profile_api(jsonb,text) to service_role;
commit;

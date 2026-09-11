-- Atomic set deltas for upgraded clients; legacy full-value patches retain their API.
begin;
create table reader_private.mutation_receipts (
 profile text not null references public.prefs(profile) on delete cascade,
 id text not null,
 payload jsonb not null,
 primary key(profile,id)
);
revoke all on reader_private.mutation_receipts from public, anon, authenticated;
-- Receipts deliberately do not expire: an offline retry must never replay an old add.
create or replace function public.reader_profile_api(payload jsonb, client_ip text default 'unknown')
returns jsonb language plpgsql security definer set search_path=pg_catalog,extensions as $$
declare
 a text := payload->>'action'; p text := payload->>'profile';
 d jsonb; c reader_private.credentials%rowtype;
 t text; th text; k text; v jsonb; n integer; row_count integer;
 mutation jsonb; delta jsonb; item jsonb; merged jsonb; receipt jsonb;
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
  if payload ? 'mutations' then
   if jsonb_typeof(payload->'mutations') is distinct from 'array' then return '{"error":"invalid_changes","status":400}'; end if;
   if jsonb_array_length(payload->'mutations')>100 then return '{"error":"invalid_changes","status":400}'; end if;
   -- Validate the entire batch before writing any receipt or preference.
   for mutation in select value from jsonb_array_elements(payload->'mutations') loop
    if jsonb_typeof(mutation) is distinct from 'object' then return '{"error":"invalid_changes","status":400}'; end if;
    if exists(select 1 from jsonb_object_keys(mutation) key where key not in ('id','sets')) or
       coalesce(mutation->>'id','') !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' or
       jsonb_typeof(mutation->'sets') is distinct from 'object' then return '{"error":"invalid_changes","status":400}'; end if;
    if mutation->'sets'='{}'::jsonb then return '{"error":"invalid_changes","status":400}'; end if;
    for k,delta in select key,value from jsonb_each(mutation->'sets') loop
     if k not in ('saved','read','learnedTerms','starEvents','watchPlayers') or payload->'changes' ? k or jsonb_typeof(delta) is distinct from 'object' then return '{"error":"invalid_changes","status":400}'; end if;
     if exists(select 1 from jsonb_object_keys(delta) key where key not in ('add','remove')) or
        jsonb_typeof(delta->'add') is distinct from 'array' or jsonb_typeof(delta->'remove') is distinct from 'array' then return '{"error":"invalid_changes","status":400}'; end if;
     if exists(select 1 from jsonb_array_elements(delta->'remove') e where jsonb_typeof(e) is distinct from 'string') then return '{"error":"invalid_changes","status":400}'; end if;
     for item in select value from jsonb_array_elements(delta->'add') loop
      if k='saved' then
       if jsonb_typeof(item) is distinct from 'object' or jsonb_typeof(item->'key') is distinct from 'string' or jsonb_typeof(item->'date') is distinct from 'string' or jsonb_typeof(item->'id') is distinct from 'string' or jsonb_typeof(item->'title') is distinct from 'string' or
          (item ? 'section' and jsonb_typeof(item->'section') not in ('string','null')) or
          (item ? 'market' and jsonb_typeof(item->'market') not in ('string','null')) then return '{"error":"invalid_changes","status":400}'; end if;
      elsif jsonb_typeof(item) is distinct from 'string' then return '{"error":"invalid_changes","status":400}'; end if;
     end loop;
    end loop;
   end loop;
  end if;
  -- All writes (including old clients' UPDATEs) serialize on this profile row.
  select data into d from public.prefs where profile=p for update;
  for mutation in select value from jsonb_array_elements(coalesce(payload->'mutations','[]'::jsonb)) loop
   select r.payload into receipt from reader_private.mutation_receipts r where r.profile=p and r.id=mutation->>'id';
   if found and receipt<>mutation then return '{"error":"mutation_conflict","status":409}'; end if;
   if exists(select 1 from jsonb_array_elements(payload->'mutations') other where other->>'id'=mutation->>'id' and other<>mutation) then return '{"error":"mutation_conflict","status":409}'; end if;
  end loop;
  for mutation in select value from jsonb_array_elements(coalesce(payload->'mutations','[]'::jsonb)) loop
   insert into reader_private.mutation_receipts(profile,id,payload) values(p,mutation->>'id',mutation) on conflict do nothing;
   get diagnostics row_count=row_count;
   if row_count=0 then continue; end if;
   for k,delta in select key,value from jsonb_each(mutation->'sets') loop
    merged := '[]'::jsonb;
    for item in select value from jsonb_array_elements(coalesce(d->k,'[]'::jsonb)) loop
     -- Additions replace metadata for the same saved-story key; removals use keys.
     if not (delta->'remove' ? (case when k='saved' then item->>'key' else item#>>'{}' end)) and
        not exists(select 1 from jsonb_array_elements(delta->'add') added where
         (case when k='saved' then added->>'key' else added#>>'{}' end)=(case when k='saved' then item->>'key' else item#>>'{}' end)) then
      merged := merged || jsonb_build_array(item);
     end if;
    end loop;
    -- Last add for a key wins; preserve stable input order.
    for item in select value from jsonb_array_elements(delta->'add') loop
     select coalesce(jsonb_agg(value),'[]'::jsonb) into merged from jsonb_array_elements(merged) where
      (case when k='saved' then value->>'key' else value#>>'{}' end)<>(case when k='saved' then item->>'key' else item#>>'{}' end);
     merged := merged || jsonb_build_array(item);
    end loop;
    d := jsonb_set(d,array[k],merged,true);
   end loop;
  end loop;
  update public.prefs set data=d||(payload->'changes'),updated_at=now() where profile=p;
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

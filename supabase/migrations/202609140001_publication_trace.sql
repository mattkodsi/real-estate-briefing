-- Additive observability only. No old rows are backfilled or assigned invented timestamps.
create table public.pipeline_events (
 id uuid primary key default gen_random_uuid(),
 recorded_at timestamptz not null default clock_timestamp(),
 observed_at timestamptz,
 source text not null check(source in ('database','producer')),
 run_id text check(length(run_id)<=200),
 producer text not null check(length(producer)<=120),
 stage text not null check(length(stage)<=80),
 status text not null check(length(status)<=40),
 entity_type text not null check(length(entity_type)<=80),
 entity_key text check(length(entity_key)<=300),
 details jsonb not null default '{}' check(jsonb_typeof(details)='object' and octet_length(details::text)<=32768)
);
comment on column public.pipeline_events.recorded_at is 'Database insertion clock, NOT exact transaction commit time. Database events survive only if their originating transaction commits.';
comment on column public.pipeline_events.observed_at is 'Optional producer observation clock; not necessarily synchronized with recorded_at. Mailbox receipt belongs in details.receipt_at, not this field.';
comment on column public.pipeline_events.source is 'database: actual row change in same transaction; producer: reported lifecycle observation, not independent proof of publication.';
create index pipeline_events_run_time on public.pipeline_events(run_id,recorded_at);
create index pipeline_events_entity_time on public.pipeline_events(entity_type,entity_key,recorded_at);
alter table public.pipeline_events enable row level security;
revoke all on public.pipeline_events from public,anon,authenticated,service_role;
grant select,insert on public.pipeline_events to service_role;
create policy pipeline_service_read on public.pipeline_events for select to service_role using(true);
create policy pipeline_service_insert on public.pipeline_events for insert to service_role with check(true);
create function public.pipeline_append_only() returns trigger language plpgsql set search_path=pg_catalog as $$
begin raise exception 'pipeline_events is append-only';end $$;
create trigger pipeline_append_only before update or delete or truncate on public.pipeline_events for each statement execute function public.pipeline_append_only();

-- Reject text-bearing metadata rather than truncating it into the trace.
create function public.pipeline_safe_token(v text,maxlen integer default 200) returns text language sql immutable set search_path=pg_catalog as $$
 select case when length(v)<=maxlen and v ~ '^[A-Za-z0-9_.:/-]+$' and position('://' in v)=0 then v end
$$;
create function public.pipeline_iso_timestamp(v text) returns boolean language plpgsql immutable set search_path=pg_catalog as $$
begin
 if v is null or length(v)>40 or v !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$' then return false;end if;
 perform v::timestamptz;return true;
exception when others then return false;
end $$;
-- Explicit scalar-only allowlist; counts cannot carry exception messages.
create function public.pipeline_safe_details(p jsonb) returns jsonb language sql immutable set search_path=pg_catalog,public as $$
 select coalesce(jsonb_object_agg(key,value),'{}'::jsonb) from jsonb_each(case when jsonb_typeof(p)='object' then p else '{}'::jsonb end)
 where case
 when key in ('count','attempt','attempts','duration_ms','words','exit_code','attempted','skipped','filled','failed','story_count','email_count','row_count','success_count','failure_count','pending_count','processed_count','published_count','read_count','updated_count','skipped_count','changed_count','item_count','candidate_count','filled_count','unresolved_count','retry_count') and jsonb_typeof(value)='number' then (value#>>'{}')::numeric between -1 and 1000000000000
 when key in ('mode','phase','git_sha','external_run_id','parent_run_id','error_type','span_id','parent_span_id','reason','executor','environment','method','provider','model','workflow','artifact_type','trigger','retry_reason') and jsonb_typeof(value)='string' then public.pipeline_safe_token(value#>>'{}') is not null
 when key in ('source_hash','artifact_hash','input_hash') and jsonb_typeof(value)='string' then (value#>>'{}') ~ '^[a-fA-F0-9]{64}$'
 when key='receipt_at' and jsonb_typeof(value)='string' then public.pipeline_iso_timestamp(value#>>'{}')
 else false end
$$;
create function public.pipeline_safe_snapshot(p jsonb,worker boolean) returns jsonb language sql immutable set search_path=pg_catalog,public as $$
 select coalesce(jsonb_object_agg(key,value),'{}'::jsonb) from jsonb_each(case when jsonb_typeof(p)='object' then p else '{}'::jsonb end)
 where case
 when key in ('attempts','attempt') or (worker and key in ('failed','processed','filled','pending','errors','storyCount','processedCount','filledCount')) then case when jsonb_typeof(value)='number' then (value#>>'{}')::numeric between 0 and 1000000000000 else false end
 when key in ('state','status') then jsonb_typeof(value)='string' and (value#>>'{}') in ('started','completed','failed','skipped','conflict','retry','degraded','running','pending','queued','sending','sent','gone','idle','healthy','unhealthy')
 when worker and key in ('runId','run_id','traceRunId','via') then jsonb_typeof(value)='string' and public.pipeline_safe_token(value#>>'{}') is not null
 when worker and key='date' then jsonb_typeof(value)='string' and public.pipeline_iso_timestamp((value#>>'{}')||'T00:00:00Z')
 when key in ('provider_accepted_at','device_received_at','device_displayed_at','last_finished_at','next_attempt_at','last_attempt_at') or (worker and key in ('startedAt','finishedAt','completedAt','updatedAt','heartbeatAt','lastRun')) then value='null'::jsonb or (jsonb_typeof(value)='string' and public.pipeline_iso_timestamp(value#>>'{}'))
 else false end
$$;
create function public.pipeline_record_events(p_events jsonb) returns integer language plpgsql security definer set search_path=pg_catalog,public as $$
declare e jsonb;n integer:=0;added integer;
begin
 if jsonb_typeof(p_events) is distinct from 'array' or jsonb_array_length(p_events)>100 then raise exception 'Expected event array with at most 100 entries';end if;
 if octet_length(p_events::text)>1048576 then raise exception 'Event batch exceeds limit';end if;
 for e in select value from jsonb_array_elements(p_events) loop
  if jsonb_typeof(e) is distinct from 'object' or e->>'id' is null then raise exception 'Each event needs a UUID id';end if;
  insert into public.pipeline_events(id,observed_at,source,run_id,producer,stage,status,entity_type,entity_key,details)
  values((e->>'id')::uuid,case when public.pipeline_iso_timestamp(e->>'observed_at') then (e->>'observed_at')::timestamptz end,'producer',public.pipeline_safe_token(e->>'run_id'),coalesce(public.pipeline_safe_token(e->>'producer',120),'unknown'),coalesce(public.pipeline_safe_token(e->>'stage',80),'unknown'),case when e->>'status' in ('started','completed','failed','skipped','conflict','retry','degraded','running','pending') then e->>'status' else 'unknown' end,coalesce(public.pipeline_safe_token(e->>'entity_type',80),'run'),public.pipeline_safe_token(e->>'entity_key',300),public.pipeline_safe_details(e->'details'))
  on conflict(id) do nothing;
  get diagnostics added=row_count;n:=n+added;
 end loop;
 return n;
end $$;
revoke all on function public.pipeline_record_events(jsonb) from public,anon,authenticated;
grant execute on function public.pipeline_record_events(jsonb) to service_role;

create function public.pipeline_changed_fields(a jsonb,b jsonb) returns jsonb language sql immutable set search_path=pg_catalog as $$
 select coalesce(jsonb_agg(left(k,80) order by k),'[]'::jsonb) from (
 select k from (select jsonb_object_keys(case when jsonb_typeof(a)='object' then a else '{}' end) k union select jsonb_object_keys(case when jsonb_typeof(b)='object' then b else '{}' end)) keys
 where (a->k is distinct from b->k) and k ~ '^[A-Za-z_][A-Za-z0-9_]{0,79}$' limit 200) changed
$$;
create function public.pipeline_trace_change() returns trigger language plpgsql security definer set search_path=pg_catalog,public as $$
declare a jsonb; b jsonb; da jsonb; db jsonb; hdr jsonb; rid text; prod text; ek text; meta jsonb; s record;
begin
 a:=case when TG_OP<>'INSERT' then to_jsonb(OLD) end;
 b:=case when TG_OP<>'DELETE' then to_jsonb(NEW) end;
 if a is not distinct from b then return null;end if;
 -- Bad/missing request metadata must not suppress tracing of otherwise valid writes.
 begin hdr:=coalesce(nullif(current_setting('request.headers',true),'')::jsonb,'{}');exception when others then hdr:='{}';end;
 rid:=public.pipeline_safe_token(hdr->>'x-briefing-run-id');prod:=coalesce(public.pipeline_safe_token(hdr->>'x-briefing-producer',120),'unknown');
 ek:=coalesce(public.pipeline_safe_token(coalesce(b->>'date',a->>'date',b->>'week_of',a->>'week_of',b->>'slug',a->>'slug',b->>'id',a->>'id',concat_ws('/',coalesce(b->>'day',a->>'day'),coalesce(b->>'story_id',a->>'story_id'))),300),'unknown');
 if TG_TABLE_NAME in ('publication_workers','audit_push_jobs','audit_fill_attempts') then
  if TG_TABLE_NAME='publication_workers' then a:=a->'data';b:=b->'data';end if;
  da:=public.pipeline_safe_snapshot(a,TG_TABLE_NAME='publication_workers');
  db:=public.pipeline_safe_snapshot(b,TG_TABLE_NAME='publication_workers');
  if TG_OP='UPDATE' and da=db then return null;end if;
  meta:=jsonb_build_object('operation',lower(TG_OP),'old',da,'new',db,'changed_fields',public.pipeline_changed_fields(da,db));
 else
  da:=a->'data';db:=b->'data';
  if TG_OP='UPDATE' and da is not distinct from db then return null;end if;
  meta:=jsonb_build_object('operation',lower(TG_OP),'changed_fields',public.pipeline_changed_fields(da,db),'old_hash',md5(da::text),'new_hash',md5(db::text));
 end if;
 insert into public.pipeline_events(source,run_id,producer,stage,status,entity_type,entity_key,details)
 values('database',rid,prod,'database.write','committed',TG_TABLE_NAME,ek,meta||jsonb_build_object('method','postgres-trigger','executor','supabase-postgres'));
 if TG_TABLE_NAME='days' then
  for s in
   with old_stories as (select v,ord from jsonb_array_elements(case when jsonb_typeof(da->'stories')='array' then da->'stories' else '[]' end) with ordinality t(v,ord)),
   new_stories as (select v,ord from jsonb_array_elements(case when jsonb_typeof(db->'stories')='array' then db->'stories' else '[]' end) with ordinality t(v,ord))
   select coalesce(n.v->>'id',o.v->>'id') sid,o.v ov,n.v nv,o.ord old_rank,n.ord new_rank
   from old_stories o full join new_stories n on o.v->>'id'=n.v->>'id'
   where o.v is distinct from n.v or o.ord is distinct from n.ord
  loop
   insert into public.pipeline_events(source,run_id,producer,stage,status,entity_type,entity_key,details)
   values('database',rid,prod,'database.story','committed','story',left(ek||'/'||coalesce(public.pipeline_safe_token(s.sid),'unknown'),300),jsonb_build_object('method','postgres-trigger','executor','supabase-postgres','day',ek,'operation',case when s.ov is null then 'added' when s.nv is null then 'removed' else 'changed' end,'changed_fields',public.pipeline_changed_fields(s.ov,s.nv),'old_hash',md5(s.ov::text),'new_hash',md5(s.nv::text),'old_rank',s.old_rank,'new_rank',s.new_rank,'old_brief',case when s.ov is not null then coalesce(s.ov->'brief'='true'::jsonb,false) end,'new_brief',case when s.nv is not null then coalesce(s.nv->'brief'='true'::jsonb,false) end));
  end loop;
 end if;
 return null;
exception when others then
 -- SQLSTATE only: errors can contain article data. This subtransaction rolls back all log rows.
 raise warning 'Publication trace unavailable on % (%). Original write continues.',TG_TABLE_NAME,SQLSTATE;
 return null;
end $$;
revoke all on function public.pipeline_trace_change(),public.pipeline_append_only(),public.pipeline_changed_fields(jsonb,jsonb),public.pipeline_safe_details(jsonb),public.pipeline_safe_token(text,integer),public.pipeline_iso_timestamp(text),public.pipeline_safe_snapshot(jsonb,boolean) from public,anon,authenticated;
do $$ declare t text;begin
 foreach t in array array['days','weeks','players','terms','threads','campaigns','events','metrics','publication_workers','audit_push_jobs','audit_fill_attempts'] loop
  if to_regclass('public.'||t) is not null then
   execute format('create trigger pipeline_trace_change after insert or update or delete on public.%I for each row execute function public.pipeline_trace_change()',t);
  end if;
 end loop;
end $$;

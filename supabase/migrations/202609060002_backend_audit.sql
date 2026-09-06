-- Apply before deploying the audited edge functions. No client access to job state.
revoke all on public.push_log from public,anon,authenticated;
create table if not exists public.audit_push_jobs (
 id bigint generated always as identity primary key,
 event_id text not null, device_id text not null, profile text not null,
 sub jsonb not null, payload jsonb not null,
 state text not null default 'pending' check(state in ('pending','sending','retry','sent','gone')),
 attempts integer not null default 0, next_attempt_at timestamptz not null default now(),
 claim_token uuid, lease_until timestamptz, last_error text, created_at timestamptz not null default now(),
 unique(event_id,device_id)
);
alter table public.audit_push_jobs enable row level security;
revoke all on public.audit_push_jobs from public,anon,authenticated;
create index if not exists audit_push_due on public.audit_push_jobs(next_attempt_at) where state in ('pending','retry','sending');

create or replace function public.audit_enqueue_push(p_event text,p_profiles text[],p_payload jsonb)
returns void language sql security definer set search_path=public,pg_temp as $$
 insert into audit_push_jobs(event_id,device_id,profile,sub,payload)
 select p_event,md5(s.sub->>'endpoint'),s.profile,s.sub,p_payload from push_subs s
 where s.profile=any(p_profiles) and coalesce(s.sub->>'endpoint','')<>''
 and coalesce(s.sub->>'disabled','false')<>'true'
 -- Preserve previously logged alerts at the upgrade boundary.
 and not exists(select 1 from push_log where id=p_event)
 on conflict(event_id,device_id) do nothing;
$$;
-- Story-level reservations keep one profile/run bundle without duplicate pings for
-- stories mentioning several watched players. Reservation and enqueue are atomic.
create table if not exists public.audit_watch_seen (
 profile text not null, day date not null, story_id text not null,
 primary key(profile,day,story_id)
);
alter table public.audit_watch_seen enable row level security;
revoke all on public.audit_watch_seen from public,anon,authenticated;
create or replace function public.audit_watch_payload(p_items jsonb,p_day text,p_tag text)
returns jsonb language sql immutable set search_path=public,pg_temp as $$
 select jsonb_build_object('title',case when jsonb_array_length(p_items)=1 then
 p_items->0->>'name'||' in today''s briefing' else jsonb_array_length(p_items)||' watchlist stories in today''s briefing' end,
 'body',(select string_agg(x->>'title',' · ') from jsonb_array_elements(p_items) x),
 'url',case when jsonb_array_length(p_items)=1 then './#/story/'||p_day||'/'||(p_items->0->>'id') else './' end,
 'tag',p_tag,'watchItems',p_items,'watchDay',p_day);
$$;
create or replace function public.audit_enqueue_watch(p_profile text,p_day date,p_items jsonb)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare items jsonb; event_key text;
begin
 -- Serialize concurrent runs for this profile before deciding the unseen bundle.
 perform pg_advisory_xact_lock(hashtext('watch:'||p_profile));
 with grouped as (
 select x->>'id' id,min(x->>'title') title,min(x->>'name') name,jsonb_agg(distinct x->>'slug') slugs
 from jsonb_array_elements(p_items) x where x->>'id' is not null group by x->>'id'
 ), fresh as (
 insert into audit_watch_seen(profile,day,story_id)
 select p_profile,p_day,g.id from grouped g
 where not exists(select 1 from push_log l, jsonb_array_elements_text(g.slugs) slug
 where l.id='watch:'||p_profile||':'||p_day||':'||slug||':'||g.id)
 on conflict do nothing returning story_id
 ) select jsonb_agg(jsonb_build_object('id',g.id,'title',g.title,'name',g.name,'slugs',g.slugs) order by g.id)
 into items from grouped g join fresh f on f.story_id=g.id;
 if items is null then return; end if;
 event_key:='watch:'||p_profile||':'||p_day||':bundle:'||md5(items::text);
 perform audit_enqueue_push(event_key,array[p_profile],audit_watch_payload(items,p_day::text,event_key));
end $$;
create or replace function public.audit_push_eligible(p_profile text,p_event text,p_payload jsonb)
returns boolean language sql stable security definer set search_path=public,pg_temp as $$
 select case split_part(p_event,':',1)
 when 'spec' then coalesce(p.data->'notifications'->>'breaking','true')<>'false'
 when 'ready' then coalesce(p.data->'notifications'->>'ready','false')='true'
 when 'event' then coalesce(p.data->'starEvents','[]'::jsonb) ? substring(p_event from length('event:'||p_profile||':')+1)
 when 'watch' then coalesce(p.data->'notifications'->>'watch','true')<>'false' and
 (case when p_payload ? 'watchItems' then exists(
 select 1 from jsonb_array_elements(p_payload->'watchItems') item,
 jsonb_array_elements_text(item->'slugs') slug
 where coalesce(p.data->'watchPlayers','[]'::jsonb) ? slug)
 else coalesce(p.data->'watchPlayers','[]'::jsonb) ? split_part(p_event,':',4) end)
 else true end
 from (select (select data from prefs where profile=p_profile) data) p;
$$;
create or replace function public.audit_claim_push(p_event text)
returns setof public.audit_push_jobs language plpgsql security definer set search_path=public,pg_temp as $$
declare job audit_push_jobs; current_sub jsonb; items jsonb;
begin
 loop
 select q.* into job from audit_push_jobs q where
 (p_event is null or q.event_id=p_event) and
 ((q.state in ('pending','retry') and q.next_attempt_at<=now()) or
 (q.state='sending' and q.lease_until<now()))
 order by q.next_attempt_at,q.id for update skip locked limit 1;
 if not found then return; end if;
 select s.sub into current_sub from push_subs s where s.profile=job.profile
 and md5(s.sub->>'endpoint')=job.device_id and coalesce(s.sub->>'disabled','false')<>'true' limit 1;
 if current_sub is null or not audit_push_eligible(job.profile,job.event_id,job.payload) then
 update audit_push_jobs set state='gone',last_error='No longer eligible',claim_token=null,lease_until=null where id=job.id;
 continue;
 end if;
 if job.payload ? 'watchItems' then
 select jsonb_agg(item) into items from jsonb_array_elements(job.payload->'watchItems') item
 where exists(select 1 from jsonb_array_elements_text(item->'slugs') slug, prefs p
 where p.profile=job.profile and coalesce(p.data->'watchPlayers','[]'::jsonb) ? slug);
 job.payload:=audit_watch_payload(items,job.payload->>'watchDay',job.event_id);
 end if;
 return query update audit_push_jobs j set state='sending',attempts=j.attempts+1,
 sub=current_sub,payload=job.payload,claim_token=gen_random_uuid(),lease_until=now()+interval '5 minutes'
 where j.id=job.id returning j.*;
 return;
 end loop;
end $$;
-- The dispatcher drains scheduled retries; manual callers claim their event only.
create or replace function public.audit_claim_push()
returns setof public.audit_push_jobs language sql security definer set search_path=public,pg_temp as $$
 select * from audit_claim_push(null::text);
$$;
create or replace function public.audit_finish_push(p_id bigint,p_token uuid,p_outcome text,p_error text)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
begin
 if p_outcome not in ('sent','retry','gone') then raise exception 'invalid outcome'; end if;
 update audit_push_jobs set state=p_outcome,last_error=p_error,claim_token=null,lease_until=null,
 next_attempt_at=now()+make_interval(secs=>least(21600,60*power(2,least(attempts,8)))::integer)
 where id=p_id and state='sending' and claim_token=p_token;
 if not found then raise exception 'stale delivery lease'; end if;
 if p_outcome='gone' then
  delete from push_subs where sub->>'endpoint'=(select j.sub->>'endpoint' from audit_push_jobs j where j.id=p_id);
 end if;
end $$;

create table if not exists public.audit_fill_attempts (
 day date not null, story_id text not null, source_url text not null,
 attempts integer not null default 0, next_attempt_at timestamptz not null default now(),
 last_attempt_at timestamptz, primary key(day,story_id,source_url)
);
alter table public.audit_fill_attempts enable row level security;
revoke all on public.audit_fill_attempts from public,anon,authenticated;
-- Selection and reservation are atomic; failed early items back off so later stories advance.
create or replace function public.audit_claim_fill(p_day date,p_candidates jsonb,p_limit integer default 4)
returns setof public.audit_fill_attempts language plpgsql security definer set search_path=public,pg_temp as $$
begin
 insert into audit_fill_attempts(day,story_id,source_url)
 select p_day,x->>'id',x->>'url' from jsonb_array_elements(p_candidates) x
 where x->>'id' is not null and x->>'url' is not null on conflict do nothing;
 return query update audit_fill_attempts a set attempts=a.attempts+1,last_attempt_at=now(),
 next_attempt_at=now()+make_interval(secs=>least(86400,900*power(2,least(a.attempts,7)))::integer)
 where (a.day,a.story_id,a.source_url) in (
 select q.day,q.story_id,q.source_url from audit_fill_attempts q
 where q.day=p_day and q.next_attempt_at<=now() and exists(
 select 1 from jsonb_array_elements(p_candidates) x where x->>'id'=q.story_id and x->>'url'=q.source_url)
 order by q.last_attempt_at nulls first,q.story_id for update skip locked limit least(greatest(p_limit,0),4))
 returning a.*;
end $$;
-- Compare-and-swap prevents this standby from replacing a concurrently republished day.
create or replace function public.audit_publish_fill(p_day date,p_expected jsonb,p_data jsonb)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
begin
 update days set data=p_data,generated_at=(p_data->>'generatedAt')::timestamptz where date=p_day and data=p_expected;
 return found;
end $$;
revoke all on function public.audit_enqueue_push(text,text[],jsonb),public.audit_claim_push(),public.audit_finish_push(bigint,uuid,text,text),public.audit_claim_fill(date,jsonb,integer),public.audit_publish_fill(date,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.audit_enqueue_push(text,text[],jsonb),public.audit_claim_push(),public.audit_finish_push(bigint,uuid,text,text),public.audit_claim_fill(date,jsonb,integer),public.audit_publish_fill(date,jsonb,jsonb) to service_role;

revoke all on function public.audit_enqueue_watch(text,date,jsonb),public.audit_watch_payload(jsonb,text,text),public.audit_push_eligible(text,text,jsonb),public.audit_claim_push(text) from public,anon,authenticated;
grant execute on function public.audit_enqueue_watch(text,date,jsonb),public.audit_claim_push(text) to service_role;

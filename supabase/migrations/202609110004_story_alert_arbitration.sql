-- One story alert reason per profile. Existing event/device leases still own delivery.
-- Lock in the same order as the old watch writer while taking the upgrade snapshot.
lock table public.audit_watch_seen, public.audit_push_jobs in share row exclusive mode;
create table public.audit_story_alerts (
 profile text not null,
 day date not null,
 story_id text not null check(length(story_id)>0),
 reason text not null check(reason in ('breaking','watch')),
 event_id text not null,
 reserved_at timestamptz not null default now(),
 primary key(profile,day,story_id)
);
alter table public.audit_story_alerts enable row level security;
revoke all on public.audit_story_alerts from public,anon,authenticated;
-- Historical reservations suppress replays; installation never enqueues anything.
insert into public.audit_story_alerts(profile,day,story_id,reason,event_id)
select profile,day,story_id,'watch','legacy-watch:'||profile||':'||day||':'||story_id
from public.audit_watch_seen where length(story_id)>0 on conflict do nothing;
insert into public.audit_story_alerts(profile,day,story_id,reason,event_id,reserved_at)
select distinct on (profile,event_id) profile,split_part(event_id,':',2)::date,
 substring(event_id from 17),'breaking',event_id,created_at
from public.audit_push_jobs where event_id ~ '^spec:[0-9]{4}-[0-9]{2}-[0-9]{2}:.+$'
order by profile,event_id,created_at on conflict do nothing;

-- Pre-queue watch logs have no device outcome; retain their historical suppression
-- across actor changes without guessing a delivery time or parsing arbitrary dates.
create or replace function public.audit_legacy_watch_seen(p_profile text,p_day date,p_story text)
returns boolean language sql stable security definer set search_path=public,pg_temp as $$
 select exists(select 1 from (
  select substring(id from length('watch:'||p_profile||':'||p_day||':')+1) tail
  from push_log where starts_with(id,'watch:'||p_profile||':'||p_day||':')
 ) logs where position(':' in tail)>0 and substring(tail from position(':' in tail)+1)=p_story);
$$;
revoke all on function public.audit_legacy_watch_seen(text,date,text) from public,anon,authenticated;

create or replace function public.audit_enqueue_push(p_event text,p_profiles text[],p_payload jsonb)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare v_profile text; v_day date; v_story text; v_owner text;
begin
 if p_event like 'spec:%' then
  if p_event !~ '^spec:[0-9]{4}-[0-9]{2}-[0-9]{2}:.+$' then raise exception 'invalid story event'; end if;
  v_day:=split_part(p_event,':',2)::date; v_story:=substring(p_event from 17);
 end if;
 -- Sorted locking avoids deadlocks for multi-profile calls in opposite orders.
 for v_profile in select distinct unnest(p_profiles) order by 1 loop
  perform pg_advisory_xact_lock(hashtext('story-alert:'||v_profile));
  if exists(select 1 from push_log where id=p_event) or
   not audit_push_eligible(v_profile,p_event,p_payload) or
   not exists(select 1 from push_subs s where s.profile=v_profile and
    coalesce(s.sub->>'endpoint','')<>'' and coalesce(s.sub->>'disabled','false')<>'true') then continue; end if;
  if v_story is not null then
   if audit_legacy_watch_seen(v_profile,v_day,v_story) then continue; end if;
   insert into audit_story_alerts(profile,day,story_id,reason,event_id)
   values(v_profile,v_day,v_story,'breaking',p_event) on conflict do nothing;
   select event_id into v_owner from audit_story_alerts
    where profile=v_profile and day=v_day and story_id=v_story;
   -- Retries of the chosen event retain normal per-device idempotency.
   if v_owner is distinct from p_event then continue; end if;
  end if;
  insert into audit_push_jobs(event_id,device_id,profile,sub,payload)
  select p_event,md5(s.sub->>'endpoint'),s.profile,s.sub,p_payload from push_subs s
  where s.profile=v_profile and coalesce(s.sub->>'endpoint','')<>''
   and coalesce(s.sub->>'disabled','false')<>'true'
  on conflict(event_id,device_id) do nothing;
 end loop;
end $$;

create or replace function public.audit_enqueue_watch(p_profile text,p_day date,p_items jsonb)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare items jsonb; event_key text; watched jsonb;
begin
 perform pg_advisory_xact_lock(hashtext('story-alert:'||p_profile));
 select coalesce(data->'watchPlayers','[]'::jsonb) into watched from prefs
  where profile=p_profile and coalesce(data->'notifications'->>'watch','true')<>'false';
 if watched is null or not exists(select 1 from push_subs s where s.profile=p_profile
  and coalesce(s.sub->>'endpoint','')<>'' and coalesce(s.sub->>'disabled','false')<>'true') then return; end if;
 with grouped as (
  select x->>'id' id,min(x->>'title') title,min(x->>'name') name,jsonb_agg(distinct x->>'slug') slugs
  from jsonb_array_elements(p_items) x where coalesce(x->>'id','')<>'' and watched ? (x->>'slug')
  group by x->>'id'
 ), fresh as (
  insert into audit_story_alerts(profile,day,story_id,reason,event_id)
  select p_profile,p_day,g.id,'watch','watch-reservation' from grouped g
  where not audit_legacy_watch_seen(p_profile,p_day,g.id)
   and not exists(select 1 from push_log l where l.id='spec:'||p_day||':'||g.id)
   and not exists(select 1 from audit_watch_seen w where w.profile=p_profile and w.day=p_day and w.story_id=g.id)
   and not exists(select 1 from push_log l,jsonb_array_elements_text(g.slugs) slug
    where l.id='watch:'||p_profile||':'||p_day||':'||slug||':'||g.id)
  on conflict do nothing returning story_id
 ) select jsonb_agg(jsonb_build_object('id',g.id,'title',g.title,'name',g.name,'slugs',g.slugs) order by g.id)
  into items from grouped g join fresh f on f.story_id=g.id;
 if items is null then return; end if;
 event_key:='watch:'||p_profile||':'||p_day||':bundle:'||md5(items::text);
 update audit_story_alerts set event_id=event_key
  where profile=p_profile and day=p_day and reason='watch' and event_id='watch-reservation'
   and story_id in(select x->>'id' from jsonb_array_elements(items) x);
 insert into audit_watch_seen(profile,day,story_id)
  select p_profile,p_day,x->>'id' from jsonb_array_elements(items) x on conflict do nothing;
 perform audit_enqueue_push(event_key,array[p_profile],audit_watch_payload(items,p_day::text,event_key));
end $$;
revoke all on function public.audit_enqueue_push(text,text[],jsonb),public.audit_enqueue_watch(text,date,jsonb) from public,anon,authenticated;
grant execute on function public.audit_enqueue_push(text,text[],jsonb),public.audit_enqueue_watch(text,date,jsonb) to service_role;

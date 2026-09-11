-- Service-only, bounded, one-use publisher capture capability. No reader role is owner.
create table if not exists public.publisher_capture_tickets (
 token_hash text primary key check(token_hash ~ '^[a-f0-9]{64}$'),
 domain text not null check(domain in ('therealdeal.com','inman.com','bisnow.com')),
 expires_at timestamptz not null default now()+interval '10 minutes'
);
alter table public.publisher_capture_tickets enable row level security;
revoke all on public.publisher_capture_tickets from public,anon,authenticated;
create or replace function public.issue_capture_ticket(p_hash text,p_domain text)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
begin
 delete from publisher_capture_tickets where expires_at<now();
 insert into publisher_capture_tickets(token_hash,domain) values(p_hash,p_domain);
 return true;
end $$;
create or replace function public.capture_publisher_session(p_hash text,p_domain text,p_cookie text)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare matched text; stamp text:=to_char(now() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"');
begin
 if p_domain not in ('therealdeal.com','inman.com','bisnow.com') or length(p_cookie) not between 20 and 32768 or position('=' in p_cookie)=0 or p_cookie ~ E'[\r\n]' then raise exception 'invalid capture'; end if;
 if p_hash is not null then
  delete from publisher_capture_tickets where token_hash=p_hash and domain=p_domain and expires_at>now() returning token_hash into matched;
  if matched is null then return false; end if;
 end if;
 insert into secrets(id,data) values(case when p_domain='therealdeal.com' then 'trd_session' else 'session_'||p_domain end,
 jsonb_build_object('domain',p_domain,'cookie',p_cookie,'savedAt',stamp,'via','owner-capture'))
 on conflict(id) do update set data=excluded.data;
 insert into app_status(id,data) values('conn_'||p_domain,jsonb_build_object('domain',p_domain,'savedAt',stamp,'needsReconnect',false))
 on conflict(id) do update set data=excluded.data;
 return true;
end $$;
revoke all on function public.issue_capture_ticket(text,text),public.capture_publisher_session(text,text,text) from public,anon,authenticated;
grant execute on function public.issue_capture_ticket(text,text),public.capture_publisher_session(text,text,text) to service_role;

-- Exhaustion ends this job; only explicit provider invalidation removes a device.
alter table public.audit_push_jobs drop constraint if exists audit_push_jobs_state_check;
alter table public.audit_push_jobs add constraint audit_push_jobs_state_check check(state in ('pending','sending','retry','sent','gone','failed'));
create or replace function public.audit_finish_push(p_id bigint,p_token uuid,p_outcome text,p_error text)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare v_final text:=p_outcome; v_attempts integer;
begin
 if p_outcome not in ('sent','retry','gone') then raise exception 'invalid outcome'; end if;
 select attempts into v_attempts from audit_push_jobs where id=p_id and state='sending' and claim_token=p_token for update;
 if v_attempts is null then raise exception 'stale delivery lease'; end if;
 if p_outcome='retry' and v_attempts>=10 then v_final:='failed'; end if;
 update audit_push_jobs set state=v_final,last_error=p_error,claim_token=null,lease_until=null,
 next_attempt_at=now()+make_interval(secs=>least(21600,60*power(2,least(attempts,8)))::integer)
 where id=p_id and state='sending' and claim_token=p_token;
 if v_final='gone' then delete from push_subs where sub->>'endpoint'=(select j.sub->>'endpoint' from audit_push_jobs j where j.id=p_id); end if;
end $$;
-- Complete generic watch microcopy prevents truncating names or financial claims.
create or replace function public.audit_watch_payload(p_items jsonb,p_day text,p_tag text)
returns jsonb language sql immutable set search_path=public,pg_temp as $$
 select jsonb_build_object('title','Watchlist update',
 'body',case when jsonb_array_length(p_items)=1 and length(p_items->0->>'title')<=130 then p_items->0->>'title'
 else jsonb_array_length(p_items)||' stories mention players you follow.' end,
 'url',case when jsonb_array_length(p_items)=1 then './#/story/'||p_day||'/'||(p_items->0->>'id') else './#/day/'||p_day end,
 'tag',p_tag,'watchItems',p_items,'watchDay',p_day);
$$;
-- Baseline yesterday on installation so enabling discovery never blasts an archive.
create table if not exists public.audit_story_discovery(day date,story_id text,eligible boolean not null,primary key(day,story_id));
alter table public.audit_story_discovery enable row level security;
revoke all on public.audit_story_discovery from public,anon,authenticated;
insert into public.audit_story_discovery(day,story_id,eligible)
select d.date,s->>'id',false from public.days d cross join lateral jsonb_array_elements(d.data->'stories') s
where d.date=(now() at time zone 'America/New_York')::date-1 and s->>'id' is not null on conflict do nothing;
create or replace function public.audit_discover_stories(p_days jsonb,p_today date)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare result jsonb;
begin
 insert into audit_story_discovery(day,story_id,eligible)
 select (d->>'date')::date,s->>'id',true from jsonb_array_elements(p_days) d cross join lateral jsonb_array_elements(d->'data'->'stories') s
 where (d->>'date')::date between p_today-1 and p_today and s->>'id' is not null on conflict do nothing;
 select coalesce(jsonb_agg(day::text||':'||story_id),'[]'::jsonb) into result from audit_story_discovery where day between p_today-1 and p_today and eligible;
 delete from audit_story_discovery where day<p_today-2;
 return result;
end $$;
revoke all on function public.audit_discover_stories(jsonb,date) from public,anon,authenticated;
grant execute on function public.audit_discover_stories(jsonb,date) to service_role;

-- Add observed clocks only: existing history deliberately remains NULL.
alter table public.audit_push_jobs add column if not exists provider_accepted_at timestamptz;
alter table public.audit_push_jobs add column if not exists last_finished_at timestamptz;
comment on column public.audit_push_jobs.provider_accepted_at is 'Database observation of acknowledged provider success; not device receipt. No historical backfill.';
comment on column public.audit_push_jobs.last_finished_at is 'Latest acknowledged attempt outcome, including retry; not necessarily terminal completion.';

create or replace function public.audit_finish_push(p_id bigint,p_token uuid,p_outcome text,p_error text)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare v_final text:=p_outcome; v_attempts integer; v_observed timestamptz;
begin
 if p_outcome is null or p_outcome not in ('sent','retry','gone') then raise exception 'invalid outcome'; end if;
 select attempts into v_attempts from audit_push_jobs where id=p_id and state='sending' and claim_token=p_token for update;
 if v_attempts is null then raise exception 'stale delivery lease'; end if;
 -- Observe after acquiring the current claim; transaction-start time can predate a lock wait.
 v_observed:=clock_timestamp();
 if p_outcome='retry' and v_attempts>=10 then v_final:='failed'; end if;
 update audit_push_jobs set state=v_final,last_error=p_error,claim_token=null,lease_until=null,
 last_finished_at=v_observed,
 provider_accepted_at=case when v_final='sent' then coalesce(provider_accepted_at,v_observed) else provider_accepted_at end,
 next_attempt_at=now()+make_interval(secs=>least(21600,60*power(2,least(attempts,8)))::integer)
 where id=p_id and state='sending' and claim_token=p_token;
 if v_final='gone' then delete from push_subs where sub->>'endpoint'=(select j.sub->>'endpoint' from audit_push_jobs j where j.id=p_id); end if;
end $$;
revoke all on function public.audit_finish_push(bigint,uuid,text,text) from public,anon,authenticated;
grant execute on function public.audit_finish_push(bigint,uuid,text,text) to service_role;

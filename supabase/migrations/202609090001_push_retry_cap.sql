-- Push delivery: dead-letter a device that keeps failing with a non-410 error.
--
-- The web-push drain (audit-delivery.mjs) only classifies 404/410 as "gone"
-- (prunable). A subscription created under a since-rotated VAPID key is rejected
-- by Apple with 400 Bad Request, which fell into "retry" — so it retried on
-- every event forever (10 zombie jobs, one per notification) and was never
-- pruned. Pruning on a single 400 is unsafe (a global request bug would nuke
-- every subscription), so instead cap the retries: once a job has exhausted the
-- backoff ladder (>=10 attempts) it is treated as dead — marked 'gone' and its
-- push_subs row deleted, exactly like a 410. Sustained failure, not one code.
create or replace function public.audit_finish_push(p_id bigint,p_token uuid,p_outcome text,p_error text)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare v_final text := p_outcome; v_attempts integer;
begin
 if p_outcome not in ('sent','retry','gone') then raise exception 'invalid outcome'; end if;
 select attempts into v_attempts from audit_push_jobs where id=p_id and state='sending' and claim_token=p_token;
 if v_attempts is null then raise exception 'stale delivery lease'; end if;
 if p_outcome='retry' and v_attempts>=10 then v_final:='gone'; end if;
 update audit_push_jobs set state=v_final,last_error=p_error,claim_token=null,lease_until=null,
 next_attempt_at=now()+make_interval(secs=>least(21600,60*power(2,least(attempts,8)))::integer)
 where id=p_id and state='sending' and claim_token=p_token;
 if v_final='gone' then
  delete from push_subs where sub->>'endpoint'=(select j.sub->>'endpoint' from audit_push_jobs j where j.id=p_id);
 end if;
end $$;

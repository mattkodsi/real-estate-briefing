-- Private capability per queued delivery; historical device observations stay unknown.
alter table public.audit_push_jobs
 add column if not exists receipt_token uuid not null default gen_random_uuid(),
 add column if not exists device_received_at timestamptz,
 add column if not exists device_displayed_at timestamptz;
comment on column public.audit_push_jobs.device_received_at is 'First server receipt of service-worker received acknowledgement; not provider acceptance or user reading.';
comment on column public.audit_push_jobs.device_displayed_at is 'First server receipt after showNotification resolved; not proof the user saw or read it.';

create or replace function public.audit_observe_delivery(p_id bigint,p_token uuid,p_stage text)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
begin
 if p_stage not in ('received','displayed') or p_stage is null then return; end if;
 update public.audit_push_jobs
 set device_received_at=case when p_stage='received' then coalesce(device_received_at,clock_timestamp()) else device_received_at end,
     device_displayed_at=case when p_stage='displayed' then coalesce(device_displayed_at,clock_timestamp()) else device_displayed_at end
 where id=p_id and receipt_token=p_token and attempts>0
   and created_at>=clock_timestamp()-interval '7 days';
 -- No row counts or identifiers returned: bad proofs and expired jobs look alike.
end;
$$;
revoke all on function public.audit_observe_delivery(bigint,uuid,text) from public,anon,authenticated;
grant execute on function public.audit_observe_delivery(bigint,uuid,text) to service_role;

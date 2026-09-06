-- Run against an EMPTY disposable PostgreSQL database only, with ON_ERROR_STOP.
-- The surrounding transaction rolls back synthetic schema/data after assertions.
begin;
create role anon; create role authenticated; create role service_role;
create schema extensions;
create table public.prefs(profile text primary key,data jsonb not null default '{}',updated_at timestamptz not null default now());
create table public.push_subs(id text primary key,profile text not null,sub jsonb not null,created_at timestamptz not null default now());
grant select,insert,update,truncate,references,trigger on public.prefs,public.push_subs to anon,authenticated;
create extension pgcrypto with schema extensions;
insert into public.prefs values('amy',jsonb_build_object('name','Amy','color','#ffffff','pinHash',encode(extensions.digest('amy:1234','sha256'),'hex'),'saved',jsonb_build_array('old')),now());
-- Migration transaction statements removed by runner, so test stays rollback-only.
\ir ../work/profile-migration-body.sql
DO $$
declare r jsonb; t text; i integer;
begin
 if has_table_privilege('anon','public.prefs','SELECT') or has_table_privilege('anon','public.prefs','TRUNCATE') or has_table_privilege('authenticated','public.push_subs','TRUNCATE') then raise exception 'public prefs readable'; end if;
 if has_function_privilege('anon','public.reader_profile_api(jsonb,text)','EXECUTE') then raise exception 'public RPC executable'; end if;
 r:=public.reader_profile_api('{"action":"list"}');
 if r::text like '%pinHash%' or r->'profiles'->0->>'hasPin' is distinct from 'true' then raise exception 'metadata unsafe'; end if;
 r:=public.reader_profile_api('{"action":"login","profile":"amy","pin":"9999"}','test');
 if r->>'error' is distinct from 'unauthorized' then raise exception 'wrong PIN accepted'; end if;
 r:=public.reader_profile_api('{"action":"login","profile":"amy","pin":"1234"}','test'); t:=r->>'token';
 if t is null then raise exception 'correct PIN rejected: %',r; end if;
 if exists(select 1 from reader_private.credentials where legacy_hash is not null) then raise exception 'legacy hash not upgraded'; end if;
 if exists(select 1 from public.prefs where data ? 'pinHash') then raise exception 'hash not scrubbed'; end if;
 r:=public.reader_profile_api(jsonb_build_object('action','load','profile','other','token',t));
 if r->>'error' is distinct from 'unauthorized' then raise exception 'cross profile session accepted'; end if;
 perform public.reader_profile_api(jsonb_build_object('action','patch','profile','amy','token',t,'changes',jsonb_build_object('theme','dark')));
 r:=public.reader_profile_api(jsonb_build_object('action','patch','profile','amy','token',t,'changes',jsonb_build_object('read',jsonb_build_array('story'))));
 if r->'data'->>'theme' is distinct from 'dark' or r->'data'->'saved' is distinct from  '["old"]'::jsonb then raise exception 'patch clobbered unrelated values'; end if;
 r:=public.reader_profile_api(jsonb_build_object('action','patch','profile','amy','token',t,'changes',jsonb_build_object('pinHash','x')));
 if r->>'error' is distinct from 'invalid_changes' then raise exception 'security field patch accepted'; end if;
 r:=public.reader_profile_api(jsonb_build_object('action','patch','profile','amy','token',t,'changes',jsonb_build_object('saved','bad')));
 if r->>'error' is distinct from 'invalid_changes' then raise exception 'invalid pref type accepted'; end if;
 perform public.reader_profile_api(jsonb_build_object('action','logout','profile','amy','token',t));
 r:=public.reader_profile_api(jsonb_build_object('action','load','profile','amy','token',t));
 if r->>'error' is distinct from 'unauthorized' then raise exception 'revoked token accepted'; end if;
 for i in 1..11 loop r:=public.reader_profile_api('{"action":"login","profile":"amy","pin":"9999"}','different-'||i); end loop;
 if r->>'error' is distinct from 'rate_limited' then raise exception 'profile brute force limit bypassed'; end if;
end $$;
rollback;

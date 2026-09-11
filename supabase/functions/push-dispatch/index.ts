// push-dispatch: the alerts brain (invoked by pg_cron every 10 minutes).
//
// The cloud routine can't send pushes (no egress), so this function watches
// the PUBLISHED data — the same pattern as the fill-content standby — and
// turns it into notifications:
//   1. breaking   — explicitly eligible recent stories → everyone opted in
//   2. ready      — the day's first edition → profiles who opted IN (off by default)
//   3. watchlist  — a watched player mentioned today → that profile
//   4. events     — a starred calendar event dated today (from ~8 AM ET)
//
// Every event/device pair is durably queued, atomically leased and marked sent
// only after provider acceptance. Explicit failures retry with backoff. Quiet overnight: nothing sends
// 9 PM–7 AM ET; unlogged items simply go out on the first morning run.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { denyUnlessAuthorized } from "../_shared/audit-auth.mjs";
import { pushCopy, briefingCopy, discoveryDates, checkedFetch, isPushEligible } from "../_shared/backend-policy.mjs";
import { drainDeliveries } from "../_shared/audit-delivery.mjs";
import "../../../js/research-identities.js";
import * as webpush from "jsr:@negrel/webpush@0.3.0";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const HEADERS = { "Content-Type": "application/json" };
const CONTACT = "mailto:mfkodsi@gmail.com";

async function sb(path: string, init: RequestInit = {}): Promise<Response> {
  const response = await checkedFetch(`${SB_URL}/rest/v1/${path}`, {
    ...init,
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`,
               "Content-Type": "application/json", Prefer: "resolution=merge-duplicates",
               ...(init.headers || {}) },
  });
  if (!response.ok) throw new Error(`Database request failed (${response.status})`);
  return response;
}
async function rpc(name: string, body: Record<string, unknown>): Promise<any> {
  const response = await sb(`rpc/${name}`, {method:"POST",body:JSON.stringify(body)});
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

async function loadServer(): Promise<InstanceType<typeof webpush.ApplicationServer> | null> {
  const rows = await (await sb("secrets?id=eq.vapid&select=data")).json();
  const data = rows?.[0]?.data;
  if (!data?.publicJwk || !data?.privateJwk) return null; // push-send ?setup=1 not run yet
  const keys = await webpush.importVapidKeys(
    { publicKey: data.publicJwk, privateKey: data.privateJwk },
    { extractable: false },
  );
  return await webpush.ApplicationServer.new({ contactInformation: CONTACT, vapidKeys: keys });
}

function nowET(): { date: string; hour: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York", hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit",
  }).formatToParts(new Date());
  const get = (t: string) => parts.find((p) => p.type === t)?.value || "0";
  return { date: `${get("year")}-${get("month")}-${get("day")}`, hour: parseInt(get("hour")) % 24 };
}

Deno.serve(async (req: Request) => {
  const denied = denyUnlessAuthorized(req); if (denied) return denied;
  try {
    const { date: today, hour } = nowET();
    // quiet overnight — everything unlogged goes out on the first morning run
    if (hour >= 21 || hour < 7) {
      return new Response(JSON.stringify({ ok: true, quiet: true }), { headers: HEADERS });
    }

    const [subRows, prefRows] = await Promise.all([
      (await sb("push_subs?select=profile,sub")).json(),
      (await sb("prefs?select=profile,data")).json(),
    ]);
    const subscribed = new Set<string>();
    for (const r of subRows || []) {
      if (r?.sub?.endpoint && !r.sub.disabled) subscribed.add(r.profile);
    }
    const notifOf = (p: string) =>
      (prefRows || []).find((r: { profile: string }) => r.profile === p)?.data?.notifications || {};
    const server = await loadServer();
    if (!server) {
      return new Response(JSON.stringify({ ok: true, note: "vapid not set up" }), { headers: HEADERS });
    }

    const deliver = async (profiles: string[], payload: Record<string, unknown>) => {
      if(profiles.length) await rpc("audit_enqueue_push", {p_event:payload.tag,p_profiles:profiles,p_payload:{...payload,...pushCopy(payload.title,payload.body)}});
    };

    const [yesterday] = discoveryDates(today);
    const dayRows = await (await sb(`days?date=gte.${yesterday}&date=lte.${today}&select=date,data`)).json();
    const day = dayRows.find((d:any)=>d.date===today)?.data;
    const discoverable = new Set(await rpc('audit_discover_stories',{p_days:dayRows,p_today:today}));
    const sentIds: string[] = [];
    // Profile/story dedupe across breaking and watchlist reasons, including earlier runs.
    const [watchSeen, breakingJobs] = await Promise.all([
      (await sb(`audit_watch_seen?day=gte.${yesterday}&day=lte.${today}&select=profile,day,story_id`)).json(),
      (await sb(`audit_push_jobs?event_id=like.spec:*&created_at=gte.${yesterday}T00:00:00Z&state=in.(pending,retry,sending,sent)&select=profile,event_id`)).json(),
    ]);
    const watchedAlready = new Set(watchSeen.map((r:any)=>`${r.profile}:${r.day}:${r.story_id}`));
    const breakingAlready = new Set(breakingJobs.map((r:any)=>`${r.profile}:${r.event_id.slice(5)}`));

    // 1) Explicit editorial breaking eligibility, independent of newsletter cadence.
    for (const row of dayRows) for (const s of row.data?.stories || []) {
      if (!isPushEligible(s) || !discoverable.has(`${row.date}:${s.id}`)) continue;
      const id = `spec:${row.date}:${s.id}`;
      const to = [...subscribed].filter((p) => notifOf(p).breaking !== false && !watchedAlready.has(`${p}:${row.date}:${s.id}`));
      if (to.length) {
        await deliver(to, {
          title: s.pushTitle || s.title,
          body: s.pushBody || s.summary || "",
          url: `./#/story/${row.date}/${encodeURIComponent(s.id)}`,
          tag: id,
        });
        for (const profile of to) breakingAlready.add(`${profile}:${row.date}:${s.id}`);
        sentIds.push(id);
      }
    }

    // 2) briefing ready — opt-IN only (notifications.ready === true)
    if (day && (day.stories || []).length) {
      const id = `ready:${today}`;
      {
        const to = [...subscribed].filter((p) => notifOf(p).ready === true);
        if (to.length) {
          await deliver(to, {
            ...briefingCopy(day),
            url: `./#/day/${today}`,
            tag: id,
          });
          sentIds.push(id);
        }
      }
    }

    // 3) watchlist: a watched player mentioned in today's stories
    const watchers = new Map<string, string[]>(); // profile -> watched slugs
    for (const r of prefRows || []) {
      const w = r?.data?.watchPlayers;
      if (subscribed.has(r.profile) && Array.isArray(w) && w.length &&
          notifOf(r.profile).watch !== false) watchers.set(r.profile, w);
    }
    if (watchers.size) {
      const union = [...new Set([...watchers.values()].flat())].filter(s=>/^[a-z0-9-]+$/.test(s));
      const playerRows = await (await sb(
        `players?select=slug,data&slug=in.(${union.map((s) => `"${s}"`).join(",")})`,
      )).json();
      // Reviewed aliases share history; keep the originally followed slug in
      // watchItems so DB eligibility and existing preferences remain valid.
      const related = [...new Set(playerRows.flatMap((r:any) =>
        (r.data?.researchReviews || []).filter((v:any) => v.decision === 'same_entity').flatMap((v:any) => v.keys || [])))].filter((s:any) => typeof s === 'string' && /^[a-z0-9-]+$/.test(s) && !union.includes(s));
      const relatedRows = related.length ? await (await sb(`players?select=slug,data&slug=in.(${related.map(s => `"${s}"`).join(",")})`)).json() : [];
      const unified = (globalThis as any).ResearchIdentities.consolidate([...playerRows,...relatedRows].map((r:any) => ({slug:r.slug,...r.data})));
      const canonical = new Map(unified.entries.map((p:any) => [p.slug,p]));
      for (const row of playerRows) row.data = canonical.get(unified.aliases[row.slug] || row.slug) || row.data;
      for (const discoveryDay of discoveryDates(today)) {
      const todayMentions = new Map<string, { name: string; id: string; title: string }[]>();
      for (const row of playerRows || []) {
        const hits = (row.data?.mentions || []).filter((m: { date: string }) => m.date === discoveryDay && discoverable.has(`${m.date}:${(m as any).id}`));
        if (hits.length) todayMentions.set(row.slug, hits.map((m: { id: string; title: string }) =>
          ({ name: row.data.name, id: m.id, title: m.title })));
      }
      for (const [profile, slugs] of watchers) {
        const items = slugs.flatMap(slug => (todayMentions.get(slug) || []).map(m => ({...m,slug})))
          .filter(m=>!breakingAlready.has(`${profile}:${discoveryDay}:${m.id}`));
        if(items.length) await rpc("audit_enqueue_watch", {p_profile:profile,p_day:discoveryDay,p_items:items});
      }
    }

    }

    // 4) starred calendar events dated today (morning reminder, from 8 AM)
    if (hour >= 8) {
      const evRows = await (await sb("events?select=id,data")).json();
      const todays = (evRows || []).filter((r: { data?: { date?: string } }) => r.data?.date === today);
      if (todays.length) {
        for (const r of prefRows || []) {
          const stars = r?.data?.starEvents;
          if (!subscribed.has(r.profile) || !Array.isArray(stars) || !stars.length) continue;
          for (const ev of todays) {
            if (!stars.includes(ev.id)) continue;
            const id = `event:${r.profile}:${ev.id}`;
            await deliver([r.profile], {
              title: "Saved event today",
              body: ev.data.title || "Open your saved calendar event.",
              url: `./#/calendar?event=${encodeURIComponent(ev.id)}`,
              tag: id,
            });
            sentIds.push(id);
          }
        }
      }
    }

    const delivery = await drainDeliveries(rpc, async (job: {sub: Parameters<InstanceType<typeof webpush.ApplicationServer>["subscribe"]>[0];payload: Record<string,unknown>}) => {
      await server.subscribe(job.sub).pushTextMessage(JSON.stringify(job.payload), {});
    });
    return new Response(JSON.stringify({ ok: true, date: today, queued: sentIds, ...delivery }), { headers: HEADERS });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String(e).slice(0, 300) }), { status: 500, headers: HEADERS });
  }
});

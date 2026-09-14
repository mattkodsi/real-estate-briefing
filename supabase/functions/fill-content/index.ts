/// <reference lib="dom" />
// fill-content: serverless STANDBY content-filler (layer 4 of the failover chain).
//
// A pg_cron job (fill-heartbeat-standby, every 15 min) invokes this function.
// While the primary filler (the GitHub Actions headless-browser workflow) is
// alive — its publication_workers primary pulse is fresh — this
// function exits immediately. When the pulse goes stale, it takes over with
// plain-HTTP fetching + DOM extraction, filling a small batch per invocation
// (edge CPU limits) until the queue drains across invocations.
//
// Honest limit: no browser here, so Cloudflare-JS-walled pages stay for the
// browser layers (GitHub Actions / the owner's Mac watchdog). It pulses ONLY
// on real progress (via: supabase-edge), never on no-ops, so a dead primary
// stays visible to the deeper layers.
//
// GET/POST ?date=YYYY-MM-DD (default today ET) &force=1 (skip standby check)
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createPipelineTrace } from "../_shared/pipeline-trace.mjs";
import { assessContent } from "../_shared/content-quality.mjs";
import { readPrimaryHeartbeat } from "../_shared/fill-heartbeat.mjs";
import { safeFetch } from "../_shared/audit-fetch.mjs";
import { denyUnlessAuthorized } from "../_shared/audit-auth.mjs";
import { parseHTML } from "https://esm.sh/linkedom@0.18.5/worker";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const HEADERS = { "Content-Type": "application/json" };
const MIN_WORDS = 120;
const BATCH = 4;            // stories per invocation — stay inside edge limits
const STALE_AFTER_MIN = 45; // primary pulses every 30 min

const DROP = "script,style,noscript,iframe,form,aside,nav,footer,header,svg,button";
const JUNK = /related|share|social|newsletter|promo|ad-|advert|subscribe|paywall|comment|footer|nav|menu|sidebar|recirc|trending|signup|modal|byline-block/i;
const KEEP = "p,h2,h3,blockquote,ul,ol,figure,img";

const wordsOf = (s: string) => s.split(/\s+/).filter(Boolean).length;
const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function looksBlocked(html: string): boolean {
  const low = html.slice(0, 4000).toLowerCase();
  return low.includes("just a moment") ||
    (low.includes("attention required") && low.includes("cloudflare")) ||
    low.includes("enable javascript and cookies to continue");
}

function goodImg(el: Element): string | null {
  const src = el.getAttribute("src") || el.getAttribute("data-src") || "";
  if (!src.startsWith("http")) return null;
  const m = src.match(/-(\d+)x(\d+)\.(?:jpe?g|png|webp|gif)$/);
  if (m && parseInt(m[1]) < 400) return null; // small WP thumbs
  const alt = esc(el.getAttribute("alt") || "");
  return `<img src="${esc(src)}" alt="${alt}">`;
}

function serialize(el: Element): { html: string; words: number; isBody: boolean } | null {
  const tag = el.tagName.toLowerCase();
  if (tag === "img") {
    const img = goodImg(el);
    return img ? { html: img, words: 0, isBody: false } : null;
  }
  if (tag === "figure") {
    const img = el.querySelector("img");
    const imgHtml = img ? goodImg(img) : null;
    const cap = el.querySelector("figcaption")?.textContent?.trim() || "";
    if (!imgHtml && !cap) return null;
    return { html: `<figure>${imgHtml || ""}${cap ? `<figcaption>${esc(cap)}</figcaption>` : ""}</figure>`, words: 0, isBody: false };
  }
  if (tag === "ul" || tag === "ol") {
    const items = [...el.querySelectorAll("li")]
      .map((li) => (li.textContent || "").replace(/\s+/g, " ").trim()).filter(Boolean);
    if (!items.length) return null;
    const text = items.join(" ");
    return { html: `<${tag}>${items.map((t) => `<li>${esc(t)}</li>`).join("")}</${tag}>`,
             words: wordsOf(text), isBody: true };
  }
  const text = (el.textContent || "").replace(/\s+/g, " ").trim();
  if (!text) return null;
  return { html: `<${tag}>${esc(text)}</${tag}>`, words: wordsOf(text),
           isBody: tag === "p" || tag === "blockquote" };
}

function extractPass(doc: Document, junkClasses: boolean): { html: string; words: number } {
  const root = (doc.querySelector("article") || doc.querySelector("body") || doc.documentElement)!
    .cloneNode(true) as Element;
  for (const el of [...root.querySelectorAll(DROP)]) el.remove();
  if (junkClasses) {
    for (const el of [...root.querySelectorAll("[class],[id]")]) {
      const sig = `${el.getAttribute("class") || ""} ${el.getAttribute("id") || ""}`;
      if (JUNK.test(sig)) el.remove();
    }
  }
  // collect top-level KEEP elements in document order (skip nested duplicates)
  const picked: Element[] = [];
  for (const el of [...root.querySelectorAll(KEEP)]) {
    if (picked.some((p) => p.contains(el))) continue;
    picked.push(el);
  }
  const blocks = picked.map(serialize).filter(Boolean) as { html: string; words: number; isBody: boolean }[];
  // nav-clutter trim: keep first..last substantial body block
  const idx = blocks.map((b, i) => (b.isBody && b.words >= 4 ? i : -1)).filter((i) => i >= 0);
  const sliced = idx.length ? blocks.slice(idx[0], idx[idx.length - 1] + 1) : blocks;
  const html = sliced.map((b) => b.html).join("");
  return { html, words: sliced.reduce((s, b) => s + b.words, 0) };
}

function extract(html: string): { ok: boolean; html: string; words: number; image: string | null; blocked: boolean; reason: string | null } {
  const blocked = looksBlocked(html);
  const { document: doc } = parseHTML(html);
  let res = extractPass(doc, true);
  if (!assessContent(res.html).ready) {
    const relaxed = extractPass(doc, false); // page-builder wrapped body in a junk-matching class
    if (assessContent(relaxed.html).ready) res = relaxed;
  }
  const gate = res.words < 300 && assessContent(extractPass(doc, false).html).reason === "subscriber_gate";
  const image = doc.querySelector('meta[property="og:image"]')?.getAttribute("content") || null;
  return { ok: !blocked && !gate && assessContent(res.html).ready, html: res.html, words: res.words, image, blocked, reason: blocked ? "bot_wall" : gate ? "subscriber_gate" : assessContent(res.html).reason };
}

async function databaseRequest(path: string, init: RequestInit = {}, correlation: Record<string,string> = {}): Promise<Response> {
  const response = await fetch(`${SB_URL}/rest/v1/${path}`, {
    ...init,
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`,
               "Content-Type": "application/json", Prefer: "resolution=merge-duplicates",
               ...(init.headers || {}), ...correlation },
  });
  if (!response.ok) throw new Error(`Database request failed (${response.status})`);
  return response;
}
async function sessionCookie(hostname: string, sb: typeof databaseRequest): Promise<string | null> {
  const h = hostname.toLowerCase().replace(/^www\./, "");
  const domain = h; // Exact stored host only; never guess public suffix boundaries.
  const ids = [`session_${domain}`];
  if (domain === "therealdeal.com") ids.push("trd_session");
  for (const id of ids) {
    try {
      const rows = await (await sb(`secrets?id=eq.${id}&select=data`)).json();
      const c = rows?.[0]?.data?.cookie;
      if (c) return c;
    } catch { /* next */ }
  }
  return null;
}

const isWrapper = (u: string) => {
  try {
    const h = new URL(u).hostname;
    return ["list-manage.com", "beehiiv.com", "mailchi.mp"].some((w) => h.endsWith(w));
  } catch { return false; }
};

function todayET(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date());
}

Deno.serve(async (req: Request) => {
  const denied = denyUnlessAuthorized(req); if (denied) return denied;
  // Correlation is local to this invocation, never mutable global state.
  const runId = crypto.randomUUID();
  const sb = (path: string, init: RequestInit = {}) => databaseRequest(path, init, {
    "x-briefing-run-id": runId, "x-briefing-producer": "supabase-edge",
  });
  const rpc = async (name: string, body: Record<string, unknown>) => {
    const response = await sb(`rpc/${name}`, {method:"POST",body:JSON.stringify(body)});
    const text = await response.text();return text ? JSON.parse(text) : null;
  };
  const trace = createPipelineTrace({sb,producer:"supabase-edge",runId});
  const startedAt = Date.now();
  let outcome = "completed";
  let phase = "filled";
  const params = new URL(req.url).searchParams;
  const date = params.get("date") || todayET();
  const force = params.get("force") === "1";

  const runSpan = crypto.randomUUID();
  const entity = {entity_type:"day",entity_key:date,details:{span_id:runSpan}};
  await trace.emit("run", "started", entity);
  try {
  // standby: act only when the primary's pulse is stale
  if (!force) {
    try {
      const heartbeat = await readPrimaryHeartbeat(async (path: string) => {
        const response = await sb(path);
        if (!response.ok) throw new Error("heartbeat unavailable");
        return await response.json();
      });
      const last = heartbeat?.lastRun;
      if (last) {
        const ageMin = (Date.now() - Date.parse(last)) / 60000;
        if (ageMin <= STALE_AFTER_MIN) {
          outcome = "skipped"; phase = "primary_fresh";
          return new Response(JSON.stringify({ ok: true, standby: true, pulseAgeMin: Math.round(ageMin) }), { headers: HEADERS });
        }
      }
    } catch { /* no pulse readable → act */ }
  }

  const dayRows = await (await sb(`days?date=eq.${date}&select=data`)).json();
  const day = dayRows?.[0]?.data;
  if (!day) {outcome="skipped";phase="no_day";return new Response(JSON.stringify({ ok: true, note: `no day for ${date}` }), { headers: HEADERS });}

  const expected = structuredClone(day);
  const stories: Record<string, unknown>[] = day.stories || [];
  const wordsIn = (h: unknown) => wordsOf(String(h || "").replace(/<[^>]+>/g, " "));
  const candidates = stories.filter((s) => !assessContent(s.content).ready && s.url);
  const claims = await rpc("audit_claim_fill", {p_day:date,p_candidates:candidates,p_limit:BATCH});
  const targets = claims.map((c: {story_id:string;source_url:string}) => candidates.find(s => String(s.id) === c.story_id && s.url === c.source_url)).filter(Boolean);
  if (!targets.length) {
    outcome="skipped";phase="no_targets";
    return new Response(JSON.stringify({ ok: true, note: "nothing to fill" }), { headers: HEADERS });
  }

  const filled: string[] = [], failed: string[] = [];
  for (const s of targets) {
    const storyEntity = {entity_type:"story",entity_key:`${date}/${s.id}`,details:{span_id:crypto.randomUUID(),parent_span_id:runSpan}};
    const extractStarted = Date.now();
    await trace.emit("article.fetch", "started", storyEntity);
    s.fillAttemptedAt = new Date().toISOString();
    let fetchError: string | null = null;
    try {
      const u = new URL(String(s.url));
      const res = await safeFetch(u.href, {cookie: await sessionCookie(u.hostname, sb)});
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const html = res.html;
      const parseEntity = {...storyEntity,details:{span_id:crypto.randomUUID(),parent_span_id:storyEntity.details.span_id}};
      await trace.emit("article.parse", "started", parseEntity);
      let out;
      try {
        out = extract(html);
        await trace.emit("article.parse", out.ok ? "completed" : "failed", {...parseEntity,details:{...parseEntity.details,words:out.words}});
      } catch(error) {
        await trace.emit("article.parse", "failed", parseEntity);
        throw error;
      }
      fetchError = out.reason;
      if (res.finalUrl && isWrapper(String(s.url)) && !isWrapper(res.finalUrl)) {
        const f = new URL(res.finalUrl);
        s.url = `${f.protocol}//${f.host}${f.pathname}`; // canonical publisher URL
      }
      if (out.ok && (!assessContent(s.content).ready || out.words > wordsIn(s.content))) {
        const stamp = new Date().toISOString();
        const wasReady = assessContent(s.content).ready;
        s.content = out.html;
        s.enrichedAt = stamp;
        s.enrichedBy = "supabase-edge";
        if (!wasReady && assessContent(s.content).ready) s.contentReadyAt = stamp;
        if (!s.image && out.image) s.image = out.image;
        delete s.sourceBlocked;
        filled.push(String(s.id));
      } else {
        failed.push(String(s.id));
      }
    } catch {
      fetchError = "fetch_failed";
      failed.push(String(s.id));
    }
    const quality = assessContent(s.content);
    s.contentStatus = quality.status;
    if (quality.ready) delete s.fillError;
    else { delete s.contentReadyAt; s.fillError = fetchError || quality.reason || "fetch_failed"; }
    await trace.emit("article.fetch", quality.ready ? "completed" : "failed", {
      ...storyEntity, details:{...storyEntity.details,duration_ms:Date.now()-extractStarted,phase:quality.ready ? "ready" : "not_ready"},
    });
  }

  if (targets.length) {
    day.generatedAt = new Date().toISOString();
    day.publishedAt = day.generatedAt;
    const publicationEntity = {...entity,details:{span_id:crypto.randomUUID(),parent_span_id:runSpan}};
    await trace.emit("publication.write", "started", publicationEntity);
    let published;
    try {
      published = await rpc("audit_publish_fill", {p_day:date,p_expected:expected,p_data:day});
    } catch(error) {
      await trace.emit("publication.write", "failed", publicationEntity);
      throw error;
    }
    await trace.emit("publication.write", published ? "completed" : "conflict", publicationEntity);
    if (!published) {outcome="conflict";phase="publication_conflict";return new Response(JSON.stringify({ok:true,date,conflict:true,filled:[],failed}),{headers:HEADERS});}
    // pulse ONLY on progress — a no-op standby must not mask a dead primary
    if (filled.length) await sb("secrets", { method: "POST", body: JSON.stringify({ id: "fill_heartbeat", data: {
      lastRun: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
      date, filled: filled.length, failed: failed.length, via: "supabase-edge",
    } }) });
    // Keep the legacy pulse above for older routines during the rollout.
    await sb("publication_workers", { method: "POST", body: JSON.stringify({ id: "fill_supabase-edge", data: {
      lastRun: new Date().toISOString(), date, filled: filled.length,
      failed: failed.length, via: "supabase-edge", state: "completed",
    } }) });
  }

  return new Response(JSON.stringify({ ok: true, date, filled, failed }), { headers: HEADERS });
  } catch(error) {
    outcome="failed";phase="handler_failed";
    throw error; // Preserve the original failure and existing edge response behavior.
  } finally {
    await trace.emit("run",outcome,{...entity,details:{...entity.details,duration_ms:Date.now()-startedAt,phase}});
  }
});

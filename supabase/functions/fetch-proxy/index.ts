// fetch-proxy: server-side article fetcher for the briefing pipeline.
//
// The scheduled cloud routine's egress policy blocks most news domains, but
// *.supabase.co is always reachable — so scripts/fetch_article.py falls back to
// this function, which fetches the page from Supabase's network instead and
// returns the raw HTML. It follows redirects (Traded's Mailchimp wrappers land
// on traded.co) and forwards the owner's TRD session cookie for therealdeal.com.
//
// GET/POST ?url=<article-url>  →  { ok, status, finalUrl, html }  (or { ok:false, error })
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { safeFetch } from "../_shared/audit-fetch.mjs";
import { denyUnlessAuthorized } from "../_shared/audit-auth.mjs";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

const HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-audit-secret",
  "Content-Type": "application/json",
};

// Stored subscriber session for any outlet: rows keyed `session_<domain>`
// (saved via scripts/trd_session.py --domain <site>); therealdeal.com also
// falls back to its legacy `trd_session` row.
async function sessionCookie(hostname: string): Promise<string | null> {
  const h = hostname.toLowerCase().replace(/^www\./, "");
  const domain = h; // Exact stored host only; never guess public suffix boundaries.
  const ids = [`session_${domain}`];
  if (domain === "therealdeal.com") ids.push("trd_session");
  for (const id of ids) {
    try {
      const res = await fetch(`${SB_URL}/rest/v1/secrets?id=eq.${id}&select=data`, {
        headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` },
      });
      const rows = await res.json();
      const c = rows?.[0]?.data?.cookie;
      if (c) return c;
    } catch {
      /* try the next id */
    }
  }
  return null;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: HEADERS });

  const denied = denyUnlessAuthorized(req); if (denied) return denied;
  const target = new URL(req.url).searchParams.get("url");
  if (!target) {
    return new Response(JSON.stringify({ ok: false, error: "missing ?url" }), { status: 400, headers: HEADERS });
  }
  let u: URL;
  try {
    u = new URL(target);
  } catch {
    return new Response(JSON.stringify({ ok: false, error: "bad url" }), { status: 400, headers: HEADERS });
  }
  try {
    const result = await safeFetch(u.href, { cookie: await sessionCookie(u.hostname) });
    return new Response(JSON.stringify(result), { headers: HEADERS });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String(e) }), { status: 502, headers: HEADERS });
  }
});

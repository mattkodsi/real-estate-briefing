// Live rates proxy v6: forward path extended to 5Y+ nodes for horizon toggles.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { checkedFetch, mergeMarket } from "../_shared/backend-policy.mjs";

const TENORS: Record<string, string> = {
  "1M": "BC_1MONTH", "2M": "BC_2MONTH", "3M": "BC_3MONTH", "4M": "BC_4MONTH",
  "6M": "BC_6MONTH", "1Y": "BC_1YEAR", "2Y": "BC_2YEAR", "3Y": "BC_3YEAR",
  "5Y": "BC_5YEAR", "7Y": "BC_7YEAR", "10Y": "BC_10YEAR", "20Y": "BC_20YEAR",
  "30Y": "BC_30YEAR",
};

const FRESH_MS = 10 * 60 * 1000;
const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
  "Content-Type": "application/json",
  "Cache-Control": "public, max-age=300",
};

async function readCache(): Promise<{ data: Record<string, unknown>; generated_at: string } | null> {
  const res = await checkedFetch(`${SB_URL}/rest/v1/rates_cache?id=eq.1&select=data,generated_at`, {
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` },
  });
  const rows = await res.json();
  return rows?.[0] ?? null;
}

async function writeCache(data: unknown) {
  await checkedFetch(`${SB_URL}/rest/v1/rates_cache`, {
    method: "POST",
    headers: {
      apikey: SB_KEY,
      Authorization: `Bearer ${SB_KEY}`,
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates",
    },
    body: JSON.stringify({ id: 1, data, generated_at: new Date().toISOString() }),
  });
}

function parseEntry(entry: string): { date: string; rates: Record<string, number> } | null {
  const m = entry.match(/<d:NEW_DATE[^>]*>([^<]+)</);
  if (!m) return null;
  const rates: Record<string, number> = {};
  for (const [label, field] of Object.entries(TENORS)) {
    const fm = entry.match(new RegExp(`<d:${field}[^>]*>([^<]+)<`));
    if (fm) {
      const v = parseFloat(fm[1]);
      if (!Number.isNaN(v)) rates[label] = v;
    }
  }
  return { date: m[1].slice(0, 10), rates };
}

async function treasuryYear(year: number) {
  const res = await checkedFetch(`https://home.treasury.gov/resource-center/data-chart-center/interest-rates/pages/xml?data=daily_treasury_yield_curve&field_tdr_date_value=${year}`);
  const xml = await res.text();
  return xml.split("<entry>").slice(1).map(parseEntry).filter(Boolean) as { date: string; rates: Record<string, number> }[];
}

// Approximate forward path treating Treasury par yields as zero yields; not an OIS curve or market forecast.
// Segments: monthly to 6M, then 1Y, 2Y, 3Y, 5Y, 7Y (each value = implied avg
// short rate over the segment starting at that point).
function impliedForwards(t: Record<string, number>, sofr: number | null) {
  const MONTHS: Record<string, number> = { "1M": 1, "2M": 2, "3M": 3, "4M": 4, "6M": 6, "1Y": 12, "2Y": 24, "3Y": 36, "5Y": 60, "7Y": 84, "10Y": 120 };
  const nodes: [number, number][] = [];
  for (const [k, m] of Object.entries(MONTHS)) if (t[k] != null) nodes.push([m, t[k] / 100]);
  nodes.sort((a, b) => a[0] - b[0]);
  const out: { m: number; rate: number }[] = [];
  if (sofr != null) out.push({ m: 0, rate: sofr });
  for (let i = 0; i < nodes.length - 1; i++) {
    const [m1, z1] = nodes[i];
    const [m2, z2] = nodes[i + 1];
    const t1 = m1 / 12, t2 = m2 / 12;
    const f = Math.pow(Math.pow(1 + z2, t2) / Math.pow(1 + z1, t1), 1 / (t2 - t1)) - 1;
    out.push({ m: m1, rate: Math.round(f * 10000) / 100 });
  }
  return out;
}

async function build() {
  const year = new Date().getFullYear();
  const [cur, prev, sofrRes, avgRes] = await Promise.all([
    treasuryYear(year),
    treasuryYear(year - 1),
    checkedFetch("https://markets.newyorkfed.org/api/rates/secured/sofr/last/260.json"),
    checkedFetch("https://markets.newyorkfed.org/api/rates/secured/sofrai/last/1.json"),
  ]);

  const all = [...prev, ...cur].sort((a, b) => a.date.localeCompare(b.date));
  const yearAgo = new Date(Date.now() - 370 * 86400000).toISOString().slice(0, 10);
  const hist = all.filter((e) => e.date >= yearAgo);
  const latest = all[all.length - 1];
  const prior = all[all.length - 2];
  if (!latest || !Object.keys(latest.rates).length) throw new Error("no treasury data");

  const sofrRows = (await sofrRes.json())?.refRates ?? [];
  if (!sofrRows.length || !Number.isFinite(sofrRows[0]?.percentRate)) throw new Error("No SOFR data");
  const sofr = sofrRows[0] ?? {};
  const sofrPrev = sofrRows[1] ?? {};
  const avgs = (await avgRes.json())?.refRates?.[0] ?? {};
  if (!Number.isFinite(avgs.average30day)) throw new Error("No SOFR averages");

  return {
    curveDate: latest.date,
    priorDate: prior?.date ?? null,
    treasury: latest.rates,
    treasuryPrior: prior?.rates ?? {},
    sofr: { rate: sofr.percentRate ?? null, date: sofr.effectiveDate ?? null, prior: sofrPrev.percentRate ?? null },
    sofrAverages: {
      "30d": avgs.average30day ?? null,
      "90d": avgs.average90day ?? null,
      "180d": avgs.average180day ?? null,
      date: avgs.effectiveDate ?? null,
    },
    forwardLabel: "Approximate Treasury-implied forwards",
    forwardMethod: "Treasury par yields treated as zero yields; not an OIS curve or a forecast of SOFR.",
    forward: impliedForwards(latest.rates, sofr.percentRate ?? null),
    history: {
      treasury: hist.map((e) => ({ date: e.date, "5Y": e.rates["5Y"] ?? null, "10Y": e.rates["10Y"] ?? null, "30Y": e.rates["30Y"] ?? null })),
      sofr: sofrRows.map((r: { effectiveDate: string; percentRate: number }) => ({ date: r.effectiveDate, rate: r.percentRate })).reverse(),
    },
    generatedAt: new Date().toISOString(),
    source: "live",
  };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: HEADERS });
  let stale: { data: Record<string, unknown>; generated_at: string } | null = null;
  try {
    stale = await readCache();
    const staleForward = (stale?.data?.forward as { m: number }[] | undefined) ?? [];
    const hasLongNodes = staleForward.some((p) => p.m >= 24);
    if (stale && hasLongNodes && Date.now() - Date.parse(stale.generated_at) < FRESH_MS) {
      return new Response(JSON.stringify(stale.data), { headers: HEADERS });
    }
    const fresh = await build();
    if (stale?.data?.curveDate && fresh.curveDate < String(stale.data.curveDate)) throw new Error("Regressed Treasury date");
    if (!["1M","3M","6M","1Y","2Y","5Y","10Y","30Y"].every(t=>Number.isFinite(fresh.treasury[t]))) throw new Error("Incomplete Treasury curve");
    await writeCache(fresh);
    return new Response(JSON.stringify(fresh), { headers: HEADERS });
  } catch (e) {
    if (stale) return new Response(JSON.stringify({...stale.data, stale:true, refreshError:"Refresh failed; showing last successful data"}), { headers: HEADERS });
    return new Response(JSON.stringify({ error: String(e) }), { status: 500, headers: HEADERS });
  }
});

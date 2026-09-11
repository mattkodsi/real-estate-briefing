// Market Pulse v1 — pools free public data into one national + by-metro read.
//   • FRED (St. Louis Fed) — the macro backbone: rates, prices, credit, housing,
//     the economy, plus per-metro Case-Shiller home-price indices.
//   • Zillow research CSVs — best-effort metro rent (ZORI) & home value (ZHVI),
//     the closest free stand-in for market-level CoStar/TRD data.
// Writes a single cache row (market_pulse.id = 1) the app reads via PostgREST;
// pg_cron refreshes it a few times a day. Serving on GET revalidates when stale.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { checkedFetch, mergeMarket } from "../_shared/backend-policy.mjs";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const FRESH_MS = 3 * 60 * 60 * 1000; // 3h
const START = "2015-01-01";
const KEEP_MONTHS = 96;

const HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
  "Content-Type": "application/json",
  "Cache-Control": "public, max-age=600",
};

const NATIONAL: { key: string; id: string; label: string; short: string; unit: string; group: string; yoy?: boolean; invert?: boolean }[] = [
  { key: "ust10y", id: "DGS10", label: "10-Year Treasury", short: "10Y UST", unit: "%", group: "rates" },
  { key: "ust2y", id: "DGS2", label: "2-Year Treasury", short: "2Y UST", unit: "%", group: "rates" },
  { key: "spread", id: "T10Y2Y", label: "10Y–2Y Spread", short: "2s10s", unit: "%", group: "rates" },
  { key: "mortgage30", id: "MORTGAGE30US", label: "30-Year Mortgage", short: "30Y Mortgage", unit: "%", group: "rates", invert: true },
  { key: "fedfunds", id: "FEDFUNDS", label: "Fed Funds Rate", short: "Fed Funds", unit: "%", group: "rates" },
  { key: "hpi", id: "CSUSHPINSA", label: "Home Prices (Case-Shiller US)", short: "Home prices", unit: "index", group: "housing", yoy: true },
  { key: "medianprice", id: "MSPUS", label: "Median Home Sale Price", short: "Median price", unit: "$", group: "housing", yoy: true },
  { key: "starts", id: "HOUST", label: "Housing Starts (SAAR)", short: "Housing starts", unit: "K", group: "housing", yoy: true },
  { key: "permits", id: "PERMIT", label: "Building Permits (SAAR)", short: "Permits", unit: "K", group: "housing", yoy: true },
  { key: "existing", id: "EXHOSLUSM495S", label: "Existing Home Sales (SAAR)", short: "Home sales", unit: "M", group: "housing", yoy: true },
  { key: "rentcpi", id: "CUUR0000SEHA", label: "Rents (CPI, primary residence)", short: "Rent inflation", unit: "index", group: "housing", yoy: true },
  { key: "cre_delinq", id: "DRCRELEXFACBS", label: "CRE Loan Delinquency", short: "CRE delinquency", unit: "%", group: "credit", invert: true },
  { key: "resi_delinq", id: "DRSFRMACBS", label: "Mortgage Delinquency (1–4 unit)", short: "Resi delinquency", unit: "%", group: "credit", invert: true },
  { key: "vacancy", id: "RRVRUSQ156N", label: "Rental Vacancy Rate", short: "Rental vacancy", unit: "%", group: "housing" },
  { key: "cpi", id: "CPIAUCSL", label: "Inflation (CPI)", short: "Inflation", unit: "index", group: "economy", yoy: true },
  { key: "unemp", id: "UNRATE", label: "Unemployment Rate", short: "Unemployment", unit: "%", group: "economy", invert: true },
];

const METROS: Record<string, { cs: string; zillow: string }> = {
  "New York": { cs: "NYXRSA", zillow: "New York, NY" },
  "Los Angeles": { cs: "LXXRSA", zillow: "Los Angeles, CA" },
  "SF Bay Area": { cs: "SFXRSA", zillow: "San Francisco, CA" },
  "South Florida": { cs: "MIXRSA", zillow: "Miami, FL" },
  "Chicago": { cs: "CHXRSA", zillow: "Chicago, IL" },
  "Washington DC": { cs: "WDXRSA", zillow: "Washington, DC" },
  "Boston": { cs: "BOXRSA", zillow: "Boston, MA" },
  "DFW": { cs: "DAXRSA", zillow: "Dallas, TX" },
  "Denver": { cs: "DNXRSA", zillow: "Denver, CO" },
  "Phoenix": { cs: "PHXRSA", zillow: "Phoenix, AZ" },
  "Atlanta": { cs: "ATXRSA", zillow: "Atlanta, GA" },
  "San Diego": { cs: "SDXRSA", zillow: "San Diego, CA" },
};

type Pt = { date: string; value: number };

function monthly(observations: { date: string; value: string }[]): Pt[] {
  const byMonth = new Map<string, Pt>();
  for (const o of observations || []) {
    const v = parseFloat(o.value);
    if (!Number.isFinite(v)) continue;
    byMonth.set(o.date.slice(0, 7), { date: o.date, value: v });
  }
  const all = [...byMonth.values()].sort((a, b) => a.date.localeCompare(b.date));
  return all.slice(-KEEP_MONTHS);
}

function minus12(ym: string): string {
  let [y, m] = ym.split("-").map(Number);
  y -= 1;
  return `${y}-${String(m).padStart(2, "0")}`;
}

function yearAgo(hist: Pt[]): Pt | null {
  if (!hist.length) return null;
  const target = minus12(hist[hist.length - 1].date.slice(0, 7));
  let best: Pt | null = null;
  for (const p of hist) { if (p.date.slice(0, 7) <= target) best = p; }
  return best;
}

function series(hist: Pt[]) {
  const latest = hist[hist.length - 1] || null;
  const prev = hist.length >= 2 ? hist[hist.length - 2] : null;
  const ya = yearAgo(hist);
  const yoy = latest && ya && ya.value ? ((latest.value - ya.value) / Math.abs(ya.value)) * 100 : null;
  return { latest, prev, yearAgo: ya, yoy, history: hist };
}

async function fred(id: string, key: string): Promise<Pt[]> {
  const url = `https://api.stlouisfed.org/fred/series/observations?series_id=${id}&api_key=${key}&file_type=json&observation_start=${START}`;
  const res = await checkedFetch(url);
  if (!res.ok) throw new Error(`fred ${id} ${res.status}`);
  const j = await res.json();
  return monthly(j.observations || []);
}

// quote-aware CSV row parser — Zillow quotes RegionName ("New York, NY"), so a
// naive comma split shifts every column after it.
function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "", q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; }
      else cur += c;
    } else if (c === '"') { q = true; }
    else if (c === ",") { out.push(cur); cur = ""; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

// Zillow research CSV: RegionID,SizeRank,RegionName,RegionType,StateName,<date cols…>
async function zillow(csvUrl: string, wanted: Set<string>): Promise<Map<string, Pt[]>> {
  const out = new Map<string, Pt[]>();
  const res = await checkedFetch(csvUrl);
  if (!res.ok) throw new Error(`zillow ${res.status}`);
  const text = await res.text();
  const lines = text.split("\n");
  const header = parseCsvLine(lines[0]);
  const nameIdx = header.indexOf("RegionName");
  const dateCols: { idx: number; date: string }[] = [];
  for (let i = 0; i < header.length; i++) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(header[i].trim())) dateCols.push({ idx: i, date: header[i].trim() });
  }
  for (let li = 1; li < lines.length; li++) {
    if (!lines[li]) continue;
    const cols = parseCsvLine(lines[li]);
    const name = cols[nameIdx];
    if (!wanted.has(name)) continue;
    const byMonth = new Map<string, Pt>();
    for (const { idx, date } of dateCols) {
      const v = parseFloat(cols[idx]);
      if (Number.isFinite(v)) byMonth.set(date.slice(0, 7), { date, value: Math.round(v) });
    }
    out.set(name, [...byMonth.values()].sort((a, b) => a.date.localeCompare(b.date)).slice(-KEEP_MONTHS));
  }
  return out;
}

async function readCache() {
  const res = await checkedFetch(`${SB_URL}/rest/v1/market_pulse?id=eq.1&select=data,generated_at`, {
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` },
  });
  const rows = await res.json();
  return rows?.[0] ?? null;
}

async function writeCache(data: unknown) {
  await checkedFetch(`${SB_URL}/rest/v1/market_pulse`, {
    method: "POST",
    headers: {
      apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`,
      "Content-Type": "application/json", Prefer: "resolution=merge-duplicates",
    },
    body: JSON.stringify({ id: 1, data, generated_at: new Date().toISOString() }),
  });
}

async function fredKey(): Promise<string> {
  const res = await checkedFetch(`${SB_URL}/rest/v1/secrets?id=eq.fred&select=data`, {
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` },
  });
  const rows = await res.json();
  const key = rows?.[0]?.data?.key;
  if (!key) throw new Error("no FRED key in secrets");
  return key;
}

async function build() {
  const key = await fredKey();

  const national: Record<string, unknown> = {};
  await Promise.all(NATIONAL.map(async (s) => {
    try {
      const hist = await fred(s.id, key);
      if (hist.length) national[s.key] = { key: s.key, id: s.id, label: s.label, short: s.short, unit: s.unit, group: s.group, yoy: !!s.yoy, invert: !!s.invert, ...series(hist) };
    } catch (_e) { /* skip a bad series */ }
  }));

  const metros: Record<string, Record<string, unknown>> = {};
  await Promise.all(Object.entries(METROS).map(async ([market, cfg]) => {
    metros[market] = {};
    try {
      const hist = await fred(cfg.cs, key);
      if (hist.length) metros[market].caseShiller = series(hist);
    } catch (_e) { /* skip */ }
  }));

  const wanted = new Set(Object.values(METROS).map((m) => m.zillow));
  wanted.add("United States");
  const zilNat: Record<string, unknown> = {};
  try {
    const rent = await zillow("https://files.zillowstatic.com/research/public_csvs/zori/Metro_zori_uc_sfrcondomfr_sm_sa_month.csv", wanted);
    for (const [market, cfg] of Object.entries(METROS)) {
      const h = rent.get(cfg.zillow);
      if (h?.length) (metros[market] ||= {}).rent = series(h);
    }
    const usR = rent.get("United States");
    if (usR?.length) zilNat.rent = series(usR);
  } catch (_e) { /* skip rent */ }
  try {
    const val = await zillow("https://files.zillowstatic.com/research/public_csvs/zhvi/Metro_zhvi_uc_sfrcondo_tier_0.33_0.67_sm_sa_month.csv", wanted);
    for (const [market, cfg] of Object.entries(METROS)) {
      const h = val.get(cfg.zillow);
      if (h?.length) (metros[market] ||= {}).value = series(h);
    }
    const usV = val.get("United States");
    if (usV?.length) zilNat.value = series(usV);
  } catch (_e) { /* skip value */ }

  return {
    generatedAt: new Date().toISOString(),
    order: NATIONAL.map((s) => s.key),
    national,
    zillowNational: zilNat,
    metros,
    sources: ["FRED (St. Louis Fed)", "Zillow Research", "S&P CoreLogic Case-Shiller"],
  };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: HEADERS });
  let stale: { data: Record<string, unknown>; generated_at: string } | null = null;
  try {
    stale = await readCache();
    const force = false; // Public callers cannot bypass the refresh interval.
    if (!force && stale && Date.now() - Date.parse(stale.generated_at) < FRESH_MS) {
      return new Response(JSON.stringify(stale.data), { headers: HEADERS });
    }
    const built = await build();
    if (!Object.keys(built.national).length) throw new Error("No national series refreshed");
    const fresh = mergeMarket(stale?.data || {}, built);
    await writeCache(fresh);
    return new Response(JSON.stringify(fresh), { headers: HEADERS });
  } catch (e) {
    if (stale) return new Response(JSON.stringify({...stale.data, stale:true, refreshError:"Refresh failed; showing last successful data"}), { headers: HEADERS });
    return new Response(JSON.stringify({ error: String(e) }), { status: 500, headers: HEADERS });
  }
});

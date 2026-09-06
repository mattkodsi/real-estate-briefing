// push-send: web-push sender for the briefing (Phase 4 alerts plumbing).
//
// GET ?setup=1 reads the existing public applicationServerKey.
// Authorized POST ?setup=1 initializes missing keys once.
// POST {profiles?: string[]|null, title, body?, url?, tag?}
//               → deliver a notification to those profiles' devices
//                 (null/omitted = every subscribed device). Dead
//                 subscriptions (404/410 from the push service) are pruned.
//
// Apple's push service carries the message to installed home-screen web apps
// (iOS 16.4+). The service worker displays it and deep-links the tap.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { denyUnlessAuthorized } from "../_shared/audit-auth.mjs";
import { drainDeliveries } from "../_shared/audit-delivery.mjs";
import * as webpush from "jsr:@negrel/webpush@0.3.0";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const HEADERS = { "Content-Type": "application/json", "Access-Control-Allow-Origin":"*",
  "Access-Control-Allow-Headers":"authorization,apikey,content-type,x-audit-secret", "Access-Control-Allow-Methods":"GET,POST,OPTIONS" };
const CONTACT = "mailto:mfkodsi@gmail.com";

async function sb(path: string, init: RequestInit = {}): Promise<Response> {
  const response = await fetch(`${SB_URL}/rest/v1/${path}`, {
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

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlToBytes(s: string): Uint8Array {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  const bin = atob(s);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

// raw uncompressed P-256 point (0x04 || x || y) from the public JWK — the
// form pushManager.subscribe() wants as applicationServerKey
function rawPublicKey(jwk: JsonWebKey): string {
  const x = b64urlToBytes(jwk.x!), y = b64urlToBytes(jwk.y!);
  const out = new Uint8Array(65);
  out[0] = 4;
  out.set(x, 1);
  out.set(y, 33);
  return b64url(out);
}

export async function loadVapid(allowCreate = false): Promise<{ keys: CryptoKeyPair; publicKeyB64: string }> {
  const rows = await (await sb("secrets?id=eq.vapid&select=data")).json();
  let data = rows?.[0]?.data;
  if (!data?.publicJwk || !data?.privateJwk) {
    if (!allowCreate) throw new Error("VAPID not provisioned; authorized POST ?setup=1 required");
    const pair = await webpush.generateVapidKeys({ extractable: true });
    const exported = await webpush.exportVapidKeys(pair);
    data = {
      publicJwk: exported.publicKey,
      privateJwk: exported.privateKey,
      publicKeyB64: rawPublicKey(exported.publicKey),
      createdAt: new Date().toISOString(),
      note: "VAPID keypair for web push — generated once by push-send ?setup=1",
    };
    await sb("secrets", { method: "POST", headers:{Prefer:"resolution=ignore-duplicates"}, body: JSON.stringify({ id: "vapid", data }) });
    data = (await (await sb("secrets?id=eq.vapid&select=data")).json())?.[0]?.data;
  }
  const keys = await webpush.importVapidKeys(
    { publicKey: data.publicJwk, privateKey: data.privateJwk },
    { extractable: false },
  );
  return { keys, publicKeyB64: data.publicKeyB64 };
}

export async function deliver(
  profiles: string[] | null,
  payload: Record<string, unknown>,
): Promise<{ sent: number; pruned: number; failed: number; devices: number }> {
  const rows = await (await sb("push_subs?select=profile")).json();
  const recipients = profiles ?? [...new Set<string>(rows.map((r: {profile:string})=>r.profile))];
  const { keys } = await loadVapid();
  const server = await webpush.ApplicationServer.new({contactInformation:CONTACT,vapidKeys:keys});
  await rpc("audit_enqueue_push", {p_event:payload.tag,p_profiles:recipients,p_payload:payload});
  const result = await drainDeliveries(rpc, async (job: {sub: Parameters<InstanceType<typeof webpush.ApplicationServer>["subscribe"]>[0];payload: Record<string,unknown>}) => {
    await server.subscribe(job.sub).pushTextMessage(JSON.stringify(job.payload), {});
  }, 40, String(payload.tag));
  return {...result,devices:rows.length};
}

Deno.serve(async (req: Request) => {
  if(req.method === "OPTIONS") return new Response(null,{status:204,headers:HEADERS});
  try {
    const params = new URL(req.url).searchParams;
    if (params.get("setup") === "1") {
      const allowCreate = req.method === "POST";
      if (allowCreate) {const denied=denyUnlessAuthorized(req);if(denied)return denied;}
      if (!allowCreate && req.method !== "GET") return new Response(null,{status:405});
      const { publicKeyB64 } = await loadVapid(allowCreate);
      return new Response(JSON.stringify({ ok: true, publicKeyB64 }), { headers: HEADERS });
    }
    if (req.method !== "POST") {
      return new Response(JSON.stringify({ ok: false, error: "POST a notification, or GET ?setup=1" }), { headers: HEADERS });
    }
    const denied = denyUnlessAuthorized(req); if (denied) return denied;
    const body = await req.json().catch(() => ({}));
    if (!body.title) {
      return new Response(JSON.stringify({ ok: false, error: "title required" }), { headers: HEADERS });
    }
    const notificationId = body.notificationId || crypto.randomUUID();
    const res = await deliver(body.profiles ?? null, {
      title: body.title,
      body: body.body || "",
      url: body.url || "./",
      tag: `manual:${notificationId}`,
    });
    return new Response(JSON.stringify({ ok: true, notificationId, ...res }), { headers: HEADERS });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String(e).slice(0, 300) }), { headers: HEADERS });
  }
});

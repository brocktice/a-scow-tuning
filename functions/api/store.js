// Cloudflare Pages Function — shared per-user storage backed by Workers KV.
//
// Endpoint:  GET /api/store  -> { rev, store }
//            PUT /api/store  -> body is the full store JSON; returns { rev }
//
// Requires a KV namespace bound as STORE (Pages dashboard: Settings ->
// Functions -> KV namespace bindings, or wrangler.toml).
//
// Identity comes from Cloudflare Access: the verified email is namespaced into
// the KV key, so each crew sees only their own boats. With Access disabled
// (e.g. local dev) there is no email header and everyone shares DEFAULT_KEY —
// enable Access in production.

const DEFAULT_KEY = "shared";
const EMPTY = { rev: 0, store: { profiles: [], activeProfileId: null } };

function userKey(request) {
  const email = request.headers.get("Cf-Access-Authenticated-User-Email");
  return "store:" + (email ? email.toLowerCase() : DEFAULT_KEY);
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }
  });
}

export async function onRequestGet({ request, env }) {
  if (!env.STORE) return json({ error: "KV binding STORE is missing" }, 500);
  const raw = await env.STORE.get(userKey(request));
  if (!raw) return json(EMPTY);
  try {
    return json(JSON.parse(raw));
  } catch {
    return json(EMPTY);
  }
}

export async function onRequestPut({ request, env }) {
  if (!env.STORE) return json({ error: "KV binding STORE is missing" }, 500);
  let store;
  try {
    store = await request.json();
  } catch {
    return json({ error: "bad json" }, 400);
  }
  const key = userKey(request);
  let rev = 0;
  const prev = await env.STORE.get(key);
  if (prev) {
    try { rev = JSON.parse(prev).rev || 0; } catch { /* ignore */ }
  }
  rev += 1;
  await env.STORE.put(key, JSON.stringify({ rev, store }));
  return json({ rev });
}

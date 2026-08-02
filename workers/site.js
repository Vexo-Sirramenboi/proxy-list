/**
 * Cloudflare Worker: static assets + IP-rate-limited link click API.
 *
 * POST /api/link-click  { "url": "https://..." }
 *   - Rate limit: 40 clicks / hour / IP (Cache API)
 *   - Increments Firestore link_clicks/{sha256(normUrl)} via Admin REST when
 *     FIREBASE_PROJECT_ID + FIREBASE_CLIENT_EMAIL + FIREBASE_PRIVATE_KEY are set.
 *   - Without Firebase secrets, increments an in-edge Cache counter (Cloudflare-only).
 *
 * POST /api/link-clicks/get  { "urls": ["https://..."] }
 *   - Returns { counts: { [normUrl]: number } } from Firestore (public read) when
 *     project id is set; otherwise from edge cache counters.
 */
const RATE_LIMIT_MAX = 40;
const RATE_LIMIT_WINDOW_SEC = 3600;
const MAX_URL_LEN = 2048;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/api/link-click" && request.method === "POST") {
      return handleRecordClick(request, env, ctx);
    }
    if (url.pathname === "/api/link-click" && request.method === "OPTIONS") {
      return cors(new Response(null, { status: 204 }));
    }
    if (url.pathname === "/api/link-clicks/get" && request.method === "POST") {
      return handleGetClicks(request, env);
    }
    if (url.pathname === "/api/link-clicks/get" && request.method === "OPTIONS") {
      return cors(new Response(null, { status: 204 }));
    }

    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }
    return new Response("Not found", { status: 404 });
  },
};

function cors(res) {
  const headers = new Headers(res.headers);
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Content-Type");
  headers.set("Access-Control-Max-Age", "86400");
  return new Response(res.body, { status: res.status, headers });
}

function json(data, status = 200) {
  return cors(
    new Response(JSON.stringify(data), {
      status,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    })
  );
}

function clientIp(request) {
  return (
    request.headers.get("CF-Connecting-IP") ||
    request.headers.get("True-Client-IP") ||
    (request.headers.get("X-Forwarded-For") || "").split(",")[0].trim() ||
    "unknown"
  );
}

function normalizeUrl(raw) {
  let u = String(raw || "").trim();
  if (!u) return "";
  if (!/^https?:\/\//i.test(u)) u = "https://" + u;
  try {
    const parsed = new URL(u);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "";
    let out = parsed.href;
    if (out.endsWith("/") && (out.match(/\//g) || []).length > 3) out = out.replace(/\/+$/, "");
    return out.slice(0, MAX_URL_LEN);
  } catch (_) {
    return "";
  }
}

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function rateLimitOk(ip, ctx) {
  const bucket = Math.floor(Date.now() / (RATE_LIMIT_WINDOW_SEC * 1000));
  const keyUrl = `https://rate-limit.proxy-list.internal/click/${encodeURIComponent(ip)}/${bucket}`;
  const cache = caches.default;
  const req = new Request(keyUrl);
  let count = 0;
  const hit = await cache.match(req);
  if (hit) {
    count = Number(await hit.text()) || 0;
  }
  if (count >= RATE_LIMIT_MAX) {
    return { ok: false, count, limit: RATE_LIMIT_MAX };
  }
  count += 1;
  const res = new Response(String(count), {
    headers: {
      "Cache-Control": `public, max-age=${RATE_LIMIT_WINDOW_SEC}`,
      "Content-Type": "text/plain",
    },
  });
  ctx.waitUntil(cache.put(req, res.clone()));
  return { ok: true, count, limit: RATE_LIMIT_MAX };
}

function hasFirebaseAdmin(env) {
  return !!(env.FIREBASE_PROJECT_ID && env.FIREBASE_CLIENT_EMAIL && env.FIREBASE_PRIVATE_KEY);
}

function pemFromEnv(raw) {
  let key = String(raw || "").replace(/\\n/g, "\n").trim();
  if (!key.includes("BEGIN")) {
    key = `-----BEGIN PRIVATE KEY-----\n${key}\n-----END PRIVATE KEY-----`;
  }
  return key;
}

function base64url(bytes) {
  let str;
  if (typeof bytes === "string") {
    str = btoa(bytes);
  } else {
    let s = "";
    bytes.forEach((b) => {
      s += String.fromCharCode(b);
    });
    str = btoa(s);
  }
  return str.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function importPrivateKey(pem) {
  const cleaned = pem.replace(/-----BEGIN PRIVATE KEY-----/, "").replace(/-----END PRIVATE KEY-----/, "").replace(/\s+/g, "");
  const binary = Uint8Array.from(atob(cleaned), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey(
    "pkcs8",
    binary.buffer,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );
}

async function getGoogleAccessToken(env) {
  const cacheKey = "https://token.proxy-list.internal/firebase-access";
  const cache = caches.default;
  const cached = await cache.match(cacheKey);
  if (cached) {
    const data = await cached.json();
    if (data && data.access_token && data.exp * 1000 > Date.now() + 60000) {
      return data.access_token;
    }
  }

  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = base64url(
    JSON.stringify({
      iss: env.FIREBASE_CLIENT_EMAIL,
      sub: env.FIREBASE_CLIENT_EMAIL,
      aud: "https://oauth2.googleapis.com/token",
      iat: now,
      exp: now + 3600,
      scope: "https://www.googleapis.com/auth/datastore",
    })
  );
  const unsigned = `${header}.${claim}`;
  const key = await importPrivateKey(pemFromEnv(env.FIREBASE_PRIVATE_KEY));
  const sig = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(unsigned)
  );
  const jwt = `${unsigned}.${base64url(new Uint8Array(sig))}`;

  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });
  if (!tokenRes.ok) {
    const errText = await tokenRes.text();
    throw new Error(`token exchange failed: ${tokenRes.status} ${errText}`);
  }
  const tokenJson = await tokenRes.json();
  const access = tokenJson.access_token;
  const exp = now + Number(tokenJson.expires_in || 3600);
  await cache.put(
    cacheKey,
    new Response(JSON.stringify({ access_token: access, exp }), {
      headers: { "Cache-Control": "public, max-age=3500", "Content-Type": "application/json" },
    })
  );
  return access;
}

async function firestoreIncrementClick(env, docId, displayUrl) {
  const token = await getGoogleAccessToken(env);
  const project = env.FIREBASE_PROJECT_ID;
  const docName = `projects/${project}/databases/(default)/documents/link_clicks/${docId}`;
  const commitUrl = `https://firestore.googleapis.com/v1/projects/${project}/databases/(default)/documents:commit`;

  const incrementWrite = {
    transform: {
      document: docName,
      fieldTransforms: [
        { fieldPath: "count", increment: { integerValue: "1" } },
        { fieldPath: "updated", setToServerValue: "REQUEST_TIME" },
      ],
    },
  };

  const commitRes = await fetch(commitUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      writes: [
        incrementWrite,
        {
          update: {
            name: docName,
            fields: {
              url: { stringValue: displayUrl },
            },
          },
          updateMask: { fieldPaths: ["url"] },
          currentDocument: { exists: true },
        },
      ],
    }),
  });

  if (commitRes.ok) return { created: false };

  const createRes = await fetch(
    `https://firestore.googleapis.com/v1/projects/${project}/databases/(default)/documents/link_clicks?documentId=${encodeURIComponent(docId)}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        fields: {
          url: { stringValue: displayUrl },
          count: { integerValue: "1" },
          updated: { timestampValue: new Date().toISOString() },
        },
      }),
    }
  );
  if (createRes.ok) return { created: true };

  const retry = await fetch(commitUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ writes: [incrementWrite] }),
  });
  if (!retry.ok) {
    const t = await retry.text();
    throw new Error(`firestore write failed: ${createRes.status}/${retry.status} ${t}`);
  }
  return { created: false };
}

async function edgeIncrement(norm, ctx) {
  const cache = caches.default;
  const key = new Request(`https://clicks.proxy-list.internal/${await sha256Hex(norm)}`);
  let count = 0;
  const hit = await cache.match(key);
  if (hit) count = Number(await hit.text()) || 0;
  count += 1;
  ctx.waitUntil(
    cache.put(
      key,
      new Response(String(count), {
        headers: { "Cache-Control": "public, max-age=31536000", "Content-Type": "text/plain" },
      })
    )
  );
  return count;
}

async function edgeGetCounts(norms) {
  const cache = caches.default;
  const out = {};
  for (const norm of norms) {
    const key = new Request(`https://clicks.proxy-list.internal/${await sha256Hex(norm)}`);
    const hit = await cache.match(key);
    out[norm] = hit ? Number(await hit.text()) || 0 : 0;
  }
  return out;
}

async function firestoreGetCounts(env, norms) {
  const project = env.FIREBASE_PROJECT_ID;
  const out = {};
  // Public Firestore REST get does not need auth when rules allow read: if true
  await Promise.all(
    norms.map(async (norm) => {
      const id = await sha256Hex(norm);
      const res = await fetch(
        `https://firestore.googleapis.com/v1/projects/${project}/databases/(default)/documents/link_clicks/${id}`
      );
      if (!res.ok) {
        out[norm] = 0;
        return;
      }
      const doc = await res.json();
      const n = doc.fields && doc.fields.count && doc.fields.count.integerValue;
      out[norm] = n != null ? Number(n) : 0;
    })
  );
  return out;
}

async function handleRecordClick(request, env, ctx) {
  let body;
  try {
    body = await request.json();
  } catch (_) {
    return json({ ok: false, error: "invalid_json" }, 400);
  }
  const displayUrl = String((body && body.url) || "").trim().slice(0, MAX_URL_LEN);
  const norm = normalizeUrl(displayUrl);
  if (!norm || norm.length < 10) {
    return json({ ok: false, error: "invalid_url" }, 400);
  }

  const ip = clientIp(request);
  const rate = await rateLimitOk(ip, ctx);
  if (!rate.ok) {
    return json(
      { ok: false, error: "rate_limited", limit: rate.limit, windowSec: RATE_LIMIT_WINDOW_SEC },
      429
    );
  }

  const docId = await sha256Hex(norm);
  try {
    if (hasFirebaseAdmin(env)) {
      await firestoreIncrementClick(env, docId, displayUrl || norm);
      return json({ ok: true, via: "firestore", rate: { count: rate.count, limit: rate.limit } });
    }
    const count = await edgeIncrement(norm, ctx);
    return json({
      ok: true,
      via: "edge",
      count,
      rate: { count: rate.count, limit: rate.limit },
      warning: "Firebase admin secrets not configured; using edge counter only.",
    });
  } catch (err) {
    console.error("record_click_failed", err);
    return json({ ok: false, error: "internal_error" }, 500);
  }
}

async function handleGetClicks(request, env) {
  let body;
  try {
    body = await request.json();
  } catch (_) {
    return json({ ok: false, error: "invalid_json" }, 400);
  }
  const urls = Array.isArray(body && body.urls) ? body.urls.slice(0, 100) : [];
  const norms = [...new Set(urls.map(normalizeUrl).filter((u) => u && u.length >= 10))];
  try {
    let counts;
    if (env.FIREBASE_PROJECT_ID) {
      counts = await firestoreGetCounts(env, norms);
    } else {
      counts = await edgeGetCounts(norms);
    }
    return json({ ok: true, counts });
  } catch (err) {
    console.error("get_clicks_failed", err);
    return json({ ok: false, error: "internal_error" }, 500);
  }
}

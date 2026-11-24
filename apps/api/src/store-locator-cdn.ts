import { buildPublicStoreLocator, createDatabase, ensureStoreLocatorPublication, getStoreLocatorPublication, settleStoreLocatorPublication, type Database } from "@rueisiang/db";
import type { Env } from "./env.js";
import { mediaCdnConfig, mediaCdnUrl, purgeMediaCdnTag, requireMediaCdnStorage } from "./media-cdn.js";

export const STORE_LOCATOR_CDN_PATH = "/store-locator/stores.json";
const OBJECT_KEY = "public/store-locator/stores.json";
const CACHE_TAG = "store-locator";

export async function publishStoreLocatorCdn(env: Env, db: Database, force = false) {
  await ensureStoreLocatorPublication(db);
  let revision = (await getStoreLocatorPublication(db)).revision;
  try {
    const bucket = requireMediaCdnStorage(env);
    for (let attempt = 0; attempt < 3; attempt++) {
      // 必須先讀 R2 的 ETag，再讀 D1；舊請求只能條件式覆寫它當時看到的物件。
      const current = await bucket.head(OBJECT_KEY);
      const status = await getStoreLocatorPublication(db);
      revision = status.revision;
      if (!force && !status.pending && current) return status;
      const snapshot = await buildPublicStoreLocator(db, (id) => mediaCdnUrl(env, id));
      if ((await getStoreLocatorPublication(db)).revision !== revision) continue;
      const written = await bucket.put(OBJECT_KEY, JSON.stringify({ revision, ...snapshot }), {
        onlyIf: current ? { etagMatches: current.etag } : { etagDoesNotMatch: "*" },
        httpMetadata: { contentType: "application/json; charset=utf-8", cacheControl: "public, max-age=60" },
      });
      if (!written) continue;
      await purgeMediaCdnTag(env, CACHE_TAG);
      await settleStoreLocatorPublication(db, revision, null);
      return getStoreLocatorPublication(db);
    }
    throw new Error("據點資料更新中。");
  } catch {
    console.warn(JSON.stringify({ event: "store_locator.publish_pending", revision }));
    await settleStoreLocatorPublication(db, revision, "官網據點發布待重試；資料已儲存，系統也會定時重試。");
    return getStoreLocatorPublication(db);
  }
}

export async function maintainStoreLocatorCdn(env: Env) {
  if (!env.MEDIA || !env.MEDIA_CDN_URL) return;
  await publishStoreLocatorCdn(env, createDatabase(env.DB));
}

/** CDN 只讀最後成功寫入的 R2 快照；D1 或管理 API 故障不應阻擋這條讀取路徑。 */
export async function serveStoreLocatorCdn(request: Request, env: Env, cache: Cache | undefined = typeof caches === "undefined" ? undefined : caches.default) {
  const url = new URL(request.url);
  const headers = {
    "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
    "Access-Control-Allow-Headers": "If-None-Match", "Access-Control-Expose-Headers": "ETag", "Cross-Origin-Resource-Policy": "cross-origin",
    "X-Content-Type-Options": "nosniff",
  };
  if (url.origin !== mediaCdnConfig(env).origin || url.pathname !== STORE_LOCATOR_CDN_PATH) return new Response(null, { status: 404 });
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
  if (!["GET", "HEAD"].includes(request.method)) return new Response(null, { status: 405, headers: { ...headers, Allow: "GET, HEAD, OPTIONS", "Cache-Control": "no-store" } });
  try {
    const key = new Request(`${url.origin}${STORE_LOCATOR_CDN_PATH}`);
    let response: Response | undefined;
    try { response = await cache?.match(key); } catch { /* 快取服務失敗時改讀 R2。 */ }
    if (!response) {
      const object = await env.MEDIA?.get(OBJECT_KEY);
      if (!object) return Response.json({ error: "據點資料尚未發布。" }, { status: 503, headers: { ...headers, "Cache-Control": "no-store" } });
      response = new Response(object.body, { headers: {
        ...headers, "Content-Type": "application/json; charset=utf-8", ETag: object.httpEtag,
        "Cache-Control": "public, max-age=60", "Cache-Tag": CACHE_TAG,
      } });
      if (cache && request.method === "GET") {
        try { await cache.put(key, response.clone()); } catch { /* 快取寫入失敗不應讓快照無法讀取。 */ }
      }
    }
    const outgoing = new Headers(response.headers);
    outgoing.delete("Cache-Tag");
    const etag = outgoing.get("ETag");
    if (request.headers.get("If-None-Match")?.split(",").some((value) => value.trim().replace(/^W\//, "") === etag || value.trim() === "*")) {
      return new Response(null, { status: 304, headers: outgoing });
    }
    return new Response(request.method === "HEAD" ? null : response.body, { headers: outgoing });
  } catch {
    return Response.json({ error: "據點快照暫時無法讀取。" }, { status: 503, headers: { ...headers, "Cache-Control": "no-store" } });
  }
}

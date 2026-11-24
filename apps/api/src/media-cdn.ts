import { createDatabase, findMediaCdnImage, forgetMediaCdnBlob, listPendingMediaCdnPurges, listUnusedMediaCdnBlobs, settleMediaCdnPurge, type Database, type MediaCdnImage } from "@rueisiang/db";
import { HTTPException } from "hono/http-exception";
import type { Env } from "./env.js";

export function mediaCdnConfig(env: Env) {
  let url: URL;
  try { url = new URL(env.MEDIA_CDN_URL ?? ""); }
  catch { throw new HTTPException(503, { message: "尚未設定 CDN 網域。" }); }
  const local = url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname);
  if ((!local && url.protocol !== "https:") || url.pathname !== "/" || url.search || url.hash || url.username || url.password) throw new HTTPException(503, { message: "CDN 必須設定為獨立的 HTTPS origin。" });
  return { origin: url.origin, local };
}

export function mediaCdnUrl(env: Env, id: string) {
  return `${mediaCdnConfig(env).origin}/images/${id}`;
}

export function requireMediaCdnStorage(env: Env) {
  const config = mediaCdnConfig(env);
  if (!env.MEDIA) throw new HTTPException(503, { message: "尚未設定 media 儲存空間。" });
  if (!config.local && (!/^[a-f\d]{32}$/i.test(env.MEDIA_CDN_ZONE_ID ?? "") || !env.MEDIA_CDN_PURGE_TOKEN)) throw new HTTPException(503, { message: "尚未設定 Cloudflare CDN 快取清除憑證。" });
  return env.MEDIA;
}

export function mediaCdnView(env: Env, image: MediaCdnImage) {
  const { objectKey: _key, ...view } = image;
  return { ...view, url: mediaCdnUrl(env, image.id), previewUrl: `/api/media/images/${image.id}/preview?revision=${image.revision}` };
}

export async function purgeMediaCdnTag(env: Env, tag: string) {
  if (mediaCdnConfig(env).local) return;
  requireMediaCdnStorage(env);
  const response = await fetch(`https://api.cloudflare.com/client/v4/zones/${env.MEDIA_CDN_ZONE_ID}/purge_cache`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.MEDIA_CDN_PURGE_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ tags: [tag] }),
    signal: AbortSignal.timeout(10_000),
  });
  const result = await response.json() as { success?: boolean };
  if (!response.ok || result.success !== true) throw new Error("CDN 快取清除失敗。");
}

export async function purgeMediaCdnImage(env: Env, db: Database, image: MediaCdnImage) {
  let message: string | null = null;
  try {
    await purgeMediaCdnTag(env, `media-image-${image.id}`);
  } catch {
    // 不把上游回應或 token 印進 UI；pending 與 revision 保存在 D1，重開頁面或排程都能續跑。
    message = "CDN 快取清除失敗，請重試同步；系統也會定時重試。";
  }
  await settleMediaCdnPurge(db, image, message);
  return { ...image, purgePending: message !== null, purgeError: message };
}

export async function maintainMediaCdn(env: Env) {
  if (!env.MEDIA || !env.MEDIA_CDN_URL) return;
  const db = createDatabase(env.DB);
  for (const image of await listPendingMediaCdnPurges(db)) await purgeMediaCdnImage(env, db, image);
  for (const blob of await listUnusedMediaCdnBlobs(db)) {
    try {
      await env.MEDIA.delete(blob.objectKey);
      await forgetMediaCdnBlob(db, blob.objectKey);
    } catch {
      console.warn(JSON.stringify({ event: "media.cdn.cleanup_failed", objectKey: blob.objectKey }));
    }
  }
}

const browserCache = "public, no-cache, must-revalidate";
const notFound = () => new Response("找不到圖片", { status: 404, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });

/** 公開路徑只接受受管理的圖片 ID，從不接受任意 R2 key。 */
export async function serveMediaCdn(request: Request, env: Env, cache: Cache | undefined = typeof caches === "undefined" ? undefined : caches.default): Promise<Response> {
  const url = new URL(request.url);
  if (url.origin !== mediaCdnConfig(env).origin) return notFound();
  if (!["GET", "HEAD"].includes(request.method)) return new Response(null, { status: 405, headers: { Allow: "GET, HEAD", "Cache-Control": "no-store" } });
  const match = /^\/images\/([a-f\d-]{36})$/.exec(url.pathname);
  if (!match) return notFound();
  const db = createDatabase(env.DB);
  const image = await findMediaCdnImage(db, match[1]!);
  if (!image || image.deletedAt || !image.objectKey || !env.MEDIA) return notFound();
  const etag = `"${image.id}-${image.revision}"`;
  const key = new Request(mediaCdnUrl(env, image.id));
  let response: Response | undefined;
  try { response = await cache?.match(key); } catch { /* CDN 快取失敗時仍可讀 R2。 */ }
  // 固定 URL 的 cache hit 仍核對 D1 版本；可阻止 purge 期間與舊請求回填造成的舊圖復活。
  if (!response || response.headers.get("ETag") !== etag) {
    const object = await env.MEDIA.get(image.objectKey);
    if (!object) return notFound();
    response = new Response(object.body, { headers: {
      "Content-Type": image.contentType, "Content-Length": String(image.size), ETag: etag,
      "Cache-Control": "public, max-age=86400", "Cache-Tag": `media-image-${image.id}`, "X-Content-Type-Options": "nosniff",
      "Access-Control-Allow-Origin": "*", "Cross-Origin-Resource-Policy": "cross-origin",
    } });
    if (cache && request.method === "GET") {
      try { await cache.put(key, response.clone()); } catch { /* 容量或 cache service 失敗不應讓圖片壞掉。 */ }
    }
  }
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", browserCache);
  headers.delete("Cache-Tag");
  if (request.headers.get("If-None-Match")?.split(",").map((value) => value.trim().replace(/^W\//, "")).some((value) => value === etag || value === "*")) {
    headers.delete("Content-Length");
    return new Response(null, { status: 304, headers });
  }
  return new Response(request.method === "HEAD" ? null : response.body, { headers });
}

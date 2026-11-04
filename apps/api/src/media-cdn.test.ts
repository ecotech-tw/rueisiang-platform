import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { SESSION_COOKIE, newSessionClaims, signSession } from "@rueisiang/auth";
import { createDatabase, findMediaCdnImage, listUnusedMediaCdnBlobs, settleMediaCdnPurge, syncSystemRoles, type MediaCdnImage } from "@rueisiang/db";
import { mediaCdnImages, users, userRoleAssignments, userPermissionGrants } from "@rueisiang/db/schema";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "./index.js";
import { maintainMediaCdn, serveMediaCdn } from "./media-cdn.js";
import { createTargetOnlyD1, type LocalD1 } from "./local-d1/d1.js";
import { createLocalR2 } from "./local-d1/r2.js";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEklEQVR4AWJSdk3/D8JMDFAAAAAA///PlZhwAAAABklEQVQDAC5MA6EF8wd6AAAAAElFTkSuQmCC", "base64");
const SECRET = "media-cdn-test-secret";
let d1: LocalD1;
let directory: string;
let bucket: ReturnType<typeof createLocalR2>;
let cookies: Record<string, string>;
let purge: ReturnType<typeof vi.fn>;
const environment = () => ({ DB: d1, MEDIA: bucket, MEDIA_CDN_URL: "https://cdn.example.test", MEDIA_CDN_ZONE_ID: "a".repeat(32), MEDIA_CDN_PURGE_TOKEN: "test-purge-token", AUTH_SESSION_SECRET: SECRET, GOOGLE_OAUTH_CLIENT_ID: "test", GOOGLE_OAUTH_CLIENT_SECRET: "test" });
async function request(route: string, method = "GET", body?: BodyInit, actor = "admin", env = environment()) {
  return app.fetch(new Request(`https://platform.example.test/api/media${route}`, { method, headers: { ...(cookies[actor] ? { Cookie: cookies[actor] } : {}), ...(typeof body === "string" ? { "Content-Type": "application/json" } : {}) }, body }), env as never, {} as never);
}
function file(content: Uint8Array = png, type = "image/png", revision?: number) {
  const form = new FormData(); form.set("file", new Blob([Uint8Array.from(content).buffer], { type }), "官網主視覺.png"); form.set("name", "官網主視覺"); if (revision) form.set("revision", String(revision)); return form;
}
async function upload() {
  const response = await request("/images", "POST", file());
  expect(response.status).toBe(201);
  return (await response.json() as { image: MediaCdnImage & { url: string } }).image;
}
async function replace(image: MediaCdnImage, version = image.revision) { return request(`/images/${image.id}`, "PUT", file(png, "image/png", version)); }
async function publicImage(id: string, init?: RequestInit, cache?: Cache) { return serveMediaCdn(new Request(`https://cdn.example.test/images/${id}`, init), environment() as never, cache); }
const db = () => createDatabase(d1 as never);

beforeEach(async () => {
  d1 = createTargetOnlyD1(); directory = mkdtempSync(path.join(tmpdir(), "media-cdn-")); bucket = createLocalR2(directory);
  await syncSystemRoles(db()); cookies = {};
  for (const id of ["admin", "reader", "writer", "staff"]) {
    await db().insert(users).values({ id, email: `${id}@example.test`, displayName: id, status: "active" });
    cookies[id] = `${SESSION_COOKIE}=${encodeURIComponent(await signSession(newSessionClaims({ id, email: `${id}@example.test`, name: id, pictureUrl: "" }), SECRET))}`;
  }
  await db().insert(userRoleAssignments).values({ userId: "admin", roleId: "role-admin" });
  await db().insert(userPermissionGrants).values([{ userId: "reader", permission: "media:image:read" }, { userId: "writer", permission: "media:image:read" }, { userId: "writer", permission: "media:image:write" }]);
  purge = vi.fn().mockImplementation(async () => Response.json({ success: true })); vi.stubGlobal("fetch", purge);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); d1.sqlite.close(); rmSync(directory, { force: true, recursive: true }); });

describe("公開圖片管理與 CDN", () => {
  it("上傳、改名、取代保持固定 URL，公開路徑不依賴 session", async () => {
    const image = await upload(); expect(image.url).toBe(`https://cdn.example.test/images/${image.id}`); expect(image.purgePending).toBe(false); expect(image).not.toHaveProperty("objectKey");
    expect(purge).toHaveBeenCalledWith(expect.stringContaining(`/zones/${"a".repeat(32)}/purge_cache`), expect.objectContaining({ body: JSON.stringify({ tags: [`media-image-${image.id}`] }), headers: expect.objectContaining({ Authorization: "Bearer test-purge-token" }) }));
    const original = await findMediaCdnImage(db(), image.id);
    expect(original?.objectKey).toMatch(/^cdn\//); expect(original?.width).toBe(2);
    const response = await publicImage(image.id); expect(response.status).toBe(200); expect(Buffer.from(await response.arrayBuffer())).toEqual(png); expect(response.headers.get("Cache-Control")).toContain("no-cache"); expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff"); expect(response.headers.has("Set-Cookie")).toBe(false);
    const renamed = await request(`/images/${image.id}`, "PATCH", JSON.stringify({ name: "新的名稱", revision: 1 })); expect(renamed.status).toBe(200); const second = (await renamed.json() as { image: typeof image }).image; expect(second.url).toBe(image.url);
    const replaced = await replace(second); expect(replaced.status).toBe(200); expect((await replaced.json() as { image: typeof image }).image.url).toBe(image.url); expect((await findMediaCdnImage(db(), image.id))?.objectKey).not.toBe(original?.objectKey);
  });
  it("清單搜尋、格式篩選、分頁與私有預覽不暴露 R2 key", async () => {
    const image = await upload();
    const result = await request("/images?search=主視覺&type=image/png&page=1", "GET", undefined, "reader"); expect(result.status).toBe(200); const body = await result.json() as { total: number; images: unknown[] }; expect(body.total).toBe(1); expect(JSON.stringify(body)).not.toContain("objectKey");
    expect((await (await request("/images?search=%")).json() as { total: number }).total).toBe(0);
    expect((await (await request("/images?type=image/webp")).json() as { total: number }).total).toBe(0);
    const preview = await request(`/images/${image.id}/preview`, "GET", undefined, "reader"); expect(preview.status).toBe(200); expect(preview.headers.get("Cache-Control")).toBe("private, no-store");
    for (const query of ["page=0", "page=1.5", "page=Infinity", "type=image/svg+xml"]) expect((await request(`/images?${query}`)).status).toBe(400);
  });
  it("排序套用完整資料後才分頁，支援所有欄位與穩定的同值排序", async () => {
    const rows = Array.from({ length: 30 }, (_, index) => ({
      id: `sort-${String(index).padStart(2, "0")}`, name: `圖片 ${String(index).padStart(2, "0")}`, filename: `file-${index}.png`, objectKey: `test/${index}`,
      contentType: ["image/png", "image/jpeg", "image/webp"][index % 3]!, size: (index + 1) * 1000, width: (index + 1) * 10, height: (index + 1) * 10,
      createdBy: "admin", createdAt: new Date(Date.UTC(2026, 0, index + 1)).toISOString(), updatedAt: new Date(Date.UTC(2026, 0, 30 - index)).toISOString(), purgePending: index % 2 === 0,
    }));
    for (const row of rows) await db().insert(mediaCdnImages).values(row);
    const list = async (query: string) => (await (await request(`/images?${query}`)).json()) as { images: MediaCdnImage[]; total: number };
    const first = await list("sort=name&direction=asc"); const second = await list("sort=name&direction=asc&page=2");
    expect(first.total).toBe(30); expect(first.images).toHaveLength(24); expect(second.images).toHaveLength(6);
    expect(first.images[0]?.id).toBe("sort-00"); expect(second.images[0]?.id).toBe("sort-24");
    for (const sort of ["name", "pixels", "size", "createdAt"]) {
      expect((await list(`sort=${sort}&direction=asc`)).images[0]?.id).toBe("sort-00");
      expect((await list(`sort=${sort}&direction=desc`)).images[0]?.id).toBe("sort-29");
    }
    expect((await list("sort=updatedAt&direction=asc")).images[0]?.id).toBe("sort-29");
    expect((await list("sort=contentType&direction=asc")).images[0]?.contentType).toBe("image/jpeg");
    expect((await list("sort=status&direction=asc")).images[0]?.purgePending).toBe(false);
    d1.sqlite.prepare("UPDATE media_cdn_images SET deleted_at='2026-02-01' WHERE id='sort-29'").run();
    expect((await list("sort=status&direction=desc&deleted=true")).images[0]?.id).toBe("sort-29");
    d1.sqlite.prepare("UPDATE media_cdn_images SET deleted_at='2026-02-01' WHERE id='sort-00'").run();
    const statusRows = (await list("sort=status&direction=desc&deleted=true")).images;
    const pendingDeletedIndex = statusRows.findIndex((image) => image.id === "sort-00");
    expect(pendingDeletedIndex).toBeGreaterThan(1);
    expect(statusRows[pendingDeletedIndex]?.purgePending).toBe(true);
    expect(statusRows.slice(1, pendingDeletedIndex).every((image) => image.purgePending)).toBe(true);
    expect((await list("sort=size&direction=desc&type=image/webp&search=圖片")).images.every((image) => image.contentType === "image/webp" && !image.deletedAt)).toBe(true);
    d1.sqlite.prepare("UPDATE media_cdn_images SET name='同名'").run();
    const tiedFirst = await list("sort=name&direction=asc&deleted=true"); const tiedSecond = await list("sort=name&direction=asc&page=2&deleted=true");
    expect(new Set([...tiedFirst.images, ...tiedSecond.images].map((image) => image.id)).size).toBe(30);
    expect((await list("sort=name&direction=asc&deleted=true")).images.map((image) => image.id)).toEqual(tiedFirst.images.map((image) => image.id));
    for (const query of ["sort=unknown", "sort=__proto__", "sort=name%3BDROP%20TABLE%20users", "direction=sideways"]) expect((await request(`/images?${query}`)).status).toBe(400);
  });
  it("讀、寫、刪除分別由後端授權，停權立即生效", async () => {
    const image = await upload();
    for (const actor of ["missing", "staff"]) { const status = actor === "missing" ? 401 : 403; expect((await request("/images", "GET", undefined, actor)).status).toBe(status); expect((await request("/images", "POST", file(), actor)).status).toBe(status); }
    expect((await request("/images", "POST", file(), "reader")).status).toBe(403);
    expect((await request(`/images/${image.id}`, "DELETE", JSON.stringify({ revision: 1, confirmedUnused: true }), "writer")).status).toBe(403);
    expect((await request(`/images/${image.id}/preview`, "GET", undefined, "missing")).status).toBe(401);
    d1.sqlite.prepare("UPDATE users SET status='disabled' WHERE id='admin'").run(); expect((await request("/images")).status).toBe(403);
  });
  it.each([[Buffer.from("<svg onload=alert(1) />"), "image/svg+xml"], [png, "image/jpeg"], [png.subarray(0, 8), "image/png"], [new Uint8Array(), "image/png"], [new Uint8Array(10 * 1024 * 1024 + 1), "image/png"]])("拒絕不合規的圖片，不寫 R2：%s", async (content, type) => {
    const put = vi.spyOn(bucket, "put"); expect((await request("/images", "POST", file(content, type))).status).toBe(400); expect(put).not.toHaveBeenCalled();
  });
  it("超過整體 request 限制回 413；無效名稱與版本回 400", async () => {
    expect((await request("/images", "POST", file(new Uint8Array(11 * 1024 * 1024)))).status).toBe(413);
    const input = file(); input.set("name", " "); expect((await request("/images", "POST", input)).status).toBe(400);
    const image = await upload(); expect((await request(`/images/${image.id}`, "PATCH", JSON.stringify({ revision: -1, name: "新圖" }))).status).toBe(400);
  });
  it("畸形 JSON、非物件內容與錯誤的 multipart 回 400，不誤報伺服器錯誤", async () => {
    const image = await upload();
    for (const body of ["{", "null", "[]", '"文字"']) expect((await request(`/images/${image.id}`, "PATCH", body)).status).toBe(400);
    expect((await request("/images", "POST", "not multipart")).status).toBe(400);
    expect((await request(`/images/${image.id}`, "PATCH", JSON.stringify({ name: "a".repeat(20_000), revision: 1 }))).status).toBe(413);
  });
  it("舊版本不能覆寫／刪除；R2 失敗保留目前的圖片", async () => {
    const image = await upload(); const original = await findMediaCdnImage(db(), image.id);
    expect((await replace(image)).status).toBe(200); expect((await replace(image)).status).toBe(409);
    expect((await request(`/images/${image.id}`, "DELETE", JSON.stringify({ revision: 1, confirmedUnused: true }))).status).toBe(409);
    const current = await findMediaCdnImage(db(), image.id); vi.spyOn(bucket, "put").mockRejectedValueOnce(new Error("R2 unavailable")); vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await replace(current!)).status).toBe(500); expect((await findMediaCdnImage(db(), image.id))?.objectKey).toBe(current?.objectKey); expect(current?.objectKey).not.toBe(original?.objectKey);
  });
  it("並行取代只接受一份 revision，衝突版本留給安全清理", async () => {
    const image = await upload(); const results = await Promise.all([replace(image), replace(image)]); expect(results.map((result) => result.status).sort()).toEqual([200, 409]); expect((await findMediaCdnImage(db(), image.id))?.revision).toBe(2);
  });
  it("CDN purge 失敗保留待同步狀態，重開頁面與手動重試可恢復", async () => {
    purge.mockResolvedValueOnce(Response.json({ success: false }, { status: 429 })); const image = await upload(); expect(image.purgePending).toBe(true); expect(image.purgeError).toContain("重試");
    const listed = await (await request("/images")).json() as { images: MediaCdnImage[] }; expect(listed.images[0]?.purgePending).toBe(true);
    expect((await request(`/images/${image.id}/purge`, "POST")).status).toBe(200); expect((await findMediaCdnImage(db(), image.id))?.purgePending).toBe(false);
  });
  it("網路逾時或非 JSON 上游回應都不能誤報同步成功", async () => {
    purge.mockRejectedValueOnce(new Error("timeout")); const image = await upload(); expect(image.purgePending).toBe(true);
    purge.mockResolvedValueOnce(new Response("unavailable", { status: 503 })); const retry = await request(`/images/${image.id}/purge`, "POST"); expect((await retry.json() as { image: MediaCdnImage }).image.purgePending).toBe(true);
  });
  it("較舊的 purge 完成不能抹除後來更新的待同步狀態", async () => {
    const image = await upload(); purge.mockResolvedValueOnce(Response.json({ success: false })); expect((await replace(image)).status).toBe(200);
    await settleMediaCdnPurge(db(), image, null); expect((await findMediaCdnImage(db(), image.id))?.purgePending).toBe(true);
    await maintainMediaCdn(environment() as never); expect((await findMediaCdnImage(db(), image.id))?.purgePending).toBe(false);
  });
  it("舊 CDN cache、query variants 與舊 ETag 都不能在換圖後送出舊版本", async () => {
    const image = await upload(); let stored: Response | undefined;
    const cache = { match: vi.fn(async () => stored?.clone()), put: vi.fn(async (_key: Request, response: Response) => { stored = response.clone(); }) } as unknown as Cache;
    const first = await publicImage(image.id, undefined, cache); const etag = first.headers.get("ETag")!; expect(cache.put).toHaveBeenCalledOnce(); expect(stored?.headers.get("Cache-Tag")).toBe(`media-image-${image.id}`); expect(first.headers.has("Cache-Tag")).toBe(false);
    expect((await publicImage(image.id, { headers: { "If-None-Match": etag } }, cache)).status).toBe(304);
    purge.mockResolvedValueOnce(Response.json({ success: false })); await replace(image);
    const next = await publicImage(image.id, { headers: { "If-None-Match": etag } }, cache); expect(next.status).toBe(200); expect(next.headers.get("ETag")).not.toBe(etag);
    expect((await publicImage(image.id, { method: "HEAD" }, cache)).body).toBeNull();
    const variant = await serveMediaCdn(new Request(`${image.url}?random=1`), environment() as never, cache); expect(variant.status).toBe(200); expect((cache.match as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0].url).toBe(image.url);
  });
  it("刪除需要明確確認，網址立刻失效且 purge 可在刪除後重試", async () => {
    const image = await upload(); expect((await request(`/images/${image.id}`, "DELETE", JSON.stringify({ revision: 1 }))).status).toBe(400);
    purge.mockResolvedValueOnce(Response.json({ success: false })); expect((await request(`/images/${image.id}`, "DELETE", JSON.stringify({ revision: 1, confirmedUnused: true }))).status).toBe(200);
    expect((await publicImage(image.id)).status).toBe(404); expect((await request(`/images/${image.id}/preview`)).status).toBe(404); expect((await replace(image)).status).toBe(404);
    expect((await (await request("/images")).json() as { total: number }).total).toBe(0);
    expect((await (await request("/images?deleted=true")).json() as { total: number }).total).toBe(1);
    await maintainMediaCdn(environment() as never); expect((await findMediaCdnImage(db(), image.id))?.purgePending).toBe(false);
  });
  it("清理只移除超過一天且無參照的 R2 版本，不刪目前版本", async () => {
    const image = await upload(); const original = (await findMediaCdnImage(db(), image.id))!; await replace(image); const current = (await findMediaCdnImage(db(), image.id))!;
    expect(await listUnusedMediaCdnBlobs(db())).toHaveLength(0);
    d1.sqlite.prepare("UPDATE media_cdn_blobs SET created_at='2000-01-01T00:00:00.000Z'").run();
    await maintainMediaCdn(environment() as never); expect(await bucket.head(original.objectKey!)).toBeNull(); expect(await bucket.head(current.objectKey!)).not.toBeNull();
  });
  it("未設定儲存或 purge 憑證時拒絕寫入，不靜默跳過同步", async () => {
    for (const env of [{ ...environment(), MEDIA: undefined }, { ...environment(), MEDIA_CDN_ZONE_ID: "" }, { ...environment(), MEDIA_CDN_PURGE_TOKEN: "" }]) expect((await request("/images", "POST", file(), "admin", env as never)).status).toBe(503);
    expect(purge).not.toHaveBeenCalled();
  });
  it("platform 的非 API 請求仍交給 ASSETS，CDN hostname 不洩漏 SPA", async () => {
    const assets = { fetch: vi.fn(async () => new Response("portal shell")) };
    const env = { ...environment(), ASSETS: assets };
    expect(await (await app.fetch(new Request("https://platform.example.test/media/images"), env as never)).text()).toBe("portal shell");
    expect((await app.fetch(new Request("https://cdn.example.test/"), env as never)).status).toBe(404);
    expect(assets.fetch).toHaveBeenCalledOnce();
  });
  it("正式 CDN 的 HTTP／不同 port 只轉向 HTTPS，不進平台 API 或 ASSETS", async () => {
    const assets = { fetch: vi.fn(async () => new Response("portal shell")) };
    const env = { ...environment(), ASSETS: assets };
    for (const path of ["/", "/api/health", "/images/example?revision=2", "//external.example/path"]) {
      const response = await app.fetch(new Request(`http://cdn.example.test${path}`), env as never);
      expect(response.status).toBe(308);
      const target = new URL(response.headers.get("Location")!);
      expect(target.origin).toBe("https://cdn.example.test");
      expect(target.pathname + target.search).toBe(path);
    }
    expect((await app.fetch(new Request("https://cdn.example.test:8443/api/health"), env as never)).headers.get("Location")).toBe("https://cdn.example.test/api/health");
    expect((await app.fetch(new Request("https://cdn.example.test/api/health"), env as never)).status).toBe(404);
    expect(assets.fetch).not.toHaveBeenCalled();
  });
  it("本機共用 HTTP origin 仍可提供 API 與圖片，錯誤 CDN 設定不拖垮其他 API", async () => {
    const image = await upload();
    const env = { ...environment(), MEDIA_CDN_URL: "http://localhost:8787" };
    expect((await app.fetch(new Request("http://localhost:8787/api/health"), env as never)).status).toBe(200);
    expect((await app.fetch(new Request(`http://localhost:8787/images/${image.id}`), env as never)).status).toBe(200);
    for (const invalid of ["invalid", "http://platform.example.test", "ftp://platform.example.test", "https://platform.example.test/path", "https://user:secret@platform.example.test", "https://platform.example.test/?query=1", "https://platform.example.test/#hash"]) {
      const response = await app.fetch(new Request("https://platform.example.test/api/health"), { ...env, MEDIA_CDN_URL: invalid } as never);
      expect(response.status).toBe(200); expect(response.headers.get("Location")).toBeNull();
    }
  });
  it("CDN hostname 不能讀平台 API，平台 hostname 不能讀任意 R2 key", async () => {
    const image = await upload();
    expect((await app.fetch(new Request("https://cdn.example.test/api/auth/me"), environment() as never, {} as never)).status).toBe(404);
    expect((await app.fetch(new Request(`https://platform.example.test/images/${image.id}`), environment() as never, {} as never)).status).toBe(404);
    expect((await publicImage(image.id, { method: "POST" })).status).toBe(405);
    expect((await publicImage("../private" )).status).toBe(404);
  });
});

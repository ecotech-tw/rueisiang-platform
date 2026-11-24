import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { SESSION_COOKIE, newSessionClaims, signSession } from "@rueisiang/auth";
import { archiveReportManagementScope, buildPublicStoreLocator, createDatabase, createReportManagementScope, getStoreLocatorPublication, settleStoreLocatorPublication, syncSystemRoles, updateReportManagementScope, upsertReportScope } from "@rueisiang/db";
import { users, userRoleAssignments } from "@rueisiang/db/schema";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import app from "./index.js";
import type { Env } from "./env.js";
import { createTargetOnlyD1, type LocalD1 } from "./local-d1/d1.js";
import { createLocalR2 } from "./local-d1/r2.js";
import { maintainStoreLocatorCdn, publishStoreLocatorCdn, serveStoreLocatorCdn } from "./store-locator-cdn.js";

const CDN = "https://cdn.example.test/store-locator/stores.json";
const KEY = "public/store-locator/stores.json";
const SECRET = "store-locator-test";
let d1: LocalD1, directory: string, bucket: ReturnType<typeof createLocalR2>, cookie: string;
let purge: ReturnType<typeof vi.fn>;
const db = () => createDatabase(d1 as never);
const env = () => ({ DB: d1, MEDIA: bucket, MEDIA_CDN_URL: "https://cdn.example.test", MEDIA_CDN_ZONE_ID: "a".repeat(32), MEDIA_CDN_PURGE_TOKEN: "private-token", AUTH_SESSION_SECRET: SECRET, GOOGLE_OAUTH_CLIENT_ID: "test", GOOGLE_OAUTH_CLIENT_SECRET: "test" }) as unknown as Env;
const publish = () => publishStoreLocatorCdn(env(), db());
const publicRequest = (init?: RequestInit) => app.fetch(new Request(CDN, init), env());
async function snapshot() { return JSON.parse(await new Response((await bucket.get(KEY))!.body).text()) as { revision: number; stores: Array<{ id: string; name: string }> }; }
async function add(id = "one", extra: Record<string, unknown> = {}) {
  return createReportManagementScope(db(), { id: `cyberbiz:store:${id}`, name: id, storeLocatorCategory: "百貨公司", storeLocatorCounty: "高雄市", storeLocatorAddress: "高雄市前鎮區中華五路789號", storeLocatorPinX: 530.9, storeLocatorPinY: 813.2, ...extra });
}
async function mutate(route: string, method: string, body?: object, authenticated = true) {
  return app.fetch(new Request(`https://platform.example.test/api/tools${route}`, { method, headers: { "Content-Type": "application/json", ...(authenticated ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined }), env());
}
beforeEach(async () => {
  d1 = createTargetOnlyD1(); directory = mkdtempSync(path.join(tmpdir(), "locator-cdn-")); bucket = createLocalR2(directory);
  await syncSystemRoles(db());
  await db().insert(users).values({ id: "admin", email: "admin@example.test", displayName: "管理者", status: "active" });
  await db().insert(userRoleAssignments).values({ userId: "admin", roleId: "role-admin" });
  cookie = `${SESSION_COOKIE}=${encodeURIComponent(await signSession(newSessionClaims({ id: "admin", email: "admin@example.test", name: "管理者", pictureUrl: "" }), SECRET))}`;
  purge = vi.fn(async () => Response.json({ success: true })); vi.stubGlobal("fetch", purge);
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); d1.sqlite.close(); rmSync(directory, { recursive: true, force: true }); });

it("API 與快照共用公開投影，不洩漏 Drive／管理欄位", async () => {
  await add("south", { driveFolderUrl: "https://drive.google.com/private", externalName: "內部店名" });
  await add("north", { storeLocatorCounty: "臺北市", storeLocatorPinY: 300 });
  await add("closed", { active: false }); await add("incomplete", { storeLocatorPinY: null });
  await add("online", { scopeKind: "channel" });
  expect((await publish()).pending).toBe(false);
  const data = await snapshot();
  expect(data.stores).toEqual((await buildPublicStoreLocator(db(), (id) => `https://cdn.example.test/images/${id}`)).stores);
  expect(data.stores.map(s => s.name)).toEqual(["north", "south"]);
  expect(JSON.stringify(data)).not.toMatch(/driveFolder|externalName|objectKey|private-token/);
  const response = await publicRequest({ headers: { Origin: "https://www.rueisiang.com" } });
  expect(response.status).toBe(200); expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
  expect(await response.json()).toEqual(data);
});

it("新增、編輯、停業、還原、封存、解除封存與資料不完整都重建整份清單", async () => {
  const created = await mutate("/scopes", "POST", { name: "新櫃點", storeLocatorCategory: "百貨公司", storeLocatorCounty: "高雄市", storeLocatorAddress: "測試地址", storeLocatorPinX: 530.9, storeLocatorPinY: 813.2 });
  expect(created.status).toBe(201);
  const body = await created.json() as { scope: { id: string }; publication: { pending: boolean } };
  expect(body.publication.pending).toBe(false);
  const route = `/scopes/${encodeURIComponent(body.scope.id)}`;
  expect((await snapshot()).stores).toHaveLength(1);
  for (const [change, count] of [[{ name: "新名稱" }, 1], [{ active: false }, 0], [{ active: true }, 1], [{ storeLocatorAddress: "" }, 0], [{ storeLocatorAddress: "新地址" }, 1]] as const) {
    expect((await mutate(route, "PATCH", change)).status).toBe(200); expect((await snapshot()).stores).toHaveLength(count);
  }
  expect((await mutate(`${route}/archive`, "POST")).status).toBe(200); expect((await snapshot()).stores).toHaveLength(0);
  expect((await mutate(route, "PATCH", { active: true })).status).toBe(200); expect((await snapshot()).stores[0]?.name).toBe("新名稱");
});

it("R2 寫入失敗保留最後快照，重開狀態仍可重試最新完整資料", async () => {
  const scope = await add(); await publish(); const original = await snapshot();
  await updateReportManagementScope(db(), { id: scope.id, name: "更名" });
  vi.spyOn(bucket, "put").mockRejectedValueOnce(new Error("private-token should not leak"));
  const failed = await publish(); expect(failed.pending).toBe(true); expect(failed.error).toContain("重試"); expect(failed.error).not.toContain("private-token");
  expect(await snapshot()).toEqual(original); expect((await getStoreLocatorPublication(db())).pending).toBe(true);
  await add("later"); await maintainStoreLocatorCdn(env());
  expect((await snapshot()).stores.map(s => s.name)).toContain("更名"); expect((await snapshot()).stores).toHaveLength(2);
  expect((await getStoreLocatorPublication(db())).pending).toBe(false);
});

it("purge 失敗仍保留待發布，排程重試後才標記成功", async () => {
  await add(); purge.mockResolvedValueOnce(Response.json({ success: false }, { status: 429 }));
  expect((await publish()).pending).toBe(true); expect((await snapshot()).stores).toHaveLength(1);
  await maintainStoreLocatorCdn(env()); expect((await getStoreLocatorPublication(db())).pending).toBe(false);
  expect(purge).toHaveBeenCalledWith(expect.stringContaining("purge_cache"), expect.objectContaining({ body: JSON.stringify({ tags: ["store-locator"] }) }));
});

it("較慢的舊發布不能覆蓋後來的新版快照或清除新版待發布狀態", async () => {
  const scope = await add(); await publish(); await updateReportManagementScope(db(), { id: scope.id, name: "舊請求" });
  let entered!: () => void, release!: () => void;
  const waiting = new Promise<void>(r => entered = r), gate = new Promise<void>(r => release = r);
  const originalPut = bucket.put.bind(bucket);
  vi.spyOn(bucket, "put").mockImplementationOnce(async (...args) => { entered(); await gate; return originalPut(...args); });
  const old = publish(); await waiting;
  await updateReportManagementScope(db(), { id: scope.id, name: "最新名稱" });
  const current = await publish(); release(); await old;
  expect((await snapshot()).revision).toBe(current.revision); expect((await snapshot()).stores[0]?.name).toBe("最新名稱");
  await updateReportManagementScope(db(), { id: scope.id, name: "再次更新" });
  await settleStoreLocatorPublication(db(), current.revision, null);
  expect((await getStoreLocatorPublication(db())).pending).toBe(true);
});

it("條件式 put 衝突會重新讀取 D1；連續衝突保持待重試而非假成功", async () => {
  await add(); const put = vi.spyOn(bucket, "put").mockResolvedValueOnce(null);
  expect((await publish()).pending).toBe(false); expect(put).toHaveBeenCalledTimes(2);
  await add("second"); put.mockResolvedValueOnce(null).mockResolvedValueOnce(null).mockResolvedValueOnce(null);
  expect((await publish()).pending).toBe(true); expect((await snapshot()).stores).toHaveLength(1);
  expect((await publish()).pending).toBe(false); expect((await snapshot()).stores).toHaveLength(2);
});

it("D1／管理 API 不可用時 CDN 仍能從 R2 或快取讀取", async () => {
  await add(); await publish();
  const prepare = vi.spyOn(d1, "prepare").mockImplementation(() => { throw new Error("D1 unavailable"); });
  expect((await publicRequest()).status).toBe(200); expect(prepare).not.toHaveBeenCalled();
  let stored: Response | undefined;
  const cache = { match: vi.fn(async () => stored?.clone()), put: vi.fn(async (_key: Request, response: Response) => { stored = response.clone(); }) } as unknown as Cache;
  const first = await serveStoreLocatorCdn(new Request(CDN), env(), cache); expect(first.status).toBe(200);
  expect(stored?.headers.get("Cache-Tag")).toBe("store-locator"); expect(first.headers.has("Cache-Tag")).toBe(false);
  expect(first.headers.get("Cache-Control")).toBe("public, max-age=60");
  const get = vi.spyOn(bucket, "get").mockRejectedValue(new Error("R2 unavailable"));
  expect((await serveStoreLocatorCdn(new Request(`${CDN}?v=1`), env(), cache)).status).toBe(200); expect(get).not.toHaveBeenCalled();
  expect((cache.match as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0].url).toBe(CDN);
});

it("ETag、HEAD、OPTIONS 與錯誤回應不需要登入，且不快取未發布錯誤", async () => {
  const missing = await publicRequest(); expect(missing.status).toBe(503); expect(missing.headers.get("Cache-Control")).toBe("no-store");
  await add(); await publish(); const first = await publicRequest();
  const etag = first.headers.get("ETag")!; expect(etag).toBeTruthy(); expect(first.headers.has("Set-Cookie")).toBe(false);
  expect((await publicRequest({ headers: { "If-None-Match": `W/${etag}` } })).status).toBe(304);
  expect((await publicRequest({ method: "HEAD" })).body).toBeNull(); expect((await publicRequest({ method: "OPTIONS" })).status).toBe(204);
  expect((await publicRequest({ method: "POST" })).status).toBe(405);
  expect((await app.fetch(new Request("https://cdn.example.test/api/tools/scopes"), env())).status).toBe(404);
  expect((await app.fetch(new Request("https://cdn.example.test/public/store-locator/stores.json"), env())).status).toBe(404);
});

it("儲存後發布失敗仍回成功與 pending，手動重試需後端授權", async () => {
  const scope = await add(); await publish(); vi.spyOn(bucket, "put").mockRejectedValueOnce(new Error("unavailable"));
  const response = await mutate(`/scopes/${encodeURIComponent(scope.id)}`, "PATCH", { name: "已儲存" });
  expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ scope: { name: "已儲存" }, publication: { pending: true } });
  expect((await mutate("/scopes/store-locator/publish", "POST", undefined, false)).status).toBe(401);
  d1.sqlite.prepare("DELETE FROM user_role_assignments WHERE user_id='admin'").run();
  expect((await mutate("/scopes/store-locator/publish", "POST")).status).toBe(403);
  await db().insert(userRoleAssignments).values({ userId: "admin", roleId: "role-admin" });
  const retry = await mutate("/scopes/store-locator/publish", "POST"); expect(retry.status).toBe(200); expect(await retry.json()).toMatchObject({ publication: { pending: false } });
  expect((await snapshot()).stores[0]?.name).toBe("已儲存");
});

it("無效輸入不發布，據點與重試狀態的 batch 任一失敗整批回滾", async () => {
  const scope = await add(); const put = vi.spyOn(bucket, "put");
  expect((await mutate(`/scopes/${encodeURIComponent(scope.id)}`, "PATCH", { storeLocatorPinX: 999 })).status).toBe(400); expect(put).not.toHaveBeenCalled();
  d1.sqlite.exec("CREATE TRIGGER reject_publication BEFORE UPDATE ON store_locator_publication BEGIN SELECT RAISE(ABORT, 'test rollback'); END;");
  await expect(updateReportManagementScope(db(), { id: scope.id, name: "不可部分儲存", storeLocatorAddress: "不可部分更新" })).rejects.toThrow();
  expect((await buildPublicStoreLocator(db(), () => "")).stores[0]).toMatchObject({ name: "one", address: "高雄市前鎮區中華五路789號" });
});

it("背景匯入修改既有據點也會留下待發布，排程不會漏掉停業", async () => {
  const scope = await add(); await publish();
  await upsertReportScope(db(), { id: scope.id, name: scope.name, sourceType: scope.sourceType, scopeKind: "store", active: false });
  expect((await getStoreLocatorPublication(db())).pending).toBe(true);
  await maintainStoreLocatorCdn(env()); expect((await snapshot()).stores).toEqual([]);
});

it("R2 與快取服務故障回可重試錯誤，不把錯誤快取或假裝空清單成功", async () => {
  const cache = { match: vi.fn().mockRejectedValue(new Error("cache unavailable")), put: vi.fn() } as unknown as Cache;
  vi.spyOn(bucket, "get").mockRejectedValue(new Error("R2 unavailable private-token"));
  const response = await serveStoreLocatorCdn(new Request(CDN), env(), cache);
  expect(response.status).toBe(503); expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(await response.text()).not.toContain("private-token"); expect(cache.put).not.toHaveBeenCalled();
});

it("首次排程會發布既有資料；沒有 CDN 設定不能誤報已發布", async () => {
  await add(); d1.sqlite.prepare("DELETE FROM store_locator_publication").run();
  await maintainStoreLocatorCdn(env()); expect((await snapshot()).stores).toHaveLength(1);
  await archiveReportManagementScope(db(), "cyberbiz:store:one");
  const incompleteEnv = { ...env(), MEDIA: undefined };
  expect((await publishStoreLocatorCdn(incompleteEnv, db())).pending).toBe(true); expect((await snapshot()).stores).toHaveLength(1);
});

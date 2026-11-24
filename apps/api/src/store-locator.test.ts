import { createDatabase, createReportManagementScope } from "@rueisiang/db";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppEnv } from "./env.js";
import { createLocalD1, type LocalD1 } from "./local-d1/d1.js";
import { storeLocator } from "./routes/store-locator.js";

let d1: LocalD1;
const db = () => createDatabase(d1 as never);
const app = new Hono<AppEnv>();
app.use("*", async (c, next) => { c.set("db", db()); await next(); });
app.route("/api/public/store-locator", storeLocator);

beforeEach(() => {
  d1 = createLocalD1(":memory:", { targetOnly: true });
});
afterEach(() => { vi.restoreAllMocks(); d1.sqlite.close(); });

async function addScope(input: {
  id: string; name: string; scopeKind?: "store" | "channel" | "company"; active?: boolean;
  county?: string; pinX?: number | null; pinY?: number | null; address?: string; imageUrl?: string;
}) {
  return createReportManagementScope(db(), {
    id: input.id,
    name: input.name,
    scopeKind: input.scopeKind ?? "store",
    active: input.active,
    storeLocatorCategory: "百貨公司",
    storeLocatorCounty: input.county ?? "臺北市",
    storeLocatorLabel: "過時自訂標題",
    storeLocatorShortName: "過時短名稱",
    storeLocatorImageUrl: input.imageUrl ?? "",
    storeLocatorAddress: input.address ?? "臺北市中正區測試路 1 號",
    storeLocatorPinX: input.pinX === undefined ? 750 : input.pinX,
    storeLocatorPinY: input.pinY === undefined ? 300 : input.pinY,
  });
}

describe("公開據點列表 API", () => {
  it("即時 API 查詢失敗不回傳成功快取標頭", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(d1, "prepare").mockImplementation(() => { throw new Error("D1 unavailable"); });
    const response = await app.request("https://platform.rueisiang.com/api/public/store-locator");
    expect(response.status).toBe(500);
    expect(response.headers.get("Cache-Control") ?? "").not.toContain("max-age=60");
  });

  it("只公開營業中的櫃點且地址與地圖座標完整，並依地圖 Y 由北到南排序", async () => {
    await addScope({ id: "cyberbiz:store:south", name: "南部店", county: "高雄市", pinY: 780 });
    await addScope({ id: "cyberbiz:store:north", name: "北部店", pinY: 290, imageUrl: "https://images.example.com/north.jpg" });
    await addScope({ id: "cyberbiz:store:closed", name: "停業店", active: false });
    await addScope({ id: "cyberbiz:channel:online", name: "官網", scopeKind: "channel" });
    await addScope({ id: "cyberbiz:store:no-pin", name: "未完成位置", pinY: null });

    const response = await app.request("https://platform.rueisiang.com/api/public/store-locator", {}, { MEDIA_CDN_URL: "https://cdn.rueisiang.com" } as AppEnv["Bindings"]);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toContain("max-age=60");
    const body = await response.json() as { stores: Array<{ id: string; name: string; label: string; shortName: string; image: string; mapUrl: string }> };
    expect(body.stores.map((store) => store.id)).toEqual(["cyberbiz:store:north", "cyberbiz:store:south"]);
    expect(body.stores[0]).toMatchObject({ label: "臺北市｜北部店", shortName: "北部店", image: "https://images.example.com/north.jpg" });
    expect(body.stores[0]?.mapUrl).toContain(encodeURIComponent("臺北市中正區測試路 1 號"));
  });
});

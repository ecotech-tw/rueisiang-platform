// @vitest-environment jsdom
import { QueryClient, QueryClientProvider, notifyManager } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Scopes } from "./Scopes.js";
import type { GoogleMapPlace, ManagementScope } from "./api.js";
import type { StoreLocatorPublicationStatus } from "@rueisiang/db/store-locator-publication-fields";

vi.mock("../../auth/session.js", () => ({ useSession: () => ({ permissions: new Set(["reports:cyberbiz:write"]) }) }));
const toastShow = vi.hoisted(() => vi.fn());
vi.mock("../../shell/Toast.js", () => ({ useToast: () => ({ show: toastShow }) }));
vi.mock("../../shell/usePageTitle.js", () => ({ usePageTitle: vi.fn() }));

const scope: ManagementScope = {
  id: "cyberbiz:store:test", name: "測試櫃點", externalName: "", sourceType: "cyberbiz", scopeKind: "store",
  driveFolderUrl: "", driveFolderName: "", active: true, archivedAt: null,
  storeLocatorCategory: "百貨公司", storeLocatorLabel: "", storeLocatorShortName: "", storeLocatorCounty: "高雄市",
  storeLocatorAddress: "高雄市前鎮區舊地址", storeLocatorFloorNote: "", storeLocatorHours: "", storeLocatorPhone: "",
  storeLocatorHighlight: "", storeLocatorImageId: null, storeLocatorImageUrl: "", storeLocatorMapUrl: "",
  storeLocatorPinX: 600, storeLocatorPinY: 800,
};
const place: GoogleMapPlace = { id: "place-1", name: "環球購物中心 新北中和", address: "235新北市中和區中山路三段122號", latitude: 25.007169, longitude: 121.474806 };
let places: GoogleMapPlace[];
let publication: StoreLocatorPublicationStatus;
let publishGate: Promise<void> | undefined;
let publishFailure: boolean;
let savePublishFailure: boolean;
let savePublicationUnknown: boolean;
let publishCount: number;
let writes: Record<string, unknown>[];
let client: QueryClient;
let root: Root;
let container: HTMLDivElement;

const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find((element) => element.textContent?.trim() === label)!;
const field = (label: string) => [...document.querySelectorAll<HTMLElement>('[role="dialog"] [data-field]')].find((element) => element.querySelector(":scope > span")?.textContent?.startsWith(label))!;
const input = (label: string) => field(label).querySelector<HTMLInputElement>("input")!;
async function click(element: HTMLElement) { await act(async () => { element.click(); }); }
async function change(label: string, value: string) {
  await act(async () => {
    const element = input(label);
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function renderPage() {
  await act(async () => root.render(<MemoryRouter><QueryClientProvider client={client}><Scopes /></QueryClientProvider></MemoryRouter>));
}
async function openDialog() {
  await renderPage();
  await click(document.querySelector<HTMLElement>('[aria-label="編輯 測試櫃點"]')!);
}
async function selectFirstPlace() {
  await change("Google Maps 搜尋地點", "搜尋門市");
  await click(button("搜尋"));
  await click(document.querySelector<HTMLElement>('[aria-label="Google Maps 搜尋結果"] [role="option"]')!);
}

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  notifyManager.setScheduler(queueMicrotask);
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
  places = [{ ...place }]; writes = [];
  publication = { revision: 1, publishedRevision: 1, publishedAt: "2026-11-24T00:00:00Z", error: null, pending: false };
  publishGate = undefined; publishFailure = false; savePublishFailure = false; savePublicationUnknown = false; publishCount = 0;
  toastShow.mockClear();
  client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } } });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  vi.stubGlobal("fetch", async (url: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "PATCH") {
      writes.push(JSON.parse(String(init.body)));
      if (savePublicationUnknown) return Response.json({ scope, publication: { revision: null, publishedRevision: null, publishedAt: null, pending: true, error: "通路資料已儲存，但官網發布狀態暫時無法確認。" } });
      if (savePublishFailure) publication = { ...publication, revision: 2, pending: true, error: "官網據點發布待重試；資料已儲存。" };
      return Response.json({ scope, publication });
    }
    if (String(url) === "/api/tools/scopes/store-locator/publish") {
      publishCount++; await publishGate;
      if (publishFailure) return Response.json({ error: "發布服務暫時無法回應" }, { status: 503 });
      publication = { ...publication, publishedRevision: publication.revision, pending: false, error: null };
      return Response.json({ publication });
    }
    if (String(url).startsWith("/api/tools/scopes/places?")) return Response.json({ places });
    if (String(url) === "/api/tools/scopes") return Response.json({ scopes: [scope], publication });
    throw new Error(`未預期的請求：${String(url)}`);
  });
});
afterEach(async () => {
  await act(async () => root.unmount()); client.clear(); container.remove();
  vi.unstubAllGlobals(); notifyManager.setScheduler((callback) => setTimeout(callback, 0));
});

it.each([
  ["235新北市中和區中山路三段122號", "新北市"],
  ["235001 新北市中和區中山路三段122號", "新北市"],
  ["台灣 100 台北市中正區測試路1號", "臺北市"],
  ["中華民國 403台中市西區測試路1號", "臺中市"],
  ["臺南市中西區測試路1號", "臺南市"],
])("選取地址 %s 自動帶入縣市與 X/Y，僅在儲存時送出", async (address, county) => {
  places = [{ ...place, address }];
  await openDialog(); await selectFirstPlace();
  expect(input("地址").value).toBe(address);
  expect(field("縣市").querySelector("button")?.textContent).toContain(county);
  expect(input("台灣地圖 X").value).toBe("752.5");
  expect(input("台灣地圖 Y").value).toBe("313.5");
  expect(document.body.textContent).toContain("X/Y 換算結果：X 752.5 · Y 313.5（已自動帶入）");
  expect(document.body.textContent).not.toContain("帶入 X/Y 欄位");
  expect(writes).toHaveLength(0);
  await click(button("儲存"));
  expect(writes).toHaveLength(1);
  expect(writes[0]).toMatchObject({ storeLocatorAddress: address, storeLocatorCounty: county, storeLocatorPinX: 752.5, storeLocatorPinY: 313.5 });
  expect(writes[0]).not.toHaveProperty("latitude");
  expect(writes[0]).not.toHaveProperty("longitude");
});

it("更換為無法辨識縣市且超出範圍的地點，不沿用前一個地點的資料", async () => {
  await openDialog(); await selectFirstPlace();
  places = [{ ...place, id: "outside", name: "海外門市", address: "海外新北市主題商場", longitude: 139.7, latitude: 35.6 }];
  await selectFirstPlace();
  expect(input("地址").value).toBe("海外新北市主題商場");
  expect(field("縣市").querySelector("button")?.textContent).toContain("請選擇縣市");
  expect(input("台灣地圖 X").value).toBe(""); expect(input("台灣地圖 Y").value).toBe("");
  expect(document.body.textContent).toContain("無法從此地址辨識縣市");
  expect(document.body.textContent).toContain("此座標超出台灣圖示的試算範圍");
  await click(button("儲存"));
  expect(writes[0]).toMatchObject({ storeLocatorCounty: "", storeLocatorPinX: null, storeLocatorPinY: null });
});

it("自動帶入後仍可微調，清除座標顯示不會重設已填欄位", async () => {
  await openDialog(); await selectFirstPlace();
  await change("台灣地圖 X", "732.5"); await change("台灣地圖 Y", "307.2");
  await click(button("清除座標顯示"));
  expect(input("地址").value).toBe(place.address);
  expect(input("台灣地圖 X").value).toBe("732.5"); expect(input("台灣地圖 Y").value).toBe("307.2");
  await click(button("儲存"));
  expect(writes[0]).toMatchObject({ storeLocatorCounty: "新北市", storeLocatorPinX: 732.5, storeLocatorPinY: 307.2 });
});

it("重開頁面仍顯示待發布，重試期間不能重複按，成功後清除警告", async () => {
  publication.pending = true; publication.error = "官網據點發布待重試";
  let release!: () => void; publishGate = new Promise<void>(r => release = r);
  await renderPage(); expect(document.body.textContent).toContain("CDN 仍可能顯示上一版資料");
  const retry = button("重試發布據點");
  await click(retry);
  expect(retry.disabled).toBe(true); expect(publishCount).toBe(1);
  await act(async () => { release(); });
  expect(document.body.textContent).not.toContain("CDN 仍可能顯示上一版資料");
});

it("重試失敗顯示持續錯誤與可重試按鈕，不誤報已同步", async () => {
  publication.pending = true; publishFailure = true;
  await renderPage(); await click(button("重試發布據點"));
  expect(document.body.textContent).toContain("發布服務暫時無法回應");
  expect(document.body.textContent).toContain("CDN 仍可能顯示上一版資料");
  expect(button("重試發布據點").disabled).toBe(false);
});

it("通路儲存成功但 CDN 發布失敗，關閉表單後仍顯示待重試", async () => {
  savePublishFailure = true;
  await openDialog(); await click(button("儲存"));
  expect(writes).toHaveLength(1); expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(document.body.textContent).toContain("官網據點發布待重試；資料已儲存");
  expect(button("重試發布據點")).toBeTruthy();
});

it("已儲存但無法確認發布狀態時關閉表單，不能誤報儲存失敗或官網已發布", async () => {
  savePublicationUnknown = true;
  await openDialog(); await click(button("儲存"));
  expect(writes).toHaveLength(1); expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(toastShow).toHaveBeenCalledWith("通路資料已儲存，官網發布狀態待確認。");
  expect(toastShow).not.toHaveBeenCalledWith(expect.stringContaining("官網據點已發布"));
});

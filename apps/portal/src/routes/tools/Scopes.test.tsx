// @vitest-environment jsdom
import { QueryClient, QueryClientProvider, notifyManager } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Scopes } from "./Scopes.js";
import type { GoogleMapPlace, ManagementScope } from "./api.js";

vi.mock("../../auth/session.js", () => ({ useSession: () => ({ permissions: new Set(["reports:cyberbiz:write"]) }) }));
vi.mock("../../shell/Toast.js", () => ({ useToast: () => ({ show: vi.fn() }) }));
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
async function openDialog() {
  await act(async () => root.render(<MemoryRouter><QueryClientProvider client={client}><Scopes /></QueryClientProvider></MemoryRouter>));
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
  client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } } });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  vi.stubGlobal("fetch", async (url: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "PATCH") {
      writes.push(JSON.parse(String(init.body)));
      return Response.json({ scope });
    }
    if (String(url).startsWith("/api/tools/scopes/places?")) return Response.json({ places });
    if (String(url) === "/api/tools/scopes") return Response.json({ scopes: [scope] });
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
  expect(input("台灣地圖 X").value).toBe("731.3");
  expect(input("台灣地圖 Y").value).toBe("306.6");
  expect(document.body.textContent).toContain("X/Y 換算結果：X 731.3 · Y 306.6（已自動帶入）");
  expect(document.body.textContent).not.toContain("帶入 X/Y 欄位");
  expect(writes).toHaveLength(0);
  await click(button("儲存"));
  expect(writes).toHaveLength(1);
  expect(writes[0]).toMatchObject({ storeLocatorAddress: address, storeLocatorCounty: county, storeLocatorPinX: 731.3, storeLocatorPinY: 306.6 });
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

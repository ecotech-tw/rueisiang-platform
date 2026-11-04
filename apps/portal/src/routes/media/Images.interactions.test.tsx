// @vitest-environment jsdom
import { QueryClient, QueryClientProvider, notifyManager } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MediaImages } from "./Images.js";
import type { MediaImage, MediaImagePage } from "./api.js";

vi.mock("../../auth/session.js", () => ({ useSession: () => ({ permissions: new Set(["media:image:read", "media:image:write", "media:image:delete"]) }) }));
vi.mock("../../shell/Toast.js", () => ({ useToast: () => ({ show: vi.fn() }) }));
vi.mock("../../shell/usePageTitle.js", () => ({ usePageTitle: vi.fn() }));

const original: MediaImage = { id: "image-1", name: "原始圖片", filename: "banner.png", contentType: "image/png", size: 1000, width: 1200, height: 600, revision: 1, purgePending: false, purgeError: null, deletedAt: null, createdBy: "admin", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", url: "https://cdn.example.test/images/image-1", previewUrl: "/api/media/images/image-1/preview" };
let images: MediaImage[];
let writes: { name: string; revision: number }[];
let client: QueryClient;
let root: Root | undefined;
let container: HTMLDivElement;
let pageOneGate: Promise<void> | undefined;
let releasePageOne: (() => void) | undefined;
let pageOneRequested: boolean;
const pageData = (page: number): MediaImagePage => ({ images: images.slice((page - 1) * 24, page * 24), total: images.length, page, pageSize: 24, configured: true, local: true, cdnOrigin: "http://localhost:8787" });
const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find((element) => element.textContent?.trim() === label)!;
const nameInput = () => document.querySelector<HTMLInputElement>('[role="dialog"] input')!;
async function click(element: HTMLElement) { await act(async () => { element.click(); }); }
async function changeName(value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(nameInput(), value);
    nameInput().dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function renderPage() {
  root = createRoot(container);
  await act(async () => root!.render(<MemoryRouter><QueryClientProvider client={client}><MediaImages /></QueryClientProvider></MemoryRouter>));
}
async function publishLatest(image: MediaImage) {
  images = [image];
  await act(async () => { client.setQueriesData<MediaImagePage>({ queryKey: ["media", "images"] }, () => pageData(1)); });
}

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  notifyManager.setScheduler(queueMicrotask);
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
  localStorage.clear();
  images = [{ ...original }]; writes = []; pageOneGate = undefined; releasePageOne = undefined; pageOneRequested = false;
  client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } } });
  container = document.createElement("div"); document.body.append(container);
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    if (init?.method === "PATCH") {
      const data = JSON.parse(String(init.body)) as { name: string; revision: number }; writes.push(data);
      const image = images.find((image) => url.pathname.endsWith(`/${image.id}`))!;
      if (data.revision !== image.revision) return Response.json({ error: "圖片已被更新，請重新整理後再操作。" }, { status: 409 });
      images = images.map((row) => row.id === image.id ? { ...row, name: data.name, revision: row.revision + 1 } : row);
      return Response.json({ image: images.find((row) => row.id === image.id) });
    }
    if (init?.method === "DELETE") {
      const image = images.find((image) => url.pathname.endsWith(`/${image.id}`))!;
      images = images.filter((row) => row.id !== image.id);
      return Response.json({ image: { ...image, deletedAt: new Date().toISOString(), revision: image.revision + 1 } });
    }
    const page = Number(url.searchParams.get("page") ?? 1);
    if (page === 1 && pageOneGate) { pageOneRequested = true; await pageOneGate; }
    return Response.json(pageData(page));
  });
});
afterEach(async () => {
  if (root) await act(async () => { releasePageOne?.(); root!.unmount(); });
  root = undefined; client.clear(); container.remove();
  vi.unstubAllGlobals(); notifyManager.setScheduler((callback) => setTimeout(callback, 0));
});

describe("媒體草稿與分頁回歸", () => {
  it.each([false, true])("refetch 不讓舊名稱冒用新 revision，保留草稿直到明確重載（有修改：%s）", async (dirty) => {
    await renderPage(); await click(container.querySelector<HTMLElement>('[aria-label="檢視 原始圖片"]')!);
    if (dirty) await changeName("尚未儲存的草稿");
    await publishLatest({ ...original, name: "其他同仁的新名稱", revision: 2 });
    expect(nameInput().value).toBe(dirty ? "尚未儲存的草稿" : original.name);
    expect(document.body.textContent).toContain("圖片已被更新"); expect(button("儲存名稱").disabled).toBe(true);
    await click(button("儲存名稱")); expect(writes).toHaveLength(0);
    await click(button("載入最新名稱")); expect(nameInput().value).toBe("其他同仁的新名稱"); expect(button("儲存名稱").disabled).toBe(true);
    await changeName("重新編輯的名稱"); await click(button("儲存名稱"));
    expect(writes).toEqual([{ name: "重新編輯的名稱", revision: 2 }]);
    expect(nameInput().value).toBe("重新編輯的名稱"); expect(button("儲存名稱").disabled).toBe(true);
    await changeName("下一次修改"); await click(button("儲存名稱"));
    expect(writes[1]).toEqual({ name: "下一次修改", revision: 3 });
  });

  it("送出前伺服器已更新但畫面尚未 refetch，仍送出草稿原版本並保留 409 草稿", async () => {
    await renderPage(); await click(container.querySelector<HTMLElement>('[aria-label="檢視 原始圖片"]')!);
    await changeName("我的草稿"); images = [{ ...original, name: "其他同仁的新名稱", revision: 2 }];
    await click(button("儲存名稱"));
    expect(writes).toEqual([{ name: "我的草稿", revision: 1 }]); expect(images[0]?.name).toBe("其他同仁的新名稱");
    expect(nameInput().value).toBe("我的草稿"); expect(document.body.textContent).toContain("請重新整理後再操作");
  });

  it.each(["delete", "refetch"] as const)("末頁只剩一張時 %s，回到有效上一頁，不顯示空庫", async (operation) => {
    images = Array.from({ length: 25 }, (_, index) => ({ ...original, id: `image-${index + 1}`, name: `圖片 ${index + 1}` }));
    await renderPage(); await click(button("下一頁")); expect(container.textContent).toContain("第 2 頁");
    client.removeQueries({ queryKey: ["media", "images", { page: 1 }] });
    pageOneGate = new Promise<void>((resolve) => { releasePageOne = resolve; });
    if (operation === "delete") {
      await click(container.querySelector<HTMLElement>('[aria-label="檢視 圖片 25"]')!); await click(button("刪除"));
      await click(document.querySelector<HTMLElement>('[role="alertdialog"] input[type="checkbox"]')!); await click(button("永久刪除圖片"));
    } else {
      images = images.slice(0, 24);
      await act(async () => { await client.invalidateQueries({ queryKey: ["media", "images"] }); });
    }
    await vi.waitFor(async () => { await act(async () => { await Promise.resolve(); }); expect(pageOneRequested).toBe(true); });
    expect(container.textContent).not.toContain("還沒有圖片"); expect(container.textContent).toContain("載入圖片中");
    releasePageOne!();
    await vi.waitFor(async () => {
      await act(async () => { await Promise.resolve(); });
      expect(container.textContent).toContain("共 24 張圖片 · 第 1 頁");
    });
    expect(container.textContent).not.toContain("還沒有圖片"); expect(container.querySelectorAll("article")).toHaveLength(24);
  });
});

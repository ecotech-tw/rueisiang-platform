// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HrProfileAvatar, HrProfilePhoto } from "./ProfilePhoto.js";
import type { Profile } from "./api.js";

const profile = (photo: Profile["photo"] = null): Profile => ({ photo, employee: { userId: "employee", employeeNumber: "E001", legalName: "測試員工", accountName: "Test", displayName: "Test", email: "employee@example.test", position: "職員", userStatus: "active", employmentStatus: "active", revision: 7 }, employments: [], assignments: [], attendanceAssignments: [] });
const roots: Array<{ root: ReturnType<typeof createRoot>; container: HTMLElement }> = [];
afterEach(async () => {
  for (const { root, container } of roots.splice(0)) { await act(async () => root.unmount()); container.remove(); }
  vi.unstubAllGlobals();
});
function render(node: React.ReactNode) {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container); roots.push({ root, container });
  act(() => root.render(<QueryClientProvider client={client}>{node}</QueryClientProvider>));
  return container;
}
async function click(container: HTMLElement, label: string) {
  const button = [...container.querySelectorAll("button")].find((item) => item.textContent?.includes(label));
  expect(button).toBeDefined();
  await act(async () => { button!.click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
}
function stubImages() {
  vi.stubGlobal("URL", { ...URL, createObjectURL: vi.fn(() => "blob:employee-photo"), revokeObjectURL: vi.fn() });
  vi.stubGlobal("Image", class { naturalWidth = 2; naturalHeight = 2; src = ""; decode() { return Promise.resolve(); } });
}

describe("員工端大頭貼", () => {
  it("顯示本人私有照片並設定跨來源憑證", () => {
    const container = render(<><HrProfileAvatar name="測試員工" photo={{ id: "photo-1" }} /><HrProfileAvatar name="林小姐" photo={null} /></>);
    const images = container.querySelectorAll("img");
    expect(images).toHaveLength(1); expect(images[0]?.getAttribute("src")).toContain("/hr/me/photo?v=photo-1"); expect(images[0]?.crossOrigin).toBe("use-credentials");
    expect(container.textContent).toContain("林");
  });
  it("解碼完成前不能儲存；有效照片以 multipart 上傳且取消釋放預覽", async () => {
    stubImages();
    let resolveDecode!: () => void;
    vi.stubGlobal("Image", class { naturalWidth = 2; naturalHeight = 2; decode() { return new Promise<void>((resolve) => { resolveDecode = resolve; }); } });
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => Response.json({ id: "photo-2" }, { status: init?.method === "POST" ? 201 : 200 })); vi.stubGlobal("fetch", fetchMock);
    const container = render(<HrProfilePhoto profile={profile()} />);
    const input = container.querySelector('input[type="file"]')!;
    const file = new File([new Uint8Array([1, 2, 3])], "portrait.png", { type: "image/png" });
    await act(async () => { Object.defineProperty(input, "files", { configurable: true, value: [file] }); input.dispatchEvent(new Event("change", { bubbles: true })); });
    const save = [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("儲存大頭貼"))!;
    expect(save.disabled).toBe(true); expect(container.querySelector(".hr-self-photo-preview img")?.getAttribute("src")).toBe("blob:employee-photo");
    await act(async () => { resolveDecode(); await Promise.resolve(); });
    expect(save.disabled).toBe(false);
    await click(container, "儲存大頭貼");
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain("/hr/me/photo"); expect(init?.credentials).toBe("include"); expect(init?.body).toBeInstanceOf(FormData); expect((init?.body as FormData).get("revision")).toBe("7");
    expect(container.textContent).toContain("大頭貼已更新");
  });
  it("拒絕 MIME 不符的檔案而不送出請求", async () => {
    stubImages(); const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    const container = render(<HrProfilePhoto profile={profile()} />);
    const input = container.querySelector('input[type="file"]')!;
    const file = new File(["<svg/>"] , "bad.svg", { type: "image/svg+xml" });
    await act(async () => { Object.defineProperty(input, "files", { configurable: true, value: [file] }); input.dispatchEvent(new Event("change", { bubbles: true })); });
    expect(container.textContent).toContain("請選擇 5 MB 以內"); expect(fetchMock).not.toHaveBeenCalled();
  });
});

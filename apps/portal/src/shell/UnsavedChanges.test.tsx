// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it } from "vitest";
import { UnsavedChangesProvider, useConfirmLeave, useUnsavedChanges } from "./UnsavedChanges.js";

let root: Root | null = null;
afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = "";
});

function DirtyPage() {
  useUnsavedChanges(true, "已排入 3 天尚未儲存");
  const confirmLeave = useConfirmLeave();
  return <button type="button" onClick={() => void confirmLeave()}>離開</button>;
}

async function openDialogAt(path: string) {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(<MemoryRouter initialEntries={[path]}><UnsavedChangesProvider><DirtyPage /></UnsavedChangesProvider></MemoryRouter>));
  // 掛上去之後才點：provider 換頁時會收掉還開著的視窗，那個 effect 在第一次掛載也會跑。
  await act(async () => host.querySelector("button")!.click());
  const leave = [...document.querySelectorAll("button")].find((button) => button.textContent === "離開並捨棄");
  expect(leave).toBeTruthy();
  return leave!.className;
}

describe("未儲存變更的確認視窗", () => {
  // 視窗掛在路由外，拿不到 AppShell 的皮膚；全平台統一玻璃之後，每個模組都要跟頁面上的按鈕一樣是玻璃的。
  it.each(["/hr/scheduling", "/crm/customers", "/wms/inventory"])("在 %s 跟頁面上的按鈕一樣是玻璃皮膚", async (path) => {
    expect(await openDialogAt(path)).toContain("backdrop-filter");
  });
});
